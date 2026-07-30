#!/usr/bin/env bash
set -euo pipefail

wait_for_job() {
  local job_name="$1"
  local timeout_seconds="$2"
  local deadline=$((SECONDS + timeout_seconds))

  while ((SECONDS < deadline)); do
    if [[ "$(kubectl -n buzz get job "${job_name}" -o jsonpath='{.status.succeeded}' 2>/dev/null || true)" == '1' ]]; then
      return 0
    fi
    if [[ "$(kubectl -n buzz get job "${job_name}" -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || true)" == 'True' ]]; then
      echo "Job ${job_name} failed." >&2
      kubectl -n buzz logs -l "job-name=${job_name}" --all-containers=true --prefix=true || true
      kubectl -n buzz describe job "${job_name}" || true
      return 1
    fi
    sleep 5
  done

  echo "Job ${job_name} did not complete within ${timeout_seconds} seconds." >&2
  kubectl -n buzz logs -l "job-name=${job_name}" --all-containers=true --prefix=true || true
  kubectl -n buzz describe job "${job_name}" || true
  return 1
}

replace_literal() {
  local path="$1"
  local token="$2"
  local value="$3"
  local content

  content="$(<"${path}")"
  if [[ "${content}" != *"${token}"* ]]; then
    echo "Expected deployment token ${token} is absent from ${path}." >&2
    return 1
  fi
  content="${content//"${token}"/"${value}"}"
  printf '%s\n' "${content}" >"${path}"
}

for file in namespace.yaml secret-provider-class.yaml ingress-values.yaml cert-manager-values.yaml certificates.yaml database-jobs.yaml agent.yaml; do
  if grep -q '__[A-Z0-9_][A-Z0-9_]*__' "$file"; then
    echo "unrendered deployment token in $file" >&2
    exit 1
  fi
done

kubectl apply -f namespace.yaml
kubectl apply -f secret-provider-class.yaml
helm repo add jetstack https://charts.jetstack.io
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm upgrade --install cert-manager jetstack/cert-manager --version v1.21.1 --namespace cert-manager --create-namespace --values cert-manager-values.yaml --atomic --wait --timeout 10m
kubectl apply -f certificates.yaml
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx --version 4.15.1 --namespace ingress-nginx --create-namespace --values ingress-values.yaml --atomic --wait --timeout 10m
kubectl -n buzz delete job buzz-database-bootstrap buzz-database-migrate --ignore-not-found
kubectl apply -f database-jobs.yaml
wait_for_job buzz-database-bootstrap 600
kubectl -n buzz patch job buzz-database-migrate --type=merge --patch '{"spec":{"suspend":false}}'
wait_for_job buzz-database-migrate 600

relay_owner_pubkey="$(kubectl -n buzz get secret buzz-runtime -o jsonpath='{.data.RELAY_OWNER_PUBKEY}' | base64 -d)"
origin_verification_secret="$(kubectl -n buzz get secret buzz-runtime -o jsonpath='{.data.BUZZ_FRONT_DOOR_ORIGIN_SECRET}' | base64 -d)"
if [[ ! "${relay_owner_pubkey}" =~ ^[a-f0-9]{64}$ ]]; then
  echo 'Key Vault relay owner public key is not a 64-character lowercase hexadecimal key.' >&2
  exit 1
fi
if [[ ! "${origin_verification_secret}" =~ ^[A-Za-z0-9_-]{32,128}$ ]]; then
  echo 'Key Vault origin verification secret does not satisfy the header-safe contract.' >&2
  exit 1
fi
replace_literal prod-values.yaml '__RELAY_OWNER_PUBKEY__' "${relay_owner_pubkey}"
replace_literal prod-values.yaml '__ORIGIN_VERIFICATION_SECRET__' "${origin_verification_secret}"
replace_literal health-ingress.yaml '__ORIGIN_VERIFICATION_SECRET__' "${origin_verification_secret}"
unset relay_owner_pubkey origin_verification_secret
for file in prod-values.yaml health-ingress.yaml; do
  if grep -q '__[A-Z0-9_][A-Z0-9_]*__' "$file"; then
    echo "unrendered deployment token in $file" >&2
    exit 1
  fi
done

helm upgrade --install buzz ./chart --namespace buzz --values prod-values.yaml --atomic --wait --timeout 15m
kubectl apply -f health-ingress.yaml
kubectl -n buzz delete job buzz-agent-membership --ignore-not-found
kubectl apply -f agent.yaml
kubectl -n buzz wait --for=condition=complete job/buzz-agent-membership --timeout=5m
kubectl -n buzz rollout status deployment/buzz-kiingo-agent --timeout=10m
kubectl -n buzz wait --for=condition=Ready certificate/buzz-origin --timeout=10m
kubectl -n buzz get deployment,statefulset,pod,job,ingress,certificate

#!/usr/bin/env bash
set -euo pipefail

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
kubectl -n buzz wait --for=condition=complete job/buzz-database-bootstrap --timeout=10m
kubectl -n buzz wait --for=condition=complete job/buzz-database-migrate --timeout=10m

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
RELAY_OWNER_PUBKEY="${relay_owner_pubkey}" \
ORIGIN_VERIFICATION_SECRET="${origin_verification_secret}" \
python3 - <<'PY'
import os
from pathlib import Path

replacements = {
    "__RELAY_OWNER_PUBKEY__": os.environ["RELAY_OWNER_PUBKEY"],
    "__ORIGIN_VERIFICATION_SECRET__": os.environ["ORIGIN_VERIFICATION_SECRET"],
}
for name in ("prod-values.yaml", "health-ingress.yaml"):
    path = Path(name)
    text = path.read_text(encoding="utf-8")
    for token, value in replacements.items():
        text = text.replace(token, value)
    path.write_text(text, encoding="utf-8")
PY
unset relay_owner_pubkey origin_verification_secret RELAY_OWNER_PUBKEY ORIGIN_VERIFICATION_SECRET
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

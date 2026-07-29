#!/usr/bin/env bash
set -euo pipefail

for file in namespace.yaml secret-provider-class.yaml prod-values.yaml ingress-values.yaml cert-manager-values.yaml certificates.yaml health-ingress.yaml database-jobs.yaml agent.yaml; do
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
helm upgrade --install buzz ./chart --namespace buzz --values prod-values.yaml --atomic --wait --timeout 15m
kubectl apply -f health-ingress.yaml
kubectl -n buzz delete job buzz-agent-membership --ignore-not-found
kubectl apply -f agent.yaml
kubectl -n buzz wait --for=condition=complete job/buzz-agent-membership --timeout=5m
kubectl -n buzz rollout status deployment/buzz-kiingo-agent --timeout=10m
kubectl -n buzz wait --for=condition=Ready certificate/buzz-origin --timeout=10m
kubectl -n buzz get deployment,statefulset,pod,job,ingress,certificate

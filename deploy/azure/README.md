# Azure production deployment

This directory is the production-only AKS packaging for the Kiingo Buzz
community. It keeps PostgreSQL and Blob state outside the cluster, uses Azure
workload identity for Blob and Key Vault, and treats in-cluster Redis as
disposable coordination state.

The checked-in YAML contains placeholder tokens. The deployment workflow
renders them into a temporary directory, archives the rendered chart and
manifests, and sends that archive to the private AKS cluster with Azure Run
Command. Rendered files are never committed or uploaded as artifacts.

Deployment order is intentional:

1. create the namespace, workload-identity service account, and Key Vault CSI
   projection;
2. install digest-pinned cert-manager and ingress-nginx charts;
3. create or rotate the least-privilege Buzz database role and run migrations;
4. install the relay and disposable Redis with the local chart;
5. register the local-signing agent identity and start one 12-worker listener;
6. verify Kubernetes readiness before Front Door cutover.

Before the first relay deployment, build
`Dockerfile.storage-conformance`, pin the resulting digest in
`storage-conformance-job.yaml`, and run that Job with the same `buzz-relay`
workload identity. It executes the reviewed adapter contract against the
private `buzz-conformance` container without a storage key. The Job is
disposable and is not part of steady-state production.

`__BUZZ_USER_PUBKEY_ALLOWLIST__` is mandatory and must render to a non-empty,
comma-separated list of approved 64-character Nostr public keys. The same list
is used for relay membership and the ACP author gate. Production permits only
`owner-only` or `allowlist` response modes; `anyone` cannot be selected through
runtime configuration.

The ingress load balancer accepts only the Azure Front Door backend service
tag. NGINX additionally validates the exact Front Door resource ID and a
deployment-specific origin header. The relay sees chat.kiingo.com as the Host
even through the preview domain, preserving Buzz's fail-closed tenant binding.

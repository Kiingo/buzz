# Azure production deployment

This directory is the production-only AKS packaging for the Kiingo Buzz
community. It keeps PostgreSQL and Blob state outside the cluster, uses Azure
workload identity for Blob and Key Vault, and treats in-cluster Redis as
disposable coordination state.

The checked-in YAML contains placeholder tokens. The deployment workflow
renders them into a temporary directory, archives the rendered chart and
manifests, and sends that archive to the private AKS cluster with Azure Run
Command. Rendered files are never committed or uploaded as artifacts.
The relay owner key and Front Door verification secret are deliberately left
unrendered by GitHub: the database bootstrap's CSI mount synchronizes them from
the private Key Vault, then `deploy.sh` validates and renders them only inside
the private command environment.

Before installing the chart, render `secret-provider-class.yaml` with the relay
identity, vault name, and subscription tenant, then run
`key-vault-conformance-job.yaml`. The restricted Job mounts every runtime value
through the production workload identity, verifies all 13 files are non-empty,
and checks only the public owner-key and origin-secret formats. It never prints
secret content. A successful run also proves that the `buzz-runtime` Kubernetes
Secret was synchronized for the deployment bootstrap.

Deployment order is intentional:

1. create the namespace, workload-identity service account, and Key Vault CSI
   projection;
2. install digest-pinned cert-manager and ingress-nginx charts;
3. create or rotate the least-privilege Buzz database role, then unsuspend and
   run migrations only after that bootstrap job succeeds;
4. install the relay and disposable Redis with the local chart;
5. register the local-signing agent identity, bootstrap its organization-owned
   Kiingo communication endpoint, and start one 12-worker listener;
6. verify Kubernetes readiness before Front Door cutover.

Database jobs retain failed pods long enough for `deploy.sh` to print their
non-secret logs and job conditions, and deterministic failures stop the rollout
immediately. The deployment script uses only Bash plus the `kubectl`/`helm`
utilities guaranteed by the minimal Azure Run Command environment; it does not
depend on Python, `gzip`, or other optional tools.

Before the first relay deployment, build
`Dockerfile.storage-conformance`, pin the resulting digest in
`storage-conformance-job.yaml`, and run that Job with the same `buzz-relay`
workload identity. It executes the reviewed adapter contract against the
private `buzz-conformance` container without a storage key. The Job is
disposable and is not part of steady-state production.

After conformance, render and run `storage-recovery-job.yaml` through the same
private-cluster command path. It uses the same workload identity to create two
versions, restore the first version, delete the current logical blob, and
reconstruct it from the retained version. The Azure CLI image must be pinned to
the reviewed platform digest; no storage account key or SAS is used.

`__BUZZ_USER_PUBKEY_ALLOWLIST__` is mandatory and must render to a non-empty,
comma-separated list of approved 64-character Nostr public keys. The same list
is used for relay membership and the ACP author gate. Production permits only
`owner-only` or `allowlist` response modes; `anyone` cannot be selected through
runtime configuration.

The agent listener must not start until the Kiingo API has idempotently
registered the exact `(community_id, agent_public_key)` endpoint. `agent.yaml`
calls the internal-token-only endpoint bootstrap route before `buzz-acp`; the
request is pinned to the rendered production organization and owner IDs and to
the canonical `wss://chat.kiingo.com` relay URL. The bridge token is supplied to
curl over standard input rather than an argument, the response file is private
and removed on success or failure, and only an explicit
`{"registered":true}` response permits listener startup. The API verifies that
the owner is an active member of the active organization, refuses conflicting
agent or endpoint ownership, and repairs only same-scope endpoint state. A
restart therefore returns the same endpoint, agent, and ownership boundary; it
does not create another agent or store a provider credential.

The ingress load balancer accepts only the Azure Front Door backend service
tag. NGINX additionally validates the exact Front Door resource ID and a
deployment-specific origin header. The relay sees chat.kiingo.com as the Host
even through the preview domain, preserving Buzz's fail-closed tenant binding.

# Provider-confirmed deletion

Buzz normally treats a provider deployment as an external resource. Provider
protocol v1 therefore permits local deletion only through the existing explicit
force path, and persona deletion refuses to orphan any deployed provider
instances.

Protocol v2 adds one deliberately narrow exception: a provider may advertise
`capabilities.lifecycle_operations: ["delete"]`. Buzz can then ask that provider
to delete one deployed instance and waits for an exact terminal confirmation
before removing local state. This is a one-shot operation initiated by a user;
it is not a retained provider control channel, lifecycle dashboard, or status
polling API.

## Desktop boundary

The desktop sends only a provider-neutral request:

- `op: "delete"`
- a fresh UUID request ID
- the provider's existing agent ID
- a short-lived Nostr owner proof signed by the active Buzz identity

The kind-27236 proof has content `buzz-provider-delete-v1` and exactly six
two-value tags binding `action`, `provider`, `request`, `agent`, `community`,
and `expires`. The proof carries no provider URL, account, organization,
profile revision, runtime status, or persistence representation.

Provider `info` and deletion both run from the same immutable staged provider
copy. No provider subprocess or network work runs while the managed-agent store
or process lock is held. Success is the exact response
`{"ok":true,"deleted":true,"agent_id":"..."}`; shutdown, offline state,
timeout, malformed output, or a provider error is not confirmation.

After remote confirmation, the desktop reacquires current state and revalidates
the active owner/community plus the complete deletion fingerprint. Direct
deletion checks the record, persona link, provider/configuration, provider agent
ID, and relay. Persona deletion also checks the persona and exact cascade set.
Only a stable snapshot reaches the existing local stop, persistence, key
cleanup, tombstone, and archive commit.

## Compatibility and failure behavior

- Protocol v1 retains its manual/force behavior. It never gains automatic
  deletion by inference.
- Protocol v2 must explicitly advertise `delete`; a version number alone is
  insufficient.
- A protocol-v2 failure cannot be bypassed with the legacy force flag.
- Persona deletion preflights every distinct provider before its first remote
  mutation. One legacy or incapable provider preserves the entire cascade and
  returns the existing manual-workflow guard.
- Remote deletes are sequential. A partial remote success preserves all local
  records, and a retry uses fresh signed requests against provider-side
  idempotency.
- Drift after confirmation preserves local state and returns a retryable
  concurrency error. The provider must safely report an already terminal
  deletion on retry.

Provider-specific endpoints, authorization resolution, orchestration, terminal
wait policy, and identity-destruction rules remain outside Buzz. The desktop
interface intentionally cannot grow into pause, resume, reconcile, generic
status, or arbitrary lifecycle operations without another explicit protocol and
security review.

This seam does not require or modify React behavior, macOS packaging, signing,
updater configuration, or release workflows.

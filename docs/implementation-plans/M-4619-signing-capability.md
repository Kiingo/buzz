# M-4619: replace child key export with a revocable signing capability

This plan and every checkbox bind to the existing full serial Mesh queue drain.
The work is pending. This document is a design review packet, not a delivered
security fix, test pass, or permission to weaken the acceptance criteria.

## Observed boundary

Official `Kiingo/buzz` main was observed and immutably fetched at
`ed4494f98467188577d08ce6a0b7c4de4c5c5f92`. PR267 merged that revision at
2026-10-24T16:53:02Z. Its `off` mode deliberately creates no Git tempdir,
keyfile, helper links, PATH override or Git configuration block. All three
modes still export the agent key to descendants. This is an existing exposure;
no key was printed, retrieved from a running child, or used for a reproduction.

The exact source paths explain why deleting one environment entry is incomplete:

| Boundary | Current dependency | Required change |
| --- | --- | --- |
| `buzz-acp/src/git.rs` | `install` writes `.nostr-key` in agent/user modes; `install` and `off` export `BUZZ_PRIVATE_KEY`; `is_managed_env` forwards it | Export only public identity and a revocable handle; remove secret files and every inherited secret alias from child launch paths |
| `buzz-acp/src/runtime.rs` | `AgentRuntime` owns one `GitEnvironment` until adapter work drains; `PoolStartup.extra_env` clones its environment | Key custody belongs to the trusted runtime, while authorization must have an actual turn lifetime |
| `buzz-acp/src/pool.rs` | `run_prompt` has a real `turn_id`, completion guard, cancellation and liveness cleanup around a warm `OwnedAgent` | Tie authorization and connection closure to these actual terminal paths; a fixed startup token is insufficient |
| `buzz-acp/src/isolated_execution.rs` | Local tasks already spawn and drain a fresh ACP process/session with cancellation and deadlines | Reuse the real lifetime contract where applicable; do not assume that pooled conversations use it |
| `git-sign-nostr/src/lib.rs` | Key loading accepts `NOSTR_PRIVATE_KEY`, `BUZZ_PRIVATE_KEY` or `nostr.keyfile`; signing uses a local keypair | Add capability-backed signing while preserving the existing signed-object format, verification and public-key binding |
| `git-credential-nostr/src/lib.rs` | NIP-98 event signing requires local keys | Produce the same scoped relay authentication using the capability; preserve unrelated-remote credential isolation |
| `buzz-cli/src/lib.rs`, `client.rs` | CLI requires a private key; HTTP auth, event/Blossom signing and WebSocket publication use `nostr::Keys` | Supply a common signing interface to all these consumers; keep direct operator key use separate from harness-managed child launch |
| `buzz-ws-client` | Publication/auth APIs accept local keys | Preserve NIP-42 and event verification with the same signing interface; no dummy key or silent anonymous fallback |

`git.rs`, `runtime.rs`, `isolated_execution.rs` and the complete CLI client at
that official revision match the inspected checkout. The issue was normally
claimed before this investigation. The owned worktree and branch are
`buzz-m4619-signing-capability-01a11782` and
`fix/m4619-signing-capability`. Foreign checkouts remain unchanged.

## Proposed contract

Keep the existing agent key only in a trusted signer outside the adapter/MCP
process tree. Child environment and files carry no private signing key, including
the inherited aliases `NOSTR_PRIVATE_KEY` and `BUZZ_ACP_PRIVATE_KEY`. A public
key and a revocable handle are allowed. The capability confers signing authority
for this agent during one actual turn; it is not an export or keyfile interface.

Use a small shared signer client for the existing Git helpers, CLI and WebSocket
client. It must return only a fixed public identity or verified signatures/signed
events, with bounded framing, request size, concurrency, deadlines and output.
Reject a different requested public key, malformed input, unsupported operation,
expired/revoked authorization and unavailable signer. Preserve the actual Git
signature envelope and NIP-98/NIP-42/Blossom semantics. Never substitute a local
fallback key, cached credential or an anonymous request after a capability error.

The server must verify its own identity binding and the request/response binding;
clients verify the signature against the expected public key and payload. Do not
log capability handles, request bodies, private material or full authentication
headers. A stolen handle remains a signing capability until revoked: avoiding
key export does not establish prevention of all malicious authorized signing.

On Unix, prefer an authenticated local socket with peer credentials and a
trusted turn/process binding. Its filesystem permissions alone do not prove
turn isolation between same-user descendants. Linux runner mode must establish
non-dumpability through an approved safe wrapper before holding the key, fail
closed if it cannot establish that protection, and preserve the separate
`runner_dumpable` repair's ownership. No new `unsafe` code, executable patch,
debugger attachment or manual production key migration is authorized here.

`off` must continue to create no tempdir, keyfile, helper links, PATH override or
Git configuration. A filesystem socket design therefore needs an existing,
verified private runtime directory, or a transport that creates no filesystem
artifact. Linux abstract sockets do not by themselves solve macOS or Windows.
A loopback bearer endpoint also needs an explicit reviewed local-authentication
contract; silently adding one is not the default. The design review must choose
the supported platform transport and failure behavior before that cutover.

## Decision required before a runtime patch can satisfy the stated lifetime

The issue explicitly requires: “the helper is scoped to its agent and turn, and
dies with it” and “79 reviews the design before merge.” A startup-owned signer
with a static token in `PoolStartup.extra_env` fails the first condition even
if its key is non-dumpable. Re-enabling that token for the next warm turn also
revives a previous turn's retained capability. Rotating a file or environment
value without an authenticated delivery boundary does not fix that problem.

The recommended security contract remains strict turn revocation. The review
must identify the trusted per-turn handoff for each supported adapter/native
shell and its MCP descendants, including persistent adapters, or explicitly
authorize changing those adapters to fresh, fully drained turn processes while
preserving conversation history and session behavior. The existing isolated
task path is a concrete starting point, not evidence that all pooled/native
shell paths already meet that contract. Do not change pooling or claim strict
turn isolation without that evidence. Do not reduce acceptance to agent/process
lifetime just because it is simpler.

The exact Mesh handle and owner alias `rosshartmann-79` returned no current
session. A bounded transcript search returned historical mentions, not a verified
current reviewer identity; those sessions must not be treated as the reviewer or
woken. PR267 has no recorded GitHub reviews or inline/issue comments through
the observed endpoints. The outstanding prerequisite is a review by the named
original reviewer and a concrete lifecycle/transport decision on this packet,
not a password, extra capacity, or a deployment/test gate. Keep the implementation
pending and this PR draft while that prerequisite is unresolved.

## Binding delivery and verification checklist

- [x] Admit normally, read the complete issue/thread/readiness and current product,
  testing and repository instructions; preserve original identities and work.
- [x] Qualify official main/PR267 and inventory the actual key-file, child-env,
  Git, CLI, WebSocket, warm-adapter and isolated-task lifetime boundaries.
- [x] Prepare the concrete protocol, threat boundary, platform constraints and
  strict-turn decision packet in an isolated owned worktree.
- [ ] Obtain the named original review and a verified adapter/turn/transport
  contract; record the review and resolve concrete design findings.
- [ ] Implement shared capability-backed signing and all existing consumers,
  with public identity/signature binding and bounded fail-closed operation.
- [ ] Remove private key files/exports and inherited secret aliases from every
  adapter, native shell, MCP and nested child launch path in every identity mode.
- [ ] Implement strict turn revocation, bounded connection/process cleanup on
  completion/cancellation/deadline/failure/shutdown and non-dumpable Linux custody.
- [ ] Preserve agent/user identity behavior, relay Git namespace isolation and
  `off` mode's complete no-Git-state/no-tempdir/no-keyfile contract.
- [ ] Preserve existing test assertions and add regression cases bound to the
  real launch, Git signing/credential, CLI/HTTP/WebSocket and revocation seams.
- [ ] Run affected static formatting/Clippy/compilation with required features,
  normal hooks and resource limits; execute no local/CI/Regular software tests.
- [ ] Deliver through the fork's normal reviewed route and serialized production
  owner; qualify the exact immutable source/artifact and actual affected runtime.
- [ ] Read complete independent post-deployment Azure Spot evidence for the
  applicable original owners and new cases, including real child-env/files,
  signed commits/tags/relay auth, cross-agent/turn denial and runner non-dumpability.
- [ ] Record actual verification, resolve Mesh only with evidence, release all
  claims and remove the clean owned worktree/branch after the full workstream.

No runtime source has been changed. No signing broker, socket, bearer endpoint,
test execution, deployment, key rotation, IAM change or new compute is claimed.
The code fix, exact review, actual deployment, independent tests and final cleanup
remain unchecked and binding under the outer drain. If this issue is waiting,
record that precise prerequisite, release claims and continue other admission.

# Durable Buzz Conversation Reliability — Companion Plan

Status: in progress
Repositories: `buzz-kiingo` and `kiingo-mono`

The authoritative cross-repository checklist is `kiingo-mono/docs/implementation-plans/buzz-durable-conversation-reliability.md`. This companion is carried in the Buzz PR so both reviews remain cross-linked. Checkboxes below cover this repository; they are checked only with concrete evidence recorded here and in the authoritative plan.

## Buzz-owned changes

- [x] Add agent-status events to channel-window auxiliary backfill without reply/unread inflation.
- [x] Merge live agent-status events into the root window and retain in-thread projection.
- [x] Anchor one coalesced current status directly beneath its root.
- [x] Hide nonterminal status after final reply evidence from the same agent while preserving terminal error status.
- [x] Make transient reactions state-driven: queued `👀`, running/retrying `💬`, retry queued `👀`, terminal error `⚠️`, final/cancel clear.
- [x] Ensure generic prompt-exit cleanup cannot erase authoritative durable retry/error state.
- [x] Add focused Rust and desktop tests for closed-thread status, final suppression, terminal errors, no metadata inflation, and reaction cleanup.
- [x] Run narrow resource-bounded checks and record evidence.
- [x] Cross-link the `kiingo-mono` PR and authoritative plan.
- [x] Obtain green relevant CI without adding a CI step.
- [x] Deploy the server and relay via the established production path.
- [ ] Finish the successful owner-key-rotation renderer refresh and its focused regression check so the desktop does not retain a revoked relay session.
- [ ] Publish and install a signed Windows desktop release containing the merged status changes and rotation-refresh follow-up.
- [ ] Verify one bounded live conversation lifecycle, status projection, and indicator cleanup.

## Evidence

- Worktree started from synchronized `origin/main` at `642f924570` on `fix/buzz-durable-conversation-reliability-20260916`; the dirty owner checkout was not modified.
- Relay implementation: kind `39010` status is part of the channel-window auxiliary closure but not a timeline row or unread/reply count. The repeatable-read query suppresses only nonterminal status when a same-signer/root final reply at or after that status exists; error/cancelled status remains visible.
- Desktop implementation: paged and live status enter the root window auxiliary set, remain available to the thread projection, pass through the existing signed actor/channel/root/receipt coalescer, and render immediately below their root. A client-side final-evidence guard mirrors relay suppression.
- Indicator implementation: the per-message generation coordinator serializes and supersedes queued/running/retry/error/final transitions before asynchronous network work can reorder them. Durable receipt/capacity/progress/error/final publication reasserts eyes/speech/warning/clear respectively; explicit prompt exits preserve queued retry or terminal warning, and panic drop reasserts warning rather than generically clearing state.
- Rust verification: targeted relay final-suppression test passed 1/1; targeted ACP tests passed for prompt-exit state mapping, durable publication-kind mapping, pre-network generation supersession, and a local-relay terminal-error→final-success sequence that leaves only warning and then clears all authoritative indicators. Workspace `cargo fmt --all -- --check`, `cargo clippy -p buzz-acp --tests -- -D warnings`, and `cargo clippy -p buzz-relay --tests -- -D warnings` passed.
- Desktop verification: 42/42 focused tests passed across `agentStatus`, `channelWindowResponse`, and `channelWindowStore`. Scoped Biome passed for all changed desktop files, and `pnpm --filter buzz typecheck` passed under a 2 GiB heap cap.
- Fork-boundary verification: the first hosted `Detect Changed Paths` run correctly rejected four unclassified Kiingo deltas. `docs/kiingo-fork-inventory.json` now classifies the companion plan and three channel-window files, raises each footprint budget only to the measured branch value, and passes `node scripts/check-kiingo-fork-boundary.mjs` at 234/234 classified divergent files with zero Kiingo production contamination. The upstream-sync rehearsal suite also passes 7/7.
- Dependency-policy verification: the hosted security lane surfaced RUSTSEC-2026-0285 in the `rustls 0.23.42` lock already present on `origin/main`. The lock now uses patched `rustls 0.23.45` with its compatible `aws-lc-*` and `rustls-webpki` patch releases; the exact `cargo-deny check` policy is green and `cargo check -p buzz-acp -p buzz-relay --locked` passes.
- Git delivery: implementation commit `0362504b4a797ca4c2d42c57097344d1505c702a` was pushed from a clean worktree on current `origin/main`. This companion is [Kiingo/buzz#118](https://github.com/Kiingo/buzz/pull/118); the authoritative plan and recovery implementation are [Kiingo/kiingo#12383](https://github.com/Kiingo/kiingo/pull/12383).
- Hosted CI and merge: PR #118 head `10976bd2deaeb06daf56d7855c94745a4dfdc960` passed all 46 terminal check runs (32 success, 14 skipped) and merged as `1244ab994edfca088667c1f131825cda1a7e7d42`. The merged-main CI, Docker image, Sprig, Helm, and Mesh Lifecycle workflows passed. Two unrelated Dependabot dynamic update attempts failed in their own updater step; they were not PR or release gates.
- Production deployment: [Mono Buzz production run 35145671120](https://github.com/Kiingo/kiingo/actions/runs/35145671120) ran from merged Mono main `be44cf121ff2c67236441f67f410393cbbc785c4` with exact merged Buzz revision `1244ab994edfca088667c1f131825cda1a7e7d42` and the existing one-user verified allowlist. Immutable images, provenance attestations, scans, SBOMs, Azure boundary, private AKS rollout, and public relay readiness all passed. Direct `https://chat.kiingo.com/_readiness` returned `ready`.
- Desktop release gap: the installed signed Windows app was still `0.5.20-kiingo.5` from September 12, before the merged status changes. The existing signed-release workflow was dispatched from Mono main for exact merged Buzz commit `1244ab994edfca088667c1f131825cda1a7e7d42` as [run 35165071982](https://github.com/Kiingo/kiingo/actions/runs/35165071982); its result and installation are not yet claimed. A post-rotation send from the September 13 app process briefly appeared and rolled back to the draft; source inspection found that successful owner rotation acknowledges completion without refreshing the stale relay AUTH socket or identity-scoped renderer. Restart restored a fresh session, and the exact bounded Ada draft was restored without sending. A focused refresh fix is pending review and CI.
- Live conversation behavior remains unverified until a new Ross-signed root message produces a production receipt and bounded status/final/indicator observations.

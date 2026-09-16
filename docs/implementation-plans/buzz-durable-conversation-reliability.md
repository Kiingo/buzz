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
- [ ] Obtain green relevant CI, deploy via the established production path, and verify live behavior.

## Evidence

- Worktree started from synchronized `origin/main` at `642f924570` on `fix/buzz-durable-conversation-reliability-20260916`; the dirty owner checkout was not modified.
- Relay implementation: kind `39010` status is part of the channel-window auxiliary closure but not a timeline row or unread/reply count. The repeatable-read query suppresses only nonterminal status when a same-signer/root final reply at or after that status exists; error/cancelled status remains visible.
- Desktop implementation: paged and live status enter the root window auxiliary set, remain available to the thread projection, pass through the existing signed actor/channel/root/receipt coalescer, and render immediately below their root. A client-side final-evidence guard mirrors relay suppression.
- Indicator implementation: the per-message generation coordinator serializes and supersedes queued/running/retry/error/final transitions before asynchronous network work can reorder them. Durable receipt/capacity/progress/error/final publication reasserts eyes/speech/warning/clear respectively; explicit prompt exits preserve queued retry or terminal warning, and panic drop reasserts warning rather than generically clearing state.
- Rust verification: targeted relay final-suppression test passed 1/1; targeted ACP tests passed for prompt-exit state mapping, durable publication-kind mapping, pre-network generation supersession, and a local-relay terminal-error→final-success sequence that leaves only warning and then clears all authoritative indicators. Workspace `cargo fmt --all -- --check`, `cargo clippy -p buzz-acp --tests -- -D warnings`, and `cargo clippy -p buzz-relay --tests -- -D warnings` passed.
- Desktop verification: 42/42 focused tests passed across `agentStatus`, `channelWindowResponse`, and `channelWindowStore`. Scoped Biome passed for all changed desktop files, and `pnpm --filter buzz typecheck` passed under a 2 GiB heap cap.
- Fork-boundary verification: the first hosted `Detect Changed Paths` run correctly rejected four unclassified Kiingo deltas. `docs/kiingo-fork-inventory.json` now classifies the companion plan and three channel-window files, raises each footprint budget only to the measured branch value, and passes `node scripts/check-kiingo-fork-boundary.mjs` at 234/234 classified divergent files with zero Kiingo production contamination. The upstream-sync rehearsal suite also passes 7/7.
- Git delivery: implementation commit `0362504b4a797ca4c2d42c57097344d1505c702a` was pushed from a clean worktree on current `origin/main`. This companion is [Kiingo/buzz#118](https://github.com/Kiingo/buzz/pull/118); the authoritative plan and recovery implementation are [Kiingo/kiingo#12383](https://github.com/Kiingo/kiingo/pull/12383).

# M-4581 — preserve human removal from a huddle

Goal: an authorized removal must survive audio reconnect and parent-channel
auto-admission. This plan and every checkbox are binding under the existing
serial Mesh queue drain. No nested goal, parallel agent or local/CI test run.

Observed at merged fork source `036a867e1`: audio admission and its transactional
auto-add can reactivate a removed membership, while the desktop ignores the
existing `removed_from_huddle` terminal frame and reconnects. Existing
`channel_members.removed_by` already records the actor, including self-leave;
no schema migration is needed. Use that provenance, not a second ban list.
Explicit authorized re-invitation clears the removal and restores admission.
An old removal with unknown actor fails closed; a proven self-leave can rejoin.
Keep community isolation, NIP-FI denial frames, membership locks, quotas,
archive checks and lifecycle atomicity. Human-removal UI is future work in the
report; this delivers its stated relay and desktop prerequisites.

- [x] Refuse an externally removed or unknown-provenance membership during
      audio admission, including a stale cached positive or open huddle.
- [x] Recheck under the existing membership lock for every join commit;
      preserve explicit re-invitation and voluntary leave/rejoin, and roll back
      before membership or participant lifecycle writes on refusal.
- [x] Treat the relay's terminal removal/ended frame as leave in the owning
      desktop huddle; preserve bounded reconnect for unexpected disconnects
      and fence notifications by the native huddle generation and current
      frontend lifetime, including leave/rejoin of the same channel.
- [x] Add production-seam PostgreSQL coverage for removal/self-leave/reinvite,
      tenant isolation and stale-admission commit refusal, plus terminal client
      frame and desktop disconnect routing regression sources.
- [x] Complete focused formatting, lint/compilation and source review without
      executing software tests on this Mac or in CI; preserve original cases.
- [ ] Deliver the reviewed fork source normally, verify actual relay and desktop
      publication identity, and request/inspect the existing independent Azure
      Spot suites with the actual deployed source and immutable artifact.
- [ ] Reconcile every requirement with observed results, attach structured Mesh
      verification, resolve and release claims, then remove only this worktree
      and feature branch after a qualified merged-source review.

The runtime and Spot publications are separate from source completion. Pending
operations remain under their original handles; no false passes, test gates,
source freezes or new warm capacity.

Source progress, 2026-10-24: the first four items are authored and source
reviewed. The new regression sources comprise three PostgreSQL templates,
four Node templates and one Rust unit template; none has executed. Scoped
relay/database Clippy including test compilation passed. Desktop all-target
Clippy passed both default and mesh-llm configurations. Workspace Rust
formatting, desktop TypeScript, scoped frontend Biome and Node syntax passed.
All 134 original inline Rust test declarations and their complete bodies are
conserved. No software tests ran. Actual publication, Spot outcomes and cleanup
remain unchecked and are not implied by this source progress.

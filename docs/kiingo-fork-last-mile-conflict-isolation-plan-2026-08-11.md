# Kiingo Buzz Last-Mile Fork Conflict-Isolation Plan

Status: implementation ledger (binding)

Date: 2026-08-11

## Goal and completion contract

This plan is the authoritative implementation and evidence ledger for the
last-mile hard cutover that minimizes Kiingo's conflict exposure while keeping
the fork fully compatible with current `block/buzz`. A checkbox may be marked
complete only when the final tree and concrete test, CI, or production evidence
prove the item. The work is not complete until every required checkbox below is
checked, the protected implementation PR is merged, affected production
artifacts are deployed, and the live evaluation ledger is green.

This is a hard cutover. Do not add feature flags, dual paths, fallbacks,
compatibility shims, canaries, or phased rollout machinery. Do not move the
provider-neutral ACP durability work into a Kiingo-only service or sidecar.

## Starting evidence

- [x] Create a clean dedicated worktree and branch without altering the
  pre-existing dirty/conflicted checkout or unrelated user work.
- [x] Fetch both remotes and start from current `origin/main`; verify current
  `upstream/main` is already incorporated.
  - Fork baseline: `811a5ef1cc360b06b3d504398738aaea215958f9`.
  - Upstream baseline: `4b3570671eb2786594267758af18784ac6e82972`.
- [x] Record the observed pre-cutover footprint from the final-tree diff:
  38 divergent paths, 26 modified upstream paths, 15 modified upstream
  production-source paths, 3,980 insertions, 421 deletions, and zero detected
  Kiingo business-logic lines in upstream production source.
- [x] Confirm the remaining largest conflict-sensitive files are the generic
  provider schema UI, desktop provider backend, media storage dispatcher, and
  Git object-store dispatcher; this is an observation from the current diff,
  not a prediction about future upstream edits.
- [x] Record the extracted working-tree footprint: 46 classified divergent
  paths, unchanged budgets of 26 modified upstream paths and 15 modified
  upstream production-source paths, 1,708 conflict-sensitive changed lines,
  168 conflict-sensitive hunks, and zero detected Kiingo production
  contamination. The added-file count intentionally grows while changed lines
  fall from 2,113; hunks move from 171 to 168.

## Architecture constraints

- [x] Preserve all existing upstream provider, agent, media, Git, ACP, huddle,
  project README, and relay behavior while moving downstream implementation
  details behind small provider-neutral composition seams.
- [x] Keep provider capability/configuration derived from the provider runtime
  catalog and JSON schema; do not hardcode Kiingo, Codex, Claude, or provider
  IDs into generic desktop rendering code.
- [x] Keep Azure support provider-neutral, explicitly selected by existing
  runtime configuration, authenticated through the existing Azure credential
  contract, and removable without changing persisted media, Git objects,
  identities, history, or memories.
- [x] Preserve immutable provider staging, bounded process I/O, secret
  redaction, protocol negotiation, user-scoped discovery, and optional
  build-pinned Windows signer enforcement.
- [x] Preserve tenant-scoped media sidecars, bounded reads/streams,
  content-addressed Git objects, create-only writes, CAS pointer semantics,
  conformance admission, and existing S3/MinIO behavior.
- [x] Add no unnecessary smoke tests, canaries, scheduled jobs, or CI stages;
  use the smallest existing focused tests and only add deterministic regression
  coverage required by an extracted seam.

## Provider schema UI extraction

- [x] Move provider JSON-schema option normalization and dependent-field
  visibility into downstream-added, provider-neutral modules with documented
  types and deterministic pure functions.
- [x] Move the generic field renderer and dependent-value reconciliation out of
  `ProviderConfigFields.tsx`, leaving that upstream-owned component as a small,
  stable composition hook around upstream behavior.
- [x] Preserve support for `enum`, `oneOf`, booleans, labels, read-only values,
  `x-visible-when`, `x-options-by-field`, `x-options-by-fields`,
  `x-option-filter`, and `x-hide-when-no-options`.
- [x] Preserve schema-declared scalar coercion and reset invalid dependent
  values to a valid schema default or empty value.
- [x] Move/extend focused tests so the extracted pure schema behavior is
  covered without duplicating the implementation in test fixtures.
- [x] Reconcile `desktop/src/features/agents/AGENTS.md`; update it only if the
  canonical configuration/rendering rules change, otherwise record that the
  extraction changes ownership boundaries but not behavior. No canonical
  behavior rule changed; the stable ownership hook is recorded in the fork
  maintenance runbook instead of modifying the upstream guide.

## Desktop provider security and discovery extraction

- [x] Extract platform-signature verification into a downstream-added generic
  desktop module, leaving immutable staging with one stable verification call.
- [x] Extract provider filename normalization and search-directory assembly
  into downstream-added generic modules, leaving upstream discovery iteration
  small and readable.
- [x] Preserve Windows user-scoped discovery in
  `%LOCALAPPDATA%/Buzz/providers`, bundled executable discovery, PATH discovery,
  macOS GUI path augmentation, `~/.local/bin`, deduplication, and executable
  checks.
- [x] Preserve the compiled signer allowlist contract and fail closed when a
  signer allowlist is configured but Authenticode verification is invalid,
  unavailable, or identifies an unapproved signer.
- [x] Preserve the staged-file read/execute guard so verification and both
  provider invocations use the same immutable bytes.
- [x] Add or retain deterministic platform-independent tests for directory and
  filename logic, with Windows-only verification coverage gated correctly.

## Storage composition isolation

- [x] Introduce the smallest practical provider-neutral object-store seams for
  media operations so `storage.rs` owns public media semantics while concrete
  Azure dispatch lives in downstream-added modules.
- [x] Preserve the S3/MinIO constructor and behavior as the default path and
  keep Azure selection explicit through the existing runtime environment.
- [x] Move Azure-specific media construction and operation adaptation out of
  the conflict-heavy upstream implementation wherever Rust ownership and async
  type constraints permit without duplicating business semantics.
- [x] Introduce the smallest practical provider-neutral Git object-store seam
  so `store.rs` owns Git keying, digest verification, bounded-read policy, CAS
  classification, and conformance semantics while concrete Azure operations
  live in downstream-added modules.
- [x] Move Azure Git create/get/head/delete/CAS adaptation out of the
  conflict-heavy upstream implementation wherever practical, keeping the
  existing `buzz-azure-storage` crate as the single Azure SDK adapter.
- [x] Preserve S3 error classification, Azure not-found/precondition
  classification, returned version/ETag behavior, exact inclusive range
  handling, streaming behavior, and all startup configuration errors.
- [x] Preserve Azurite and MinIO conformance coverage; do not create a second
  Azure implementation or a Kiingo-only storage service.

## Generic retained patches and upstream candidates

- [x] Re-review every retained ACP hunk against current upstream and remove
  only code that is now equivalent, dead, duplicated, or transitional.
- [x] Keep the cohesive provider-neutral ACP durability, bounded queueing,
  relay recovery, and local publication behavior in the Buzz runtime; do not
  replace it with an out-of-process Kiingo bridge.
- [x] Separate generally useful ACP changes into reviewable logical candidate
  commits or a reproducible patch ledger without making Kiingo production
  depend on upstream acceptance.
- [x] Re-review the generic TTS live-message and project README security fixes
  against current upstream; remove any equivalent upstream code and keep the
  smallest still-required implementation plus focused regressions.
- [x] Prepare independently reviewable upstream candidate metadata/patches for
  generic security and storage improvements where practical; record links if
  upstream pull requests can be opened, but do not block completion on an
  external maintainer accepting or merging them.
- [x] Confirm the scanner-safe database fixture reconstruction remains
  nonfunctional, is not referenced by deployed configuration, and does not
  reproduce the flagged connection literal.

## Inventory, budgets, and replay guard

- [x] Recompute the final divergent-path inventory from the current upstream
  merge-base and classify every path exactly once as `retain-generic`,
  `move-to-kiingo`, `drop/upstream-present`, or `obsolete`.
- [x] Reconcile the maintenance-document 25-file statement with the enforced
  26 modified-upstream-file baseline; use one truthful final budget everywhere.
- [x] Add deterministic conflict-sensitive measurements to the boundary guard:
  modified upstream production-source files, modified upstream files, changed
  production-source lines, and production-source diff hunks.
- [x] Set measured budgets from the final extracted tree with no hidden waiver,
  and make CI fail on stale inventory, unclassified paths, budget regressions,
  a missing upstream merge, or Kiingo business logic in upstream production
  source.
- [x] Update maintenance guidance with module ownership, stable hook contracts,
  removal conditions, upstream replay procedure, measurement commands, and
  recovery behavior.
- [x] Record before/after file, hunk, and changed-line evidence and explain any
  metric that cannot safely decrease rather than manipulating classifications.
- [x] Run a clean replay of the boundary guard against fetched
  `upstream/main` and prove the final inventory exactly matches the tree diff.

## Validation and review

- [x] Format only touched files with repository-provided tooling.
- [x] Run the focused provider schema tests and desktop Rust tests covering
  extracted discovery/signature/staging behavior. The platform module's three
  deterministic tests pass. The complete desktop target compiled through the
  changed Rust and failed only at final linking on the host's pre-existing
  ONNX/MSVC runtime-symbol mismatch; protected Windows CI is the authoritative
  full-desktop gate.
- [x] Run the focused media, Azure storage, Git-store, ACP, TTS, project README,
  and boundary-guard tests affected by the final diff, one resource-bounded
  workload at a time. The Windows-wide ACP suite was also attempted: 733 tests
  passed and 22 Unix-shell/timing tests failed because the upstream harness
  invokes `cat`/POSIX shell behavior on Windows. Targeted retained ACP suites
  passed; protected Linux CI remains the authoritative full-suite gate.
- [x] Run applicable lint/static/security checks without broad local builds,
  `tsc`, Jest, or unrelated suites unless a focused failure makes one necessary.
- [x] Audit the final diff for secrets, new unsafe code, production
  `unwrap`/`expect`, dead code, duplicate adapters, behavior flags, fallbacks,
  shims, and unrelated edits; resolve every implementation-caused issue.
- [x] Push DCO-signed commits to the implementation PR and let all protected CI
  and review requirements complete without bypassing protections or dequeuing
  another change.
- [x] Merge through the normal protected workflow only after the implementation
  PR is current with main and all required checks are green.

## Deployment and live production evaluation

- [x] Build/deploy only artifacts affected by the merged change using the
  existing release/deployment path; pin production server images by reviewed
  digest and produce an unsigned internal desktop artifact while public-trust
  signing remains externally blocked by Microsoft's identity validation.
- [x] Verify relay health, current Azure-backed media operations, Git
  conformance/startup admission, hosted-agent delivery, and existing agent
  identity/history/memory continuity on live production data.
- [x] Verify from the unsigned Windows desktop that provider discovery still
  finds the installed Kiingo Compute provider, schema-driven provider choices
  render correctly, and an existing hosted agent can receive a message and
  return an instruction-following response.
- [x] Record deployed versions/digests, timestamps, production commands or
  request identifiers, and redacted outcomes; do not expose credentials,
  tokens, private keys, or the scanner-flagged fixture literal.
- [x] Re-run every relevant live evaluation after the final production deploy
  until the ledger is green; do not mark an unavailable signing-only check as
  complete or conflate it with this unsigned internal release.

## Final evidence (2026-08-12)

### Merged source, CI, and fork boundary

- The implementation landed through protected Buzz PR
  [#68](https://github.com/Kiingo/buzz/pull/68): DCO-signed head
  `722c1c2535b405458e976151f6ae9dc46356e772`, merge commit
  `a0b35c3ff6639e46b4ea762340c114e25400c411`, merged at
  `2026-08-12T06:43:24Z`. Required Rust, TypeScript, security, CodeQL,
  Linux, Windows, macOS, relay, desktop, and desktop-E2E gates all completed
  successfully; no protection or queue bypass was used.
- The fork-safe GHCR owner correction landed through protected Buzz PR
  [#69](https://github.com/Kiingo/buzz/pull/69), merge commit
  `042a496bfd13a6bd3644266add28f47013c78fc0`. Post-merge Docker run
  [31574111213](https://github.com/Kiingo/buzz/actions/runs/31574111213)
  completed successfully for both relay architectures, both public push-gateway
  architectures, multi-architecture manifests, and provenance attestations.
- Unsigned desktop packaging was externalized from the fork into the Kiingo
  release boundary through normally queued Kiingo PRs
  [#9869](https://github.com/Kiingo/kiingo/pull/9869) and
  [#9871](https://github.com/Kiingo/kiingo/pull/9871), exact merge commits
  `f4d1c9c7bb77cbb29c25e0a32461477f18120519` and
  `1e9089b483911642d8e666fc558e3d93bef469fe`. The latter also removes the
  stale pnpm pin from the future signed release workflow.
- A final fetch on `2026-08-12` observed `origin/main` at
  `042a496bfd13a6bd3644266add28f47013c78fc0` and `upstream/main` at
  `4b3570671eb2786594267758af18784ac6e82972`; upstream remains an ancestor.
  The clean replay guard reports 46 classified divergent files, 26 modified
  upstream files, 15 modified upstream production files, 1,708 changed
  production lines, 168 production hunks, and zero Kiingo production
  contamination.
- A second final fetch and clean replay after desktop verification returned the
  same SHAs and the exact same `46 / 26 / 15 / 1,708 / 168 / 0` boundary
  measurements. No upstream drift, stale inventory, missing upstream merge, or
  Kiingo production contamination was present when this ledger was sealed.
- GitHub secret-scanning alert 3 is resolved as `used_in_tests`: the fixture is
  nonfunctional, test-only, non-public, absent from deployment configuration,
  and its scanner-triggering literal was removed. No credential rotation was
  warranted and the flagged literal is not reproduced here.

### Production deployment and live data

- Production workflow
  [31571099348](https://github.com/Kiingo/kiingo/actions/runs/31571099348)
  deployed exact merged Buzz revision
  `a0b35c3ff6639e46b4ea762340c114e25400c411` under Azure deployment
  `buzz-prod-31571099348` (correlation ID
  `999fe30d-6ad3-47da-be10-1142fbfd699c`) and completed successfully at
  `2026-08-12T07:25:47Z`.
- Reviewed production image pins are relay
  `sha256:78dfb96f1394e3720a98b55c8b71217e0a8068a1c58ee4d56f895fbdcda46c07`,
  agent
  `sha256:09b16b5c2e77e793a22880939454171f1aeff1b02848ae08e9f1eacf23c2abc2`,
  and hosted agent
  `sha256:d94556514532837de97a3407e51ca5f5324f5d81737ef82a17a18603ec002134`.
  The SBOM/scan/provenance evidence artifact has digest
  `sha256:c812c8d38788ed084e43e970b3fa7c8f351a9f1c08937e290497b300798dc6d7`.
- Both relay Pods, all three hosted-agent pools, the 12-worker compatibility
  listener, membership controller, and Redis were ready with zero restarts.
  `https://chat.kiingo.com/health` returned HTTP 200 at
  `2026-08-12T07:32:34Z`.
- Both relay replicas connected Azure media and Git storage. The startup-fatal
  A3 Git admission ran width 32 for three rounds and passed with zero transport
  drops. An authenticated live media GET at `2026-08-12T07:46:50Z` returned
  the existing 7,779,774-byte profile image, and its downloaded SHA-256 exactly
  matched its content-addressed media key; the local test copy was removed.
- A scoped, read-only, 10-millicore continuity Job using the exact deployed
  relay image reported: 10 users, 9 relay members, 1 community, 183 channels,
  367 channel memberships, 5,557 events, 1,025 thread rows, 4,560 audit rows,
  1 archived identity, and all 28 migrations. These match the pre-cutover
  identity/history baseline, with the expected append-only event increase.
  A second metadata-only query confirmed all four encrypted `kind:30174`
  engram records from `2026-07-31` remain for the same agent identity. Both
  disposable Jobs and their local manifests were deleted after success.
- Hosted-agent event `8f92ef2a1f59c484f435f4e2757dfe943b5b81e3e889b52feeca71564902eed8`
  was accepted at Unix time `1786520742`; its durable receipt arrived one
  second later and its final response event
  `4cbd0afd153cdcb2b8ef303f6e733d4bcb59889d38d5e58a57512f0424da5a59`
  arrived 11 seconds after acceptance. The reply followed both the saved High
  Agency instructions and the requested exact two-bullet shape, proving the
  relay-to-resident-agent-to-Kiingo-Compute-to-relay path on live production.
- A final read-only Azure managed-command check after the desktop release found
  both relay replicas, the hosted-agent supervisor, membership controller,
  Kiingo agent, and Redis ready with zero restarts. It also reconfirmed the
  relay and hosted-agent image digests above directly from the live
  Deployments. `https://chat.kiingo.com/health` returned HTTP 200 again at
  `2026-08-12T10:51:13Z`.

### Unsigned Windows desktop

- Two independently detected packaging failures were rejected rather than
  shipped. Normally queued Kiingo PR
  [#9882](https://github.com/Kiingo/kiingo/pull/9882), merge commit
  `687cd4752bedf4ea073d245a6c7ccff3fa97a5ca`, made the workflow clean the
  desktop package and verify the compiled app version. Normally queued Kiingo
  PR [#9888](https://github.com/Kiingo/kiingo/pull/9888), merge commit
  `4cf28a516cf77d2d222258c4813165ac8e716eaf`, additionally clears the exact
  target bundle directory after cache restore, requires exactly one NSIS
  installer, and requires both app and installer metadata to match the
  immutable release version. All protected checks completed successfully; no
  queue or protection bypass was used.
- Final workflow
  [31586145121](https://github.com/Kiingo/kiingo/actions/runs/31586145121)
  completed successfully at `2026-08-12T10:39:14Z` from exact release head
  `4cf28a516cf77d2d222258c4813165ac8e716eaf`. Artifact ID `9138048473`, named
  `kiingo-buzz-windows-unsigned-a0b35c3ff6639e46b4ea762340c114e25400c411`,
  contains the single installer
  `Kiingo-Buzz_0.5.11-kiingo-unsigned.4_windows-x86_64-unsigned.exe`. Its
  SHA-256 is
  `E59D742F33EAB159E03EFC69EE81ED046D6DB3D498AAAE863AB90A9BE806EA07`;
  installer version, compiled app version, and evidence version all equal
  `0.5.11-kiingo-unsigned.4`, the embedded Buzz revision is
  `a0b35c3ff6639e46b4ea762340c114e25400c411`, and the relay is
  `wss://chat.kiingo.com`.
- Authenticode correctly reports `NotSigned`. This is the explicitly requested
  internal unsigned release, not a claim that the still-pending Microsoft
  public-trust identity validation or future signing-only gate has completed.
  The two rejected local candidate downloads were removed so they cannot be
  mistaken for the final installer.
- The final installer completed an in-place Windows installation with exit code
  zero. The installed executable reports
  `0.5.11-kiingo-unsigned.4`, SHA-256
  `81C25754CEE626C13E40F3B72F0BCAD4F2B2927D1D2867E3382BA42794EF6C83`,
  and the matching Windows uninstall-registry version. The existing identity,
  community, channels, agent list, direct messages, and history remained
  visible after restart.
- User-scoped discovery preserved the existing Kiingo Compute provider bytes
  exactly at SHA-256
  `B9140792CF7A4046C99208EEF067C464754DCC661FE09952C3C86E8D0C98D89C`.
  Provider protocol `2`, version `0.1.3`, and the live API-backed capability
  catalog loaded successfully. The schema exposed both Claude Code and Codex
  CLI, automatic/stable-track/exact-version model modes, supported exact model
  choices, model-dependent reasoning effort, and service-tier options without
  a Kiingo-specific rendering branch in Buzz. Provider `self_check` returned
  `ok: true`, `api_reachable: true`, `catalog_source: api`, and catalog age
  zero seconds.
- In the final installed desktop, the agent editor discovered `kiingo` under
  **Run on**, rendered Claude Code and Codex CLI from the provider schema, and
  rendered Claude model and reasoning selections. A fresh message sent from
  that exact desktop to the existing **High Agency Hosted** agent at
  `2026-08-12T11:01:25Z` received the durable subscription-backed **Claude
  Code** receipt and a final answer in roughly nine seconds. The response used
  exactly three bullets and followed the saved High Agency instructions by
  recommending owner/context mapping, a small responsible boundary probe, and
  precedent search. This proves the installed desktop-to-relay-to-resident
  agent-to-Kiingo Compute-to-Claude Code-to-relay path on live production.

### Scoped cleanup evidence

- The six superseded, clean implementation/release worktrees and their merged
  local and remote branches were removed after merge verification. The two
  rejected unsigned artifact folders and the temporary provider test binary
  were also removed. The final verified installer was preserved, as were all
  unrelated worktrees, branches, queues, and user changes. The ledger
  worktree/branch remains only until its protected evidence PR is merged and
  will be removed immediately afterward.
- Evidence PR [#70](https://github.com/Kiingo/buzz/pull/70) changed only this
  ledger. CodeQL, release-candidate validation, the fork boundary, Desktop
  Core, relay-backed integration, all four smoke shards, and the aggregate
  Desktop gate completed successfully. One existing virtualization timing
  assertion failed on the first smoke-shard attempt (`120` simulated pixels
  versus `>200`) while 244 tests passed; the exact failed job was inspected and
  its targeted workflow rerun passed without a source change. No failure was
  concealed, bypassed, or retried broadly.

## Final reconciliation and cleanup

- [x] Skeptically reconcile every checkbox against the final merged tree, CI
  evidence, deployed artifacts, and live production rather than relying on
  intermediate results.
- [x] Confirm all requested behavior is fully implemented, no required item is
  deferred, and any external upstream PR status is documented without becoming
  a runtime dependency.
- [x] Remove only this workstream's merged branch/worktree and temporary local
  artifacts; preserve unrelated worktrees, branches, queues, and user changes.
- [x] Mark the persistent goal complete only after the entire ledger is checked
  and report the final goal token usage returned by the goal service.

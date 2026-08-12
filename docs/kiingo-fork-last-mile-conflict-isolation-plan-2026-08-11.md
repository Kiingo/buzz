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

## Architecture constraints

- [ ] Preserve all existing upstream provider, agent, media, Git, ACP, huddle,
  project README, and relay behavior while moving downstream implementation
  details behind small provider-neutral composition seams.
- [ ] Keep provider capability/configuration derived from the provider runtime
  catalog and JSON schema; do not hardcode Kiingo, Codex, Claude, or provider
  IDs into generic desktop rendering code.
- [ ] Keep Azure support provider-neutral, explicitly selected by existing
  runtime configuration, authenticated through the existing Azure credential
  contract, and removable without changing persisted media, Git objects,
  identities, history, or memories.
- [ ] Preserve immutable provider staging, bounded process I/O, secret
  redaction, protocol negotiation, user-scoped discovery, and optional
  build-pinned Windows signer enforcement.
- [ ] Preserve tenant-scoped media sidecars, bounded reads/streams,
  content-addressed Git objects, create-only writes, CAS pointer semantics,
  conformance admission, and existing S3/MinIO behavior.
- [ ] Add no unnecessary smoke tests, canaries, scheduled jobs, or CI stages;
  use the smallest existing focused tests and only add deterministic regression
  coverage required by an extracted seam.

## Provider schema UI extraction

- [ ] Move provider JSON-schema option normalization and dependent-field
  visibility into downstream-added, provider-neutral modules with documented
  types and deterministic pure functions.
- [ ] Move the generic field renderer and dependent-value reconciliation out of
  `ProviderConfigFields.tsx`, leaving that upstream-owned component as a small,
  stable composition hook around upstream behavior.
- [ ] Preserve support for `enum`, `oneOf`, booleans, labels, read-only values,
  `x-visible-when`, `x-options-by-field`, `x-options-by-fields`,
  `x-option-filter`, and `x-hide-when-no-options`.
- [ ] Preserve schema-declared scalar coercion and reset invalid dependent
  values to a valid schema default or empty value.
- [ ] Move/extend focused tests so the extracted pure schema behavior is
  covered without duplicating the implementation in test fixtures.
- [ ] Reconcile `desktop/src/features/agents/AGENTS.md`; update it only if the
  canonical configuration/rendering rules change, otherwise record that the
  extraction changes ownership boundaries but not behavior.

## Desktop provider security and discovery extraction

- [ ] Extract platform-signature verification into a downstream-added generic
  desktop module, leaving immutable staging with one stable verification call.
- [ ] Extract provider filename normalization and search-directory assembly
  into downstream-added generic modules, leaving upstream discovery iteration
  small and readable.
- [ ] Preserve Windows user-scoped discovery in
  `%LOCALAPPDATA%/Buzz/providers`, bundled executable discovery, PATH discovery,
  macOS GUI path augmentation, `~/.local/bin`, deduplication, and executable
  checks.
- [ ] Preserve the compiled signer allowlist contract and fail closed when a
  signer allowlist is configured but Authenticode verification is invalid,
  unavailable, or identifies an unapproved signer.
- [ ] Preserve the staged-file read/execute guard so verification and both
  provider invocations use the same immutable bytes.
- [ ] Add or retain deterministic platform-independent tests for directory and
  filename logic, with Windows-only verification coverage gated correctly.

## Storage composition isolation

- [ ] Introduce the smallest practical provider-neutral object-store seams for
  media operations so `storage.rs` owns public media semantics while concrete
  Azure dispatch lives in downstream-added modules.
- [ ] Preserve the S3/MinIO constructor and behavior as the default path and
  keep Azure selection explicit through the existing runtime environment.
- [ ] Move Azure-specific media construction and operation adaptation out of
  the conflict-heavy upstream implementation wherever Rust ownership and async
  type constraints permit without duplicating business semantics.
- [ ] Introduce the smallest practical provider-neutral Git object-store seam
  so `store.rs` owns Git keying, digest verification, bounded-read policy, CAS
  classification, and conformance semantics while concrete Azure operations
  live in downstream-added modules.
- [ ] Move Azure Git create/get/head/delete/CAS adaptation out of the
  conflict-heavy upstream implementation wherever practical, keeping the
  existing `buzz-azure-storage` crate as the single Azure SDK adapter.
- [ ] Preserve S3 error classification, Azure not-found/precondition
  classification, returned version/ETag behavior, exact inclusive range
  handling, streaming behavior, and all startup configuration errors.
- [ ] Preserve Azurite and MinIO conformance coverage; do not create a second
  Azure implementation or a Kiingo-only storage service.

## Generic retained patches and upstream candidates

- [ ] Re-review every retained ACP hunk against current upstream and remove
  only code that is now equivalent, dead, duplicated, or transitional.
- [ ] Keep the cohesive provider-neutral ACP durability, bounded queueing,
  relay recovery, and local publication behavior in the Buzz runtime; do not
  replace it with an out-of-process Kiingo bridge.
- [ ] Separate generally useful ACP changes into reviewable logical candidate
  commits or a reproducible patch ledger without making Kiingo production
  depend on upstream acceptance.
- [ ] Re-review the generic TTS live-message and project README security fixes
  against current upstream; remove any equivalent upstream code and keep the
  smallest still-required implementation plus focused regressions.
- [ ] Prepare independently reviewable upstream candidate metadata/patches for
  generic security and storage improvements where practical; record links if
  upstream pull requests can be opened, but do not block completion on an
  external maintainer accepting or merging them.
- [ ] Confirm the scanner-safe database fixture reconstruction remains
  nonfunctional, is not referenced by deployed configuration, and does not
  reproduce the flagged connection literal.

## Inventory, budgets, and replay guard

- [ ] Recompute the final divergent-path inventory from the current upstream
  merge-base and classify every path exactly once as `retain-generic`,
  `move-to-kiingo`, `drop/upstream-present`, or `obsolete`.
- [ ] Reconcile the maintenance-document 25-file statement with the enforced
  26 modified-upstream-file baseline; use one truthful final budget everywhere.
- [ ] Add deterministic conflict-sensitive measurements to the boundary guard:
  modified upstream production-source files, modified upstream files, changed
  production-source lines, and production-source diff hunks.
- [ ] Set measured budgets from the final extracted tree with no hidden waiver,
  and make CI fail on stale inventory, unclassified paths, budget regressions,
  a missing upstream merge, or Kiingo business logic in upstream production
  source.
- [ ] Update maintenance guidance with module ownership, stable hook contracts,
  removal conditions, upstream replay procedure, measurement commands, and
  recovery behavior.
- [ ] Record before/after file, hunk, and changed-line evidence and explain any
  metric that cannot safely decrease rather than manipulating classifications.
- [ ] Run a clean replay of the boundary guard against fetched
  `upstream/main` and prove the final inventory exactly matches the tree diff.

## Validation and review

- [ ] Format only touched files with repository-provided tooling.
- [ ] Run the focused provider schema tests and desktop Rust tests covering
  extracted discovery/signature/staging behavior.
- [ ] Run the focused media, Azure storage, Git-store, ACP, TTS, project README,
  and boundary-guard tests affected by the final diff, one resource-bounded
  workload at a time.
- [ ] Run applicable lint/static/security checks without broad local builds,
  `tsc`, Jest, or unrelated suites unless a focused failure makes one necessary.
- [ ] Audit the final diff for secrets, new unsafe code, production
  `unwrap`/`expect`, dead code, duplicate adapters, behavior flags, fallbacks,
  shims, and unrelated edits; resolve every implementation-caused issue.
- [ ] Push DCO-signed commits to the implementation PR and let all protected CI
  and review requirements complete without bypassing protections or dequeuing
  another change.
- [ ] Merge through the normal protected workflow only after the implementation
  PR is current with main and all required checks are green.

## Deployment and live production evaluation

- [ ] Build/deploy only artifacts affected by the merged change using the
  existing release/deployment path; pin production server images by reviewed
  digest and produce an unsigned internal desktop artifact while public-trust
  signing remains externally blocked by Microsoft's identity validation.
- [ ] Verify relay health, current Azure-backed media operations, Git
  conformance/startup admission, hosted-agent delivery, and existing agent
  identity/history/memory continuity on live production data.
- [ ] Verify from the unsigned Windows desktop that provider discovery still
  finds the installed Kiingo Compute provider, schema-driven provider choices
  render correctly, and an existing hosted agent can receive a message and
  return an instruction-following response.
- [ ] Record deployed versions/digests, timestamps, production commands or
  request identifiers, and redacted outcomes; do not expose credentials,
  tokens, private keys, or the scanner-flagged fixture literal.
- [ ] Re-run every relevant live evaluation after the final production deploy
  until the ledger is green; do not mark an unavailable signing-only check as
  complete or conflate it with this unsigned internal release.

## Final reconciliation and cleanup

- [ ] Skeptically reconcile every checkbox against the final merged tree, CI
  evidence, deployed artifacts, and live production rather than relying on
  intermediate results.
- [ ] Confirm all requested behavior is fully implemented, no required item is
  deferred, and any external upstream PR status is documented without becoming
  a runtime dependency.
- [ ] Remove only this workstream's merged branch/worktree and temporary local
  artifacts; preserve unrelated worktrees, branches, queues, and user changes.
- [ ] Mark the persistent goal complete only after the entire ledger is checked
  and report the final goal token usage returned by the goal service.

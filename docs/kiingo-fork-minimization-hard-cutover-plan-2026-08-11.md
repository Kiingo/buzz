# Kiingo Buzz fork minimization hard-cutover implementation plan

## Goal and completion contract

Replace the broad Kiingo downstream divergence with a conflict-resistant release
that uses Buzz's intentional provider and configuration extension points. Kiingo
must retain the complete production experience: Windows desktop distribution,
closed-community enrollment, exact-sender Codex and Claude subscription routing,
hosted agent creation and editing, system instructions, model and reasoning
selection, lifecycle safety, encrypted agent identity, Azure durability, warm
Kiingo Compute execution, conversation and memory continuity, and rollback.

This is one hard cutover. Ordered sections below are execution mechanics, not
separate releases. The work is complete only when every checkbox is checked with
implementation or live-production evidence, all affected pull requests are
merged normally, all affected artifacts are deployed, the dedicated eval ledger
is green, and the final audit finds no deferred cleanup, compatibility fork,
feature flag, duplicate implementation, or undocumented exception.

## Non-negotiable architecture and value guardrails

- [ ] Keep `block/buzz` behavior and current upstream history as the desktop and relay base; do not reimplement an upstream subsystem merely to preserve a downstream patch.
- [ ] Put all Kiingo names, URLs, organization rules, subscription eligibility, model catalogs, credential remediation, Azure resource names, and Compute policy in Kiingo-owned components rather than upstream-owned Buzz source.
- [ ] Use the intentional `buzz-backend-*` provider discovery, `info`, `config_schema`, and idempotent `deploy` protocol as the primary desktop customization boundary.
- [ ] Keep Codex/Claude credentials exclusively in Kiingo Harness Connections and keep exact-sender authorization fail-closed with no owner, administrator, API-key, or other-employee fallback.
- [ ] Preserve the existing Buzz agent public identity, encrypted private identity, hosted endpoint, profile revision, conversation/history, memory references, and audit data through the cutover and rollback.
- [ ] Preserve the current production relay/community URL and community scope without a parallel relay, duplicate community, or user-visible migration.
- [ ] Make every retained Buzz-core change provider-neutral, independently testable, and suitable for upstream contribution; no retained generic hook may recognize Kiingo.
- [ ] Do not persist live provider lifecycle projections throughout persona, team, snapshot, import/export, and managed-agent record formats when authoritative state can be queried through the provider.
- [ ] Do not add feature flags, dual old/new execution paths, temporary shims, fallback implementations, extra canaries, or unnecessary CI smoke jobs.

## Baseline, source safety, and authoritative inventory

- [ ] Record the exact Kiingo `main`, upstream `main`, production desktop, provider, relay, API, supervisor, and Compute revisions before mutation.
- [ ] Preserve the pre-cutover Kiingo fork branch and immutable production artifacts as rollback evidence without modifying the existing conflicted local checkout.
- [ ] Start implementation in a dedicated clean worktree after fetching both remotes and merging current upstream `main`.
- [ ] Produce a machine-readable inventory of every fork-added and fork-modified file relative to the current upstream merge base, grouped by ownership and runtime purpose.
- [ ] Classify every downstream delta as `drop/upstream-present`, `move-to-kiingo`, `retain-generic`, or `obsolete`; do not leave an unclassified production delta.
- [ ] Record baseline fork metrics: upstream divergence, modified upstream files, added files, insertions/deletions, recent-upstream overlap, and current merge-conflict hotspots.
- [ ] Identify the exact production build/deploy consumer for each Kiingo-owned Buzz file before moving or deleting it.

## Kiingo-owned provider and Compute boundary

- [ ] Make the signed `buzz-backend-kiingo` provider the sole desktop-side owner of Kiingo connection discovery, harness/model/reasoning catalog, configuration validation, identity envelope creation, and initial provisioning; keep subsequent hosted-agent management in the authenticated Kiingo management surface.
- [ ] Ensure the provider emits a standard provider schema that represents Codex and Claude, automatic and explicit models, compatible reasoning/service-tier choices, and safe connection readiness without requiring Kiingo model logic in Buzz.
- [ ] Keep connection setup and detailed remediation in the Kiingo onboarding/Harness Connections UI; provider failures must return bounded actionable text without a Kiingo-specific Buzz error parser.
- [ ] Move or replace the fork-local `kiingo-compute-acp` implementation so its maintained source and release ownership live in the Kiingo monorepo/provider boundary rather than the upstream Buzz workspace.
- [ ] Move Kiingo-specific ACP publication, durable-ingress, action polling, context forwarding, capacity receipts, and recovery behavior out of generic `buzz-acp` source or upstream the genuinely generic portions independently.
- [ ] Remove duplicate implementations after their Kiingo-owned replacements are proven; no dead fork-local bridge crate or publication module may remain.
- [ ] Keep the hosted supervisor, exact-user credential resolution, encrypted identity, membership controller, staged ingress, warm workers, and action gateway in Kiingo-owned production services.
- [ ] Prove Codex and Claude receive the exact requested profile and the exact sender's eligible subscription after externalization.

## Minimal generic Buzz desktop seam

- [ ] Rebase the native hosted-agent experience on stock upstream provider discovery and provider-backed agent creation.
- [ ] Reduce provider schema rendering changes to a compact generic JSON-schema control extension for enums, booleans, numbers, labels, and bounded conditional options.
- [ ] Ensure agent name and system instructions remain normal Buzz fields and reach the provider through the standard deploy payload.
- [ ] Keep the stock provider deploy contract idempotent for safe create/retry while applying subsequent hosted-agent edits through the designated authenticated Kiingo management surface, without provider-specific branches in Buzz.
- [ ] Implement live hosted-agent lifecycle operations (`status`, `pause`, `resume`, `delete`, `reconcile`) in the designated authenticated Kiingo management surface without spreading lifecycle cache fields through unrelated Buzz persisted models.
- [ ] Make provider delete complete remotely before local identity-management state is removed; a failure must remain visible and retryable rather than orphaning a hosted identity.
- [ ] Retain generic immutable provider staging and runtime signer verification with a build-time trust policy, or remove the patch only if current upstream supplies equivalent enforcement.
- [ ] Keep protocol v1 behavior unchanged for existing providers while making unsupported optional capabilities fail clearly; do not preserve a Kiingo-only compatibility branch.
- [ ] Remove native Kiingo connection cards, URLs, labels, model lists, and special-case provider IDs from Buzz source.
- [ ] Remove downstream lifecycle fields and plumbing from managed-agent snapshots, persona/team import/export, access policy, runtime summaries, and unrelated tests unless a provider-neutral authoritative need is demonstrated.
- [ ] Keep the retained desktop integration in dedicated added modules with the smallest stable hooks into upstream-owned files.
- [ ] Add focused provider-contract, generic schema-UI, and designated management-UI tests covering create, edit, instructions, model/reasoning schema, status, pause/resume, safe delete, provider absence, v1 compatibility, signature failure, and actionable errors.

## Relay, storage, and Azure ownership boundary

- [ ] Move Kiingo Azure deployment manifests, resource names, conformance jobs, and production values out of the Buzz source tree into reviewed Kiingo-owned IaC/deployment paths.
- [ ] Update the production workflow to consume the Kiingo-owned Azure deployment package while building the relay from the exact reviewed Buzz source revision.
- [ ] Retain Azure Blob durability through a generic storage interface or independently upstreamable adapter with no Kiingo resource names or deployment policy in Buzz core.
- [ ] Minimize required generic storage glue in `buzz-media` and relay startup/state; keep Azure SDK/configuration details isolated in the adapter.
- [ ] Preserve create-only writes, ETag CAS, GET/stream/range/HEAD/list/delete, version restore, soft-delete recovery, namespace isolation, private networking, and workload identity.
- [ ] Move Kiingo-specific release, Azure, signing, and deployment workflows out of the Buzz fork unless the workflow is a generic upstream-equivalent check.
- [ ] Preserve the current PostgreSQL, Blob, Redis, Key Vault, Front Door, AKS, relay, and community data without replacement or destructive migration.

## Fork and release mechanics

- [ ] Establish an exact-upstream reference and a generated/reviewed Kiingo release branch or equivalent reproducible composition that never requires rebasing published production history.
- [ ] Store the minimal retained patch series in deterministic order with purpose, upstream status, owner, and removal condition.
- [ ] Add a low-cost upstream replay guard that applies or compares the patch series against current upstream and reports conflicts without building the full application.
- [ ] Add a fork-footprint guard with these final budgets: zero Kiingo-specific business-logic lines in upstream-owned source, no more than 15 modified upstream production source files, no more than 25 modified upstream files including tests/manifests, and no unowned generic patch.
- [ ] Exclude exact upstream merges from downstream feature metrics while still counting every final tree divergence.
- [ ] Fail the guard on Kiingo identifiers, production URLs, model catalogs, Harness Connection rules, or Azure resource names in upstream-owned production source.
- [ ] Ensure every generic retained patch has an upstream issue/PR or a documented evidence-backed reason it belongs permanently at the composition boundary.
- [ ] Remove obsolete fork-only generic fixes when current upstream contains the behavior; do not keep parallel versions merely because their commits remain in history.
- [ ] Document the repeatable upstream-sync and release process, rollback procedure, patch budget, and ownership map.

## Security, privacy, and data-integrity proof

- [ ] Re-run focused forged-signature, replay, cross-user, cross-community, inactive-member, ambiguous-connection, and no-fallback tests across the new boundary.
- [ ] Prove agent private keys remain encrypted before leaving the desktop provider process and never enter logs, command lines, provider configuration, support output, or crash text.
- [ ] Prove provider schema/configuration cannot carry secret-like fields, nested unbounded values, unknown lifecycle shapes, or untrusted executable paths.
- [ ] Prove signed provider verification, immutable staging, catalog signature verification, profile revision checks, request idempotency, and two-phase deletion remain effective.
- [ ] Resolve or explicitly disposition all open high/critical secret, dependency, code, and container alerts affecting shipped artifacts.
- [ ] Confirm no data migration or rollback path deletes or changes agent identity, histories, memory references, membership audit, or credential ownership.

## Scoped validation and CI

- [ ] Use server-resource-safe validation: inspect host pressure first, run one heavy operation at a time, cap output/memory, and prefer file/crate-scoped commands.
- [ ] Run formatting and the smallest Rust tests for each changed generic Buzz module and Kiingo-owned Rust application.
- [ ] Run only the focused desktop component/contract tests required by the retained patch; do not run Jest, TypeScript compilation, or a desktop build unless implementation or an authoritative gate requires it.
- [ ] Validate Kiingo monorepo API/provider/supervisor/IaC changes with package-scoped tests and repository guards.
- [ ] Let protected CI perform required cross-platform builds and broad release packaging once local focused validation is green.
- [ ] Fix every implementation-caused CI, security, review, and upstream-replay failure before merge; do not bypass protections or dequeue another PR.

## Dedicated fork-minimization eval ledger

- [ ] Create a versioned eval artifact recording exact commits, artifact hashes, production revisions, identities, timestamps, cases, cleanup, and redacted evidence.
- [ ] Prove current upstream can be incorporated by the documented process with zero unresolved conflicts and the footprint guard remains within budget.
- [ ] Prove the Windows desktop discovers only the intended installed Kiingo provider and renders provider-owned Codex/Claude/model/reasoning configuration without local CLIs.
- [ ] Prove creation of a hosted Codex agent with instructions, automatic model, and the exact sender's ChatGPT connection returns a real reply.
- [ ] Prove creation of a hosted Claude agent with instructions, explicit model/reasoning, and the exact sender's Claude connection returns a real reply.
- [ ] Prove editing only the instructions changes the next hosted reply without replacing the Buzz public identity or losing conversation/memory continuity.
- [ ] Prove edit, status, pause, resume, reconcile, deletion retry, completed deletion, and post-delete no-reply behavior through the retained generic lifecycle seam or its designated Kiingo management surface.
- [ ] Prove a second authorized sender uses only their own connection and a missing/revoked connection fails visibly without cross-user fallback.
- [ ] Prove relay reconnect, desktop restart, provider restart, API deployment, listener recycle, Redis restart, and warm-worker turnover preserve durable state and do not duplicate execution/publication.
- [ ] Prove Azure Blob read/write/CAS/range/version/soft-delete recovery and PostgreSQL/Blob reconstruction after the ownership move.
- [ ] Prove live acknowledgement/capacity/claim/first-activity/terminal telemetry, zero interactive cold Job starts, and expected low-frequency ten-person capacity.
- [ ] Prove the production onboarding wizard, public download, identity link, both subscription cards, hosted-agent summary, and first-reply path remain functional.
- [ ] Prove rollback to the retained prior desktop/provider/relay/API revisions preserves hosted identities, profiles, history, and memory references, then restore the new release.
- [ ] Remove all disposable eval identities, endpoints, restore objects, temporary releases, and local artifacts created by this work.

## Pull requests, deployment, and completion audit

- [ ] Commit this plan first on the dedicated Buzz feature branch, push it, and open the implementation PR before broad code changes.
- [ ] Open linked Kiingo monorepo PR(s) for every moved component/workflow/IaC change; keep cross-repo source revisions immutable and reviewable.
- [ ] Merge through normal protected queues after required checks pass without administrative bypass or queue interference.
- [ ] Publish the reviewed desktop/provider release artifacts with checksums, provenance, and rollback references.
- [ ] Deploy every affected API, supervisor, membership, relay, storage, Agent UI, and Compute component from its reviewed merge commit.
- [ ] Verify production health, readiness, exact deployed revisions, alert coverage, and no unexpected resource replacement after deployment.
- [ ] Update every checkbox with evidence only after the behavior is implemented and proven.
- [ ] Re-read this plan skeptically against the final code, fork diff, CI, production state, and eval ledger; close every missing, incomplete, or weakly evidenced item.
- [ ] Confirm the final fork metrics satisfy the budget and the complete user-visible Buzz/Kiingo Compute experience remains available.
- [ ] Clean only this workstream's merged branches/worktrees and leave unrelated/conflicted worktrees untouched.

## Evidence log

- 2026-08-11: The pre-cutover assessment measured 171 changed files relative to
  upstream (`41` added, `130` modified), `12,882` insertions and `1,312`
  deletions. One hundred of the 130 modified upstream files had also changed in
  upstream since 2026-07-29, demonstrating a 76.9% recent-churn overlap.
- 2026-08-11: Created clean worktree
  `E:\Projects\buzz-kiingo\worktrees\minimize-kiingo-buzz-fork-20260811`
  from Kiingo `main` `501a3a887c95a3eed4e83c339471c0baa5db33eb` and merged
  current upstream `main` `be48ce98bd163899197b79a82ad5b2bcf0bc9b54`
  without conflict. The unrelated conflicted main checkout was not modified.

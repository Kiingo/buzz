# Kiingo Buzz Upstream Candidate Ledger

Date reviewed: 2026-08-11

Upstream baseline: `block/buzz@4b3570671eb2786594267758af18784ac6e82972`

This ledger separates generally useful Buzz changes from Kiingo's production
composition. It is evidence and patch provenance, not a dependency: Kiingo
production must continue to work if upstream declines, rewrites, or delays any
candidate. Before publishing a candidate, replay it onto current
`upstream/main`, retain DCO authorship, run the focused checks below, and search
again for equivalent upstream work.

## Independently reviewable candidates

| Candidate | Reproducible source | Current upstream status | Focused proof before submission |
| --- | --- | --- | --- |
| Avoid pathological TTS cleanup regex backtracking | `c92623f1d`, then formatting-only `65901ffe2` | No equivalent commit or matching pull request found in current upstream review | `desktop/src/features/huddle/lib/ttsLiveMessages.security.test.mjs` and neighboring live-message tests |
| Harden project README HTML-to-Markdown normalization | `6bd10af76`, with the smallest retained security follow-up from `31d98f7b0` | No equivalent commit or matching pull request found; upstream PR #2228 concerns documentation publication, not the renderer | `projectReadmeMarkdown.test.mjs` plus the project README panel tests |
| Keep documentation-only database fixture scanner-safe | `18a14d27e` | No equivalent current-upstream change; Kiingo secret-scanning alert #3 concerns the pre-reconstruction literal | Focused `buzz-db` lazy read-pool constructor test and secret scan |
| Azure Blob object-store adapter | `9ae994550` plus the Azure isolation commit in Kiingo PR #68 | No Azure Blob adapter or matching pull request found in current upstream review | `buzz-azure-storage` unit/Azurite conformance, `buzz-media` tests, Git store tests, and startup conformance admission |
| Provider-owned JSON-schema presentation | The desktop schema-isolation commit in Kiingo PR #68 | No equivalent schema-keyword renderer found in current upstream | `ProviderConfigFields.test.mjs` and desktop protected CI |
| Platform provider discovery and optional signer enforcement | The desktop platform-isolation commit in Kiingo PR #68 | No equivalent user-scoped Windows provider directory or build-pinned signer policy found in current upstream | provider platform/backend tests and signed/unsigned Windows release checks appropriate to the build policy |

## ACP candidate sequence

The retained ACP work is cohesive at runtime but should be proposed upstream as
small behavioral changes. The following DCO-preserving commits are the
reproducible starting points; replay each independently and keep only the
minimal current-upstream diff:

| Commit | Behavior |
| --- | --- |
| `6dfe4891b` | Sign preview HTTP authorization for the canonical relay. |
| `53707367b` | Preserve the canonical host while dialing a private relay. |
| `3ce653377` | Preserve the canonical host for private HTTP relay calls. |
| `46c25c86f` | Permit provider-neutral bridge action publications. |
| `e23e31cbb` | Consume member cancellation controls exactly once. |
| `beeb43da9` | Forward bounded structured conversation context. |
| `b9d2b010c` | Retry admitted local publications across relay recovery. |
| `44187cfa5` | Recover transient action-poll failures. |
| `0e748d5c7` | Publish actionable enrollment errors. |
| `1ea86fa2a` | Surface generic hosted-subscription recovery guidance. |

Current upstream has adjacent open ACP work, notably PR #5181 (restart recovery)
and PR #5386 (persistent system-prompt negotiation). Neither is treated as an
equivalent replacement in this baseline. Re-check their final trees before
publishing or removing any overlapping hunk; do not stack a candidate on an
unmerged external branch for Kiingo production.

## Patch reproduction

For an existing single commit, generate a review artifact without rewriting
authorship:

```text
git format-patch -1 <commit> --stdout
```

For the new PR #68 candidates, use the final logical commit after merge and
compare it directly to the recorded upstream baseline. A candidate is ready to
publish only when its patch contains one behavior, no Kiingo product names or
endpoints, no production credentials, and its focused tests pass on current
upstream.

## Removal contract

When upstream ships equivalent behavior, delete the downstream hunk and its
inventory entry in the same upstream-sync PR. Verify semantics and regression
coverage before removal; matching names or similar prose are not sufficient.

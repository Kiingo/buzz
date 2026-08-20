# Kiingo Buzz Upstream Candidate Ledger

Date reviewed: 2026-08-20

Upstream baseline: `block/buzz@2e7583bf5ad5926ca32367af9954bc79d108e42d`

This ledger separates generally useful Buzz changes from Kiingo's production
composition. It is evidence and patch provenance, not a dependency: Kiingo
production must continue to work if upstream declines, rewrites, or delays any
candidate. Before publishing a candidate, replay it onto current
`upstream/main`, retain DCO authorship, run the focused checks below, and search
again for equivalent upstream work.

## Submitted, independently reviewable changes

Every row below was replayed onto the recorded upstream baseline without
Kiingo product names, endpoints, credentials, or deployment policy. Upstream
acceptance is not a production dependency; the downstream implementation stays
in place until a later upstream snapshot contains equivalent behavior and the
focused proof is green after removing the fork patch.

| Behavior | Upstream PR and exact head | Focused proof on current upstream | Downstream removal condition |
| --- | --- | --- | --- |
| Isolate nested custom-harness form submission so agent edits become dirty/saveable | [#6403](https://github.com/block/buzz/pull/6403) `62d4ff6d3a26e3781e1628f0e9e04b83ce6b5c4b` | nested form-submit regression coverage | Remove when the nested form can no longer consume the parent agent-definition submit. |
| Render provider-owned agent configuration and compute execution readiness generically | [#6404](https://github.com/block/buzz/pull/6404) `4c09d4e8e262e290b52ef6c06422346bb81ef210` | 16 provider-schema/readiness tests | Remove when upstream supports the same schema keywords, validation, hosted/local execution state, and owner-review semantics. |
| Discover platform-managed providers with immutable staging and optional signer enforcement | [#6405](https://github.com/block/buzz/pull/6405) `383e406b1db16234eee1160c26691e1e0915978d` | exact provider-platform Rust tests (3 passed) and formatting | Remove when upstream exposes the equivalent user-scoped provider directory and build-pinned signer contract. |
| Hydrate persisted DM recipients before every send path | [#6406](https://github.com/block/buzz/pull/6406) `22ec0ce884c10765a7534503816554c90d132ad1` | restart-empty pair/group DM, cache, fail-closed, and channel-binding tests (12 passed) | Remove when a restarted desktop cannot emit a top-level DM event before authoritative recipient tags are available. |
| Bound live TTS cleanup without pathological regex backtracking | [#6408](https://github.com/block/buzz/pull/6408) `826bf2fc547c63dcc24c07c211538411b2d1841f` | adversarial sanitizer regression plus neighboring live-message coverage | Remove when upstream contains equivalent linear-time sanitization and the adversarial test. |
| Normalize project README HTML safely | [#6409](https://github.com/block/buzz/pull/6409) `d9e2d38aa893de961430ff137ca9b221d7651e02` | README normalizer tests (4 passed) | Remove when upstream contains equivalent provider-neutral normalization and tests. |
| Keep the lazy database-pool fixture scanner-safe | [#6410](https://github.com/block/buzz/pull/6410) `ed6b4056897a3ba509b3c1128db3c9cbc45a0517` | lazy read-pool test plus complete-credential-URI scan | Remove when upstream no longer stores the scanner-triggering complete literal and the lazy-pool behavior remains covered. |
| Add a backend-neutral Azure Blob object-store adapter | [#6412](https://github.com/block/buzz/pull/6412) `2d71753a595694d1e77b0d9147862fac3b512c45` | adapter unit/Azurite conformance, media and relay Git-store tests, formatting, and all-target clippy | Remove when upstream ships equivalent Azure media/Git semantics and startup conformance admission. |
| Make relay and push-gateway image namespaces fork-neutral | [#6413](https://github.com/block/buzz/pull/6413) `06ea44ceb469c60a65cbf190597253b1095794df` | workflow YAML parse, owner/override assertions, hard-coded gateway namespace scan | Remove when upstream derives both image/cache/attestation namespaces from the repository owner or explicit variables. |
| Separate canonical relay authentication authority from private transport | [#6414](https://github.com/block/buzz/pull/6414) `3a07c24e37320b5c1c78672ba9ba6df4eb01a99e` | `cargo test -p buzz-acp relay --locked` (94 passed), formatting | Remove when upstream preserves the canonical host for WebSocket, NIP-42, HTTP, and NIP-98 paths while dialing a private transport. |
| Make hosted ACP turns durable and observable | [#6417](https://github.com/block/buzz/pull/6417) `cdf766e704e3450a4516d87237c17b1382988831` | 13 local-publication tests, SDK fence test, 7 focused lifecycle tests, formatting, all-target clippy | Remove only when upstream provides equivalent fenced receipts, editable progress, terminal reconciliation, context, cancellation, retry, and error semantics as one turn lifecycle. |
| Publish a generic ACP agent-runtime image target | [#6418](https://github.com/block/buzz/pull/6418) `2f699f16a0e46e646604c5e04f9a2e17871e4464` | `docker buildx build --check --target agent-runtime .` (no warnings) | Remove when upstream publishes an equivalent unprivileged provider-neutral ACP base target. |

The durable-turn PR is intentionally cohesive: the local publication worker,
turn queue, process pool, error classification, and SDK fence tags share one
ordering and reconciliation state machine. The canonical-relay and container
image concerns remain separate PRs. Current upstream has adjacent ACP work,
including PRs #5181 and #5386, but neither was semantically equivalent at this
baseline and neither is used as an unmerged production dependency.

## Patch reproduction

For an existing single commit, generate a review artifact without rewriting
authorship:

```text
git format-patch -1 <commit> --stdout
```

For future candidates, compare the final logical change directly to the
recorded upstream baseline. A candidate is ready to publish only when its patch
contains one cohesive behavior, no Kiingo product names or endpoints, no
production credentials, and its focused tests pass on current upstream.

## Removal contract

When upstream ships equivalent behavior, delete the downstream hunk and its
inventory entry in the same upstream-sync PR. Verify semantics and regression
coverage before removal; matching names or similar prose are not sufficient.

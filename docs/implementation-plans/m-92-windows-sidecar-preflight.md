# M-92 — Windows Tauri Sidecar Preflight

Mesh issue: `M-92`

## Goal

Make every Justfile path that creates placeholder Tauri sidecars use the platform filename Tauri actually validates: `<binary>-<target>.exe` on Windows and `<binary>-<target>` elsewhere. Protect that contract with a focused test of the real recipes, without adding a new CI workflow, canary, compatibility path, or runtime behavior.

Every checkbox below is binding for this implementation. Check an item only after the implementation exists, its applicable targeted validation has passed, and the result has been inspected.

## Grounded evidence and decisions

- Current `Kiingo/buzz` main at `2561a3a649dd87af9877360df7bf8556d7a076bb` leaves the suffix off in both `_ensure-sidecar-stubs` and `desktop-release-build`.
- A disposable reproduction executed the exact `_ensure-sidecar-stubs` recipe body with host `x86_64-pc-windows-msvc`. It created five suffixless files and did not create `buzz-acp-x86_64-pc-windows-msvc.exe`.
- `desktop/src-tauri/tauri.conf.json` declares the corresponding `externalBin` names. The current Windows CI placeholder step and `scripts/bundle-sidecars.sh` both use the required `.exe` suffix, independently confirming the intended contract.
- Windows intentionally excludes `buzz-backend-kubernetes`; non-Windows targets include it. This platform-specific sidecar set must not change.
- No matching open or merged Buzz PR was found. The linked legacy `Kiingo/kiingo#11803` PR is unrelated implementation history and is already merged.
- This is developer/build tooling only. It has no running service or production deployment surface; merge to `main` is the complete delivery cutover.

## Binding implementation checklist

- [x] Update `_ensure-sidecar-stubs` so Windows hosts append `.exe` and non-Windows hosts remain suffixless, preserving the existing sidecar set on each platform.
- [x] Update `desktop-release-build` so an explicit Windows target uses the same `.exe` placeholder contract and non-Windows targets remain unchanged.
- [x] Add a focused shell contract test that executes both real Justfile recipes in disposable workspaces for representative Windows and non-Windows targets and asserts the exact filenames and platform-specific sidecar membership.
- [x] Wire the focused contract test into the existing `just check` gate without adding a workflow, smoke test, canary, feature flag, or unrelated CI/CD step.
- [x] Run and inspect the focused contract test, shell syntax validation, and Justfile parse validation.
- [x] Classify the three intentional Kiingo fork deltas in the existing fork inventory with accurate ownership and the smallest measured footprint budgets, then pass the exact fork-boundary checker.
- [x] Review the final diff skeptically against this plan and confirm there is no duplicated transitional behavior, deferred cleanup, or unrelated change.
- [x] Commit with DCO sign-off, push the dedicated branch, open a focused PR, and link the PR and corrected `Kiingo/buzz` repository metadata to M-92.
- [ ] Obtain green relevant hosted checks and merge the PR to `main`; no runtime deployment is applicable.
- [ ] Attach structured verification to M-92, mark it verified/resolved, and release every issue and path claim.

## Evidence ledger

- `just --unstable --fmt --check` is not a clean baseline gate: pinned `just 1.46.0` proposes a repository-wide rewrite of the pre-existing Justfile, including unrelated interpolation spacing and blank lines. This change does not absorb that unrelated formatter migration; parse validation and the executable focused contract cover the edited recipes instead.
- Local targeted validation passed: `bash -n scripts/test-sidecar-stub-contract.sh`, `just --summary`, `just sidecar-stub-contract-check`, and `git diff --check`. The contract test exercised the actual `_ensure-sidecar-stubs` and `desktop-release-build` recipes for `x86_64-pc-windows-msvc` and `x86_64-unknown-linux-gnu`, including exact sidecar membership and the release recipe's `pnpm` invocations.
- Skeptical review removed a GNU-only `find -printf` from the test so the existing macOS checks can run it. The final implementation has one hard-cutover behavior per recipe, preserves the established Windows/non-Windows sidecar sets, and adds no runtime, release workflow, compatibility, or deferred-cleanup path.
- Hosted CI run `35591289996` reached the existing Kiingo fork-boundary gate and reported exactly three missing classifications: `Justfile`, this plan, and `scripts/test-sidecar-stub-contract.sh`. The dependent desktop aggregator failures were consequences of that classification gate skipping its matrix, not product/test failures.
- The existing fork inventory now classifies the plan as downstream composition evidence and the generic Justfile/test changes under Buzz desktop ownership. Its modified-upstream-file budget rose only from 139 to the measured 140. `node scripts/check-kiingo-fork-boundary.mjs` passed with 237/237 divergent files classified, 140 modified upstream files, unchanged production-source budgets, 22 stable ownership boundaries, and zero Kiingo production contamination.
- Signed implementation commit `a92128559b5dd231edaa0536afa0947bbb0d9485` was pushed on `codex/m92-windows-sidecar-stubs`; [Kiingo/buzz#121](https://github.com/Kiingo/buzz/pull/121) is linked to M-92, whose repository, branch, and PR metadata now identify the actual implementation rather than the legacy mono reporting PR.

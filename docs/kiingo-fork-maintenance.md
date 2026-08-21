# Kiingo Buzz Fork Maintenance

Kiingo maintains `Kiingo/buzz` as a narrow Apache-2.0-compatible fork of
`block/buzz`. The fork keeps the upstream history intact so security fixes and
product changes can be merged without replaying Kiingo commits.

## Remote contract

```text
origin   git@github.com:Kiingo/buzz.git
upstream https://github.com/block/buzz.git
```

Verify the URLs before synchronizing. Add the `upstream` remote when it is
absent, fetch both remotes, and review the upstream diff before changing the
fork branch.

## Synchronization procedure

1. Start from a clean Kiingo worktree and a dedicated branch.
2. Run the read-only rehearsal described below and archive its JSON/Markdown
   report with the update PR.
3. Fetch `origin` and `upstream` without pruning or force-updating local work.
4. Merge `upstream/main` into the Kiingo branch. Do not rebase published Kiingo
   commits or force-push the shared branch.
5. Resolve conflicts by preserving upstream behavior unless a documented
   Kiingo production requirement intentionally differs.
6. Keep every commit DCO-compliant with `git commit -s` and retain upstream
   authorship and commit history.
7. Run the targeted checks required by the changed crates and deployment
   surfaces. For Rust changes this includes formatting plus the smallest
   relevant crate tests.
8. Re-run the boundary guard and rehearsal against the final reviewed commit.
9. Open or update the Kiingo pull request with the upstream commit merged,
   conflict decisions, exact checks, and any operational migration notes.
10. Merge through the normal protected-branch workflow. Production images must
   be built from the reviewed merge commit and pinned by digest.

## Read-only rehearsal

Run `node scripts/rehearse-upstream-sync.mjs --json <outside-worktree>.json
--markdown <outside-worktree>.md`. The script resolves the upstream branch with
`git ls-remote`, fetches only its exact object using `--no-write-fetch-head`,
and uses `git merge-tree`; it does not check out files, update the index, switch
branches, create commits, or move refs. It fails on merge conflicts, inventory
drift, or patch-budget regression and reports exact refs, conflicts, upstream
overlap, patch metrics, and the smallest relevant validation commands.

The scheduled/manual `Upstream sync rehearsal` workflow has read-only contents
permission, publishes both report forms, and runs only the fork boundary,
rehearsal fixtures, generic desktop seams, and durable progress tests. It never
opens a PR, pushes a branch, publishes an artifact to a release, or deploys.
Pull-request CI remains pinned to the inventory snapshot rather than a moving
upstream ref.

Run `node scripts/check-kiingo-fork-boundary.mjs` before pushing. Each upstream
integration PR records the exact reviewed commit in the inventory's
`upstreamSnapshot`. The guard requires that immutable snapshot to be an
ancestor of the fork, compares the final tree against it (not historical merge
noise), and verifies every divergent path against
`docs/kiingo-fork-inventory.json`. It also fetches and reports the live
`upstream/main` tip plus the number of commits landed after the snapshot. That
drift is informational for the next synchronization cycle: it must not make a
reviewed release retroactively fail merely because upstream changed while the
protected PR or post-merge CI was running.

The Kiingo CI file-size ratchet follows the same rule. Its downstream-owned
workflow seam reads `upstreamSnapshot` from the inventory, fetches that exact
commit, and exports it as `CHECK_FILE_SIZES_BASE`; it must never compare a
reviewed fork revision against the moving `upstream/main` ref. This keeps the
size discipline deterministic while the next synchronization cycle is pending.

Update `upstreamSnapshot` only in the same protected PR that incorporates that
exact commit. At the final pre-PR fetch, the snapshot must equal the then-live
upstream tip. If upstream advances afterward, keep the reviewed snapshot fixed,
record the reported drift, and merge the newer commits in the next dedicated
synchronization PR. Never move the snapshot ahead of the fork or edit it only
to make the guard pass.

The hard budgets are 22 modified upstream production-source files, 35 modified
upstream files overall, 1,913 changed upstream production-source lines, 202
upstream production-source diff hunks, and zero Kiingo business-logic lines in
upstream-owned production source.

The production-source metrics exclude dedicated `*.test.*`/`tests/` files and
Rust diffs whose every hunk is below the file's final `#[cfg(test)]` boundary.
The guard derives that classification from the current diff; it is not a path
waiver. This keeps scanner-only fixture changes from consuming the production
budgets while still counting their files in the overall 35-file limit. Changed
lines are additions plus deletions from `git diff --numstat`; hunk count is the
number of `@@` records in a zero-context final-tree diff. These two measurements
make a large embedded customization fail even when it does not add another
modified path.

The inventory is the deterministic patch ledger. Each group records purpose,
owner, upstream status, and removal condition. Add a path there only after
classifying it as `drop/upstream-present`, `move-to-kiingo`, `retain-generic`,
or `obsolete`; CI rejects both unclassified paths and stale entries.
Schema version 3 also records each intentionally tiny upstream-owned hook, its
downstream-added implementation files, its provider-neutral contract, and its
focused tests. The boundary guard rejects missing hook/implementation paths and
builds its forbidden Kiingo-content scanner from the inventory's explicit
pattern list.

## License and patch boundaries

- Preserve the root `LICENSE`, copyright statements, dependency notices,
  Apache-2.0 headers, and any `NOTICE` file upstream adds in the future.
- Keep Kiingo-specific Azure, identity, and bridge seams configurable. Avoid
  replacing portable upstream behavior when a backend interface or chart value
  can keep both paths supported.
- Prefer small upstreamable commits. Submit generally useful fixes upstream
  when practical, but never make production synchronization depend on upstream
  accepting a Kiingo-specific change.
- Retain provider-neutral security fixes when the current upstream tip still
  triggers a release-blocking scanner. Keep their focused regression tests and
  remove the downstream patches as soon as an equivalent upstream commit lands.
- Record intentional long-lived divergences in the Kiingo implementation plan
  and in the pull request that introduces them.

## Stable composition hooks

The last-mile isolation keeps upstream semantics beside upstream code while
moving concrete extension implementations into added files that upstream does
not own:

- `ProviderConfigFields.tsx` retains the upstream string-only renderer. Its
  stable hook delegates only schemas that declare bounded, typed, read-only, or
  `x-*` presentation to `ProviderConfigSchemaFields.tsx` and
  `providerConfigSchema.ts`. Provider IDs never appear in the renderer.
- `managed_agents/backend.rs` retains immutable staging and provider execution.
  Its stable hooks delegate filename normalization, platform search directories,
  and optional Windows signer verification to `provider_platform.rs`.
- `buzz-media/src/storage.rs` retains public media and S3/MinIO behavior. Azure
  SDK adaptation lives in `storage/azure.rs` and the existing
  `buzz-azure-storage` crate.
- `buzz-relay/src/api/git/store.rs` retains content addressing, digest checks,
  bounded reads, CAS classification, and conformance admission. Azure result
  translation lives in `store/azure.rs` and the same Azure adapter crate.
- `features/messages/hooks.ts` retains send orchestration. Its single generic
  recipient-resolution hook delegates restart-safe DM membership hydration and
  fail-closed recipient completeness to
  `extensions/messages/dmRecipientHydration.ts`; stream and complete-DM sends
  remain on the local fast path.
- `deep_link.rs`, `lib.rs`, and `AppShell.tsx` retain only provider-neutral
  registration calls for optional desktop extensions. The complete identity
  lifecycle, secret handling, coordinator client, relay continuity, journal,
  and dialog live under the added `extensions/identity_rotation` and
  `extensions/identity-rotation` trees. `managed_agents/backend.rs` exposes one
  generic caller-owned zeroizing provider-input seam; it contains no rotation,
  vendor, tenant, or coordinator policy.

Do not move upstream S3 or Git business semantics into downstream files merely
to make a line-count metric smaller. On upstream replay, preserve the one-call
hooks, accept upstream changes in the surrounding implementation, then run the
focused provider, media, Git, and boundary checks. The deterministic upstream
candidate and removal ledger is
`docs/kiingo-upstream-candidate-ledger-2026-08-11.md`.

## Recovery

If an upstream merge causes a regression, revert the merge or the smallest
identified follow-up commit through a new signed commit. Do not rewrite the
published fork history. Restore the last known-good digest in deployment
configuration while the forward fix is reviewed. Kiingo-owned desktop and
provider release workflows retain immutable version tags plus rolling aliases;
rollback moves the deployment or alias to the last reviewed immutable artifact
without replacing relay, PostgreSQL, Blob, agent identity, history, or memory
data.

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
2. Fetch `origin` and `upstream` without pruning or force-updating local work.
3. Merge `upstream/main` into the Kiingo branch. Do not rebase published Kiingo
   commits or force-push the shared branch.
4. Resolve conflicts by preserving upstream behavior unless a documented
   Kiingo production requirement intentionally differs.
5. Keep every commit DCO-compliant with `git commit -s` and retain upstream
   authorship and commit history.
6. Run the targeted checks required by the changed crates and deployment
   surfaces. For Rust changes this includes formatting plus the smallest
   relevant crate tests.
7. Open or update the Kiingo pull request with the upstream commit merged,
   conflict decisions, exact checks, and any operational migration notes.
8. Merge through the normal protected-branch workflow. Production images must
   be built from the reviewed merge commit and pinned by digest.

Run `node scripts/check-kiingo-fork-boundary.mjs` before pushing. The guard
requires the fetched `upstream/main` tip to be incorporated, compares the final
tree (not historical merge noise), and verifies every divergent path against
`docs/kiingo-fork-inventory.json`. Its hard budgets are 16 modified upstream
production-source files, 27 modified upstream files overall, 1,721 changed
upstream production-source lines, 170 upstream production-source diff hunks,
and zero Kiingo business-logic lines in upstream-owned production source.

The production-source metrics exclude dedicated `*.test.*`/`tests/` files and
Rust diffs whose every hunk is below the file's final `#[cfg(test)]` boundary.
The guard derives that classification from the current diff; it is not a path
waiver. This keeps scanner-only fixture changes from consuming the production
budgets while still counting their files in the overall 27-file limit. Changed
lines are additions plus deletions from `git diff --numstat`; hunk count is the
number of `@@` records in a zero-context final-tree diff. These two measurements
make a large embedded customization fail even when it does not add another
modified path.

The inventory is the deterministic patch ledger. Each group records purpose,
owner, upstream status, and removal condition. Add a path there only after
classifying it as `drop/upstream-present`, `move-to-kiingo`, `retain-generic`,
or `obsolete`; CI rejects both unclassified paths and stale entries.

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

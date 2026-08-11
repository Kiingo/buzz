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
`docs/kiingo-fork-inventory.json`. Its hard budgets are 15 modified upstream
production-source files, 25 modified upstream files overall, and zero Kiingo
business-logic lines in upstream-owned production source.

The production-source metric excludes dedicated `*.test.*`/`tests/` files and
Rust diffs whose every hunk is below the file's final `#[cfg(test)]` boundary.
The guard derives that classification from the current diff; it is not a path
waiver. This keeps scanner-only fixture changes from consuming the production
budget while still counting their files in the overall 25-file limit.

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

## Recovery

If an upstream merge causes a regression, revert the merge or the smallest
identified follow-up commit through a new signed commit. Do not rewrite the
published fork history. Restore the last known-good digest in deployment
configuration while the forward fix is reviewed. Kiingo-owned desktop and
provider release workflows retain immutable version tags plus rolling aliases;
rollback moves the deployment or alias to the last reviewed immutable artifact
without replacing relay, PostgreSQL, Blob, agent identity, history, or memory
data.

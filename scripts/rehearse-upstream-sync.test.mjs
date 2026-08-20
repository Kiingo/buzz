import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  rehearseUpstreamSync,
  renderMarkdown,
} from "./rehearse-upstream-sync.mjs";

const runGit = (repository, ...args) =>
  execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const write = (repository, path, content) =>
  writeFileSync(join(repository, path), content);

const fixture = ({ upstream, fork }) => {
  const parent = mkdtempSync(join(tmpdir(), "buzz-upstream-rehearsal-"));
  const repository = join(parent, "repository");
  execFileSync("git", ["init", "--initial-branch=main", repository]);
  runGit(repository, "config", "user.name", "Buzz Rehearsal");
  runGit(repository, "config", "user.email", "buzz-rehearsal@example.invalid");
  runGit(repository, "config", "core.autocrlf", "false");
  write(repository, "shared.txt", "base\n");
  write(repository, "rename-me.txt", "rename\n");
  runGit(repository, "add", ".");
  runGit(repository, "commit", "-m", "base");
  const base = runGit(repository, "rev-parse", "HEAD");

  runGit(repository, "switch", "-c", "upstream");
  upstream(repository);
  runGit(repository, "add", "-A");
  runGit(repository, "commit", "-m", "upstream");
  const upstreamSha = runGit(repository, "rev-parse", "HEAD");

  runGit(repository, "switch", "main");
  fork(repository);
  runGit(repository, "add", "-A");
  runGit(repository, "commit", "-m", "fork");
  const forkSha = runGit(repository, "rev-parse", "HEAD");
  const paths = runGit(repository, "diff", "--name-only", base, forkSha)
    .split(/\r?\n/)
    .filter(Boolean);
  const inventoryPath = join(parent, "inventory.json");
  writeFileSync(
    inventoryPath,
    JSON.stringify({
      schemaVersion: 3,
      upstreamRepository: "https://example.invalid/buzz.git",
      budgets: {
        modifiedUpstreamFiles: 100,
        modifiedUpstreamProductionSourceFiles: 100,
        changedUpstreamProductionSourceLines: 10000,
        upstreamProductionSourceDiffHunks: 1000,
      },
      deltas: [{ classification: "retain-generic", paths }],
    }),
  );
  return { parent, repository, inventoryPath, base, upstreamSha, forkSha };
};

const withFixture = (definition, assertion) => {
  const current = fixture(definition);
  try {
    const refsBefore = runGit(current.repository, "show-ref");
    const report = rehearseUpstreamSync({
      repositoryRoot: current.repository,
      baseRef: current.forkSha,
      upstreamSha: current.upstreamSha,
      inventoryPath: current.inventoryPath,
    });
    assertion(report, current);
    assert.equal(runGit(current.repository, "show-ref"), refsBefore);
    assert.equal(runGit(current.repository, "status", "--porcelain"), "");
    assert.match(renderMarkdown(report), /Upstream sync rehearsal/);
  } finally {
    rmSync(current.parent, { recursive: true, force: true });
  }
};

test("rehearses a clean merge with upstream rename and fork add without mutation", () => {
  withFixture(
    {
      upstream(repository) {
        runGit(repository, "mv", "rename-me.txt", "renamed-upstream.txt");
      },
      fork(repository) {
        write(repository, "fork-only.txt", "fork\n");
      },
    },
    (report) => {
      assert.equal(report.merge.status, "clean");
      assert.deepEqual(report.merge.conflictPaths, []);
      assert.equal(
        report.mutationCheck.workingTreeIndexBranchesAndRefsUnchanged,
        true,
      );
    },
  );
});

test("reports a content conflict deterministically", () => {
  withFixture(
    {
      upstream(repository) {
        write(repository, "shared.txt", "upstream\n");
      },
      fork(repository) {
        write(repository, "shared.txt", "fork\n");
      },
    },
    (report) => {
      assert.equal(report.merge.status, "conflicted");
      assert.deepEqual(report.merge.conflictPaths, ["shared.txt"]);
    },
  );
});

test("reports add/add and modify/delete conflict edges", async (t) => {
  await t.test("add/add", () =>
    withFixture(
      {
        upstream(repository) {
          write(repository, "same-new.txt", "upstream\n");
        },
        fork(repository) {
          write(repository, "same-new.txt", "fork\n");
        },
      },
      (report) => {
        assert.equal(report.merge.status, "conflicted");
        assert.deepEqual(report.merge.conflictPaths, ["same-new.txt"]);
      },
    ),
  );
  await t.test("modify/delete", () =>
    withFixture(
      {
        upstream(repository) {
          runGit(repository, "rm", "shared.txt");
        },
        fork(repository) {
          write(repository, "shared.txt", "fork edit\n");
        },
      },
      (report) => {
        assert.equal(report.merge.status, "conflicted");
        assert.deepEqual(report.merge.conflictPaths, ["shared.txt"]);
      },
    ),
  );
});

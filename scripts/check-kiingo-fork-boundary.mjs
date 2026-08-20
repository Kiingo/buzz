#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const inventoryPath = "docs/kiingo-fork-inventory.json";
const runGit = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const fail = (message) => {
  process.stderr.write(`[kiingo-fork-boundary] ${message}\n`);
  process.exit(1);
};

const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
if (inventory.schemaVersion !== 3) {
  fail(`unsupported inventory schema version ${inventory.schemaVersion}`);
}
const snapshotRef = process.env.BUZZ_UPSTREAM_REF || inventory.upstreamSnapshot;
const liveUpstreamRef =
  process.env.BUZZ_UPSTREAM_LIVE_REF ||
  inventory.upstreamReference ||
  "upstream/main";
if (!/^[a-f0-9]{40}$/.test(snapshotRef ?? "")) {
  fail(
    "inventory upstreamSnapshot must be an exact lowercase 40-character commit",
  );
}

try {
  runGit("rev-parse", "--verify", `${snapshotRef}^{commit}`);
} catch {
  fail(`missing frozen upstream snapshot ${snapshotRef}`);
}

try {
  execFileSync("git", ["merge-base", "--is-ancestor", snapshotRef, "HEAD"], {
    stdio: "ignore",
  });
} catch {
  fail(`frozen upstream snapshot ${snapshotRef} is not incorporated into HEAD`);
}

try {
  runGit("rev-parse", "--verify", `${liveUpstreamRef}^{commit}`);
} catch {
  fail(`missing live upstream reference ${liveUpstreamRef}`);
}
try {
  execFileSync(
    "git",
    ["merge-base", "--is-ancestor", snapshotRef, liveUpstreamRef],
    {
      stdio: "ignore",
    },
  );
} catch {
  fail(
    `live upstream reference ${liveUpstreamRef} no longer descends from frozen snapshot`,
  );
}
const liveUpstreamTip = runGit("rev-parse", liveUpstreamRef);
const upstreamCommitsAfterSnapshot = Number(
  runGit("rev-list", "--count", `${snapshotRef}..${liveUpstreamRef}`),
);
const entries = inventory.deltas.flatMap((delta) =>
  delta.paths.map((path) => ({ path, classification: delta.classification })),
);
const inventoryPaths = new Set(entries.map((entry) => entry.path));
if (inventoryPaths.size !== entries.length) {
  fail("inventory contains duplicate paths");
}
const allowedClassifications = new Set([
  "drop/upstream-present",
  "move-to-kiingo",
  "retain-generic",
  "obsolete",
]);
for (const entry of entries) {
  if (!allowedClassifications.has(entry.classification)) {
    fail(`invalid classification for ${entry.path}: ${entry.classification}`);
  }
}
if (
  !Array.isArray(inventory.ownershipBoundaries) ||
  inventory.ownershipBoundaries.length === 0
) {
  fail("inventory must declare at least one stable ownership boundary");
}
const boundaryHooks = new Set();
for (const boundary of inventory.ownershipBoundaries) {
  if (
    !boundary ||
    typeof boundary !== "object" ||
    typeof boundary.hook !== "string" ||
    !boundary.hook ||
    typeof boundary.contract !== "string" ||
    !boundary.contract ||
    !Array.isArray(boundary.implementations) ||
    boundary.implementations.length === 0 ||
    !Array.isArray(boundary.focusedTests) ||
    boundary.focusedTests.length === 0
  ) {
    fail(
      "each ownership boundary requires a hook, contract, implementations, and focused tests",
    );
  }
  if (boundaryHooks.has(boundary.hook))
    fail(`duplicate ownership hook ${boundary.hook}`);
  boundaryHooks.add(boundary.hook);
  for (const path of [boundary.hook, ...boundary.implementations]) {
    if (!inventoryPaths.has(path))
      fail(`ownership boundary path is absent from delta inventory: ${path}`);
  }
}

const trackedChanges = runGit("diff", "--name-status", snapshotRef)
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const [status, ...parts] = line.split("\t");
    return { status, path: parts.at(-1) };
  });
const trackedPaths = new Set(trackedChanges.map((change) => change.path));
const untracked = runGit("ls-files", "--others", "--exclude-standard")
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((path) => !trackedPaths.has(path))
  .map((path) => ({ status: "A", path }));
const changes = [...trackedChanges, ...untracked];
const changedPaths = new Set(changes.map((change) => change.path));
const missingInventory = [...changedPaths].filter(
  (path) => !inventoryPaths.has(path),
);
const staleInventory = [...inventoryPaths].filter(
  (path) => !changedPaths.has(path),
);
if (missingInventory.length || staleInventory.length) {
  fail(
    `inventory drift; missing=[${missingInventory.join(", ")}] stale=[${staleInventory.join(", ")}]`,
  );
}

const modified = changes.filter((change) => change.status.startsWith("M"));
const productionSourcePattern =
  /^(?:crates|desktop|web|mobile)\/.+\.(?:rs|ts|tsx|js|jsx|mjs|cjs)$/;
const dedicatedTestSourcePattern =
  /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\./;
const rustDiffIsConfinedToCfgTestModule = (path) => {
  if (!path.endsWith(".rs")) return false;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const cfgTestLine = lines.findLastIndex((line) =>
    /^\s*#\[cfg\(test\)\]/.test(line),
  );
  if (cfgTestLine < 0) return false;
  const hunkStarts = runGit("diff", "--unified=0", snapshotRef, "--", path)
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      return match ? [Number(match[1])] : [];
    });
  return (
    hunkStarts.length > 0 && hunkStarts.every((line) => line > cfgTestLine + 1)
  );
};
const modifiedProduction = modified.filter(
  (change) =>
    productionSourcePattern.test(change.path) &&
    !dedicatedTestSourcePattern.test(change.path) &&
    !rustDiffIsConfinedToCfgTestModule(change.path),
);
const productionSourceDiffMetrics = modifiedProduction.reduce(
  (metrics, change) => {
    const numstat = runGit("diff", "--numstat", snapshotRef, "--", change.path)
      .split(/\r?\n/)
      .filter(Boolean);
    for (const line of numstat) {
      const [added, deleted] = line.split("\t");
      const additions = Number(added);
      const deletions = Number(deleted);
      if (Number.isFinite(additions)) metrics.changedLines += additions;
      if (Number.isFinite(deletions)) metrics.changedLines += deletions;
    }
    metrics.hunks += runGit(
      "diff",
      "--unified=0",
      snapshotRef,
      "--",
      change.path,
    )
      .split(/\r?\n/)
      .filter((line) => line.startsWith("@@ ")).length;
    return metrics;
  },
  { changedLines: 0, hunks: 0 },
);
if (modified.length > inventory.budgets.modifiedUpstreamFiles) {
  fail(`modified upstream file budget exceeded: ${modified.length}`);
}
if (
  modifiedProduction.length >
  inventory.budgets.modifiedUpstreamProductionSourceFiles
) {
  fail(
    `modified upstream production-source budget exceeded: ${modifiedProduction.length}`,
  );
}
if (
  productionSourceDiffMetrics.changedLines >
  inventory.budgets.changedUpstreamProductionSourceLines
) {
  fail(
    `changed upstream production-source line budget exceeded: ${productionSourceDiffMetrics.changedLines}`,
  );
}
if (
  productionSourceDiffMetrics.hunks >
  inventory.budgets.upstreamProductionSourceDiffHunks
) {
  fail(
    `upstream production-source diff-hunk budget exceeded: ${productionSourceDiffMetrics.hunks}`,
  );
}

if (
  !Array.isArray(inventory.forbiddenUpstreamProductionPatterns) ||
  inventory.forbiddenUpstreamProductionPatterns.length === 0
) {
  fail("inventory must declare forbidden upstream production patterns");
}
let forbidden;
try {
  forbidden = new RegExp(
    inventory.forbiddenUpstreamProductionPatterns
      .map((pattern) => `(?:${pattern})`)
      .join("|"),
    "i",
  );
} catch (error) {
  fail(`invalid forbidden upstream production pattern: ${error.message}`);
}
const contaminated = [];
for (const change of modifiedProduction) {
  const source = readFileSync(change.path, "utf8");
  if (forbidden.test(source)) contaminated.push(change.path);
}
if (contaminated.length) {
  fail(
    `Kiingo business logic found in upstream-owned production source: ${contaminated.join(", ")}`,
  );
}

process.stdout.write(
  `${JSON.stringify({
    upstreamSnapshot: snapshotRef,
    liveUpstreamRef,
    liveUpstreamTip,
    upstreamCommitsAfterSnapshot,
    divergentFiles: changes.length,
    modifiedUpstreamFiles: modified.length,
    modifiedUpstreamProductionSourceFiles: modifiedProduction.length,
    changedUpstreamProductionSourceLines:
      productionSourceDiffMetrics.changedLines,
    upstreamProductionSourceDiffHunks: productionSourceDiffMetrics.hunks,
    classifiedFiles: inventoryPaths.size,
    stableOwnershipBoundaries: inventory.ownershipBoundaries.length,
    kiingoProductionContamination: 0,
  })}\n`,
);

#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const upstreamRef = process.env.BUZZ_UPSTREAM_REF || 'upstream/main';
const inventoryPath = 'docs/kiingo-fork-inventory.json';
const runGit = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fail = (message) => {
  process.stderr.write(`[kiingo-fork-boundary] ${message}\n`);
  process.exit(1);
};

try {
  runGit('rev-parse', '--verify', `${upstreamRef}^{commit}`);
} catch {
  fail(`missing upstream reference ${upstreamRef}`);
}

try {
  execFileSync('git', ['merge-base', '--is-ancestor', upstreamRef, 'HEAD'], {
    stdio: 'ignore'
  });
} catch {
  fail(`${upstreamRef} is not incorporated into HEAD; merge current upstream first`);
}

const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
const entries = inventory.deltas.flatMap((delta) =>
  delta.paths.map((path) => ({ path, classification: delta.classification }))
);
const inventoryPaths = new Set(entries.map((entry) => entry.path));
if (inventoryPaths.size !== entries.length) {
  fail('inventory contains duplicate paths');
}
const allowedClassifications = new Set([
  'drop/upstream-present',
  'move-to-kiingo',
  'retain-generic',
  'obsolete'
]);
for (const entry of entries) {
  if (!allowedClassifications.has(entry.classification)) {
    fail(`invalid classification for ${entry.path}: ${entry.classification}`);
  }
}

const trackedChanges = runGit('diff', '--name-status', upstreamRef)
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const [status, ...parts] = line.split('\t');
    return { status, path: parts.at(-1) };
  });
const trackedPaths = new Set(trackedChanges.map((change) => change.path));
const untracked = runGit('ls-files', '--others', '--exclude-standard')
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((path) => !trackedPaths.has(path))
  .map((path) => ({ status: 'A', path }));
const changes = [...trackedChanges, ...untracked];
const changedPaths = new Set(changes.map((change) => change.path));
const missingInventory = [...changedPaths].filter((path) => !inventoryPaths.has(path));
const staleInventory = [...inventoryPaths].filter((path) => !changedPaths.has(path));
if (missingInventory.length || staleInventory.length) {
  fail(
    `inventory drift; missing=[${missingInventory.join(', ')}] stale=[${staleInventory.join(', ')}]`
  );
}

const modified = changes.filter((change) => change.status.startsWith('M'));
const productionSourcePattern = /^(?:crates|desktop|web|mobile)\/.+\.(?:rs|ts|tsx|js|jsx|mjs|cjs)$/;
const dedicatedTestSourcePattern = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\./;
const rustDiffIsConfinedToCfgTestModule = (path) => {
  if (!path.endsWith('.rs')) return false;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const cfgTestLine = lines.findLastIndex((line) => /^\s*#\[cfg\(test\)\]/.test(line));
  if (cfgTestLine < 0) return false;
  const hunkStarts = runGit('diff', '--unified=0', upstreamRef, '--', path)
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      return match ? [Number(match[1])] : [];
    });
  return hunkStarts.length > 0 && hunkStarts.every((line) => line > cfgTestLine + 1);
};
const modifiedProduction = modified.filter((change) =>
  productionSourcePattern.test(change.path) &&
  !dedicatedTestSourcePattern.test(change.path) &&
  !rustDiffIsConfinedToCfgTestModule(change.path)
);
if (modified.length > inventory.budgets.modifiedUpstreamFiles) {
  fail(`modified upstream file budget exceeded: ${modified.length}`);
}
if (
  modifiedProduction.length >
  inventory.budgets.modifiedUpstreamProductionSourceFiles
) {
  fail(`modified upstream production-source budget exceeded: ${modifiedProduction.length}`);
}

const forbidden = /\bkiingo\b|chat\.kiingo\.com|api\.kiingo\.com|dashboard\.kiingo\.com|harness connections/i;
const contaminated = [];
for (const change of modifiedProduction) {
  const source = readFileSync(change.path, 'utf8');
  if (forbidden.test(source)) contaminated.push(change.path);
}
if (contaminated.length) {
  fail(`Kiingo business logic found in upstream-owned production source: ${contaminated.join(', ')}`);
}

process.stdout.write(
  `${JSON.stringify({
    upstreamRef,
    divergentFiles: changes.length,
    modifiedUpstreamFiles: modified.length,
    modifiedUpstreamProductionSourceFiles: modifiedProduction.length,
    classifiedFiles: inventoryPaths.size,
    kiingoProductionContamination: 0
  })}\n`
);

#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = resolve(scriptDirectory, "..");

const git = (repositoryRoot, args, { allowFailure = false } = {}) => {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result;
};

const gitText = (repositoryRoot, args) =>
  git(repositoryRoot, args).stdout.trim();
const exactCommit = (repositoryRoot, value, label) => {
  const sha = gitText(repositoryRoot, [
    "rev-parse",
    "--verify",
    `${value}^{commit}`,
  ]);
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error(`${label} did not resolve to an exact commit`);
  return sha;
};

const remoteCommit = (repositoryRoot, url, ref) => {
  const result = git(repositoryRoot, ["ls-remote", "--exit-code", url, ref]);
  const matches = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (matches.length !== 1)
    throw new Error(
      `upstream ref ${ref} resolved to ${matches.length} commits`,
    );
  const sha = matches[0].split(/\s+/)[0];
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error(`upstream ref ${ref} did not resolve to an exact commit`);
  git(repositoryRoot, [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    url,
    sha,
  ]);
  return exactCommit(repositoryRoot, sha, "fetched upstream ref");
};

const splitLines = (value) => value.split(/\r?\n/).filter(Boolean);
const parseNameStatus = (value) =>
  splitLines(value).map((line) => {
    const [status, ...paths] = line.split("\t");
    return {
      status,
      path: paths.at(-1),
      sourcePath: paths.length > 1 ? paths[0] : null,
    };
  });

const productionSourcePattern =
  /^(?:crates|desktop|web|mobile)\/.+\.(?:rs|ts|tsx|js|jsx|mjs|cjs)$/;
const dedicatedTestSourcePattern =
  /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.|(?:^|\/)[^/]+_tests\.rs$/;

const rustDiffIsConfinedToCfgTestModule = (
  repositoryRoot,
  upstreamSha,
  baseSha,
  path,
) => {
  if (!path.endsWith(".rs")) return false;
  const source = git(repositoryRoot, ["show", `${baseSha}:${path}`], {
    allowFailure: true,
  });
  if (source.status !== 0) return false;
  const lines = source.stdout.split(/\r?\n/);
  const cfgTestLine = lines.findLastIndex((line) =>
    /^\s*#\[cfg\(test\)\]/.test(line),
  );
  if (cfgTestLine < 0) return false;
  const diff = gitText(repositoryRoot, [
    "diff",
    "--unified=0",
    upstreamSha,
    baseSha,
    "--",
    path,
  ]);
  const hunkStarts = splitLines(diff).flatMap((line) => {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    return match ? [Number(match[1])] : [];
  });
  return (
    hunkStarts.length > 0 && hunkStarts.every((line) => line > cfgTestLine + 1)
  );
};

const patchSurface = (repositoryRoot, upstreamSha, baseSha, inventory) => {
  const changes = parseNameStatus(
    gitText(repositoryRoot, ["diff", "--name-status", upstreamSha, baseSha]),
  );
  const modified = changes.filter(({ status }) => status.startsWith("M"));
  const modifiedProduction = modified.filter(
    ({ path }) =>
      productionSourcePattern.test(path) &&
      !dedicatedTestSourcePattern.test(path) &&
      !rustDiffIsConfinedToCfgTestModule(
        repositoryRoot,
        upstreamSha,
        baseSha,
        path,
      ),
  );
  const metrics = modifiedProduction.reduce(
    (result, { path }) => {
      for (const line of splitLines(
        gitText(repositoryRoot, [
          "diff",
          "--numstat",
          upstreamSha,
          baseSha,
          "--",
          path,
        ]),
      )) {
        const [added, deleted] = line.split("\t").map(Number);
        if (Number.isFinite(added)) result.changedLines += added;
        if (Number.isFinite(deleted)) result.changedLines += deleted;
      }
      result.hunks += splitLines(
        gitText(repositoryRoot, [
          "diff",
          "--unified=0",
          upstreamSha,
          baseSha,
          "--",
          path,
        ]),
      ).filter((line) => line.startsWith("@@ ")).length;
      return result;
    },
    { changedLines: 0, hunks: 0 },
  );
  const inventoryPaths = new Set(
    inventory.deltas.flatMap((delta) => delta.paths),
  );
  const changedPaths = new Set(changes.map(({ path }) => path));
  const observed = {
    divergentFiles: changes.length,
    addedFiles: changes.filter(({ status }) => status.startsWith("A")).length,
    deletedFiles: changes.filter(({ status }) => status.startsWith("D")).length,
    modifiedUpstreamFiles: modified.length,
    modifiedUpstreamProductionSourceFiles: modifiedProduction.length,
    changedUpstreamProductionSourceLines: metrics.changedLines,
    upstreamProductionSourceDiffHunks: metrics.hunks,
  };
  return {
    ...observed,
    paths: changes.map(({ path }) => path).sort(),
    unclassifiedPaths: [...changedPaths]
      .filter((path) => !inventoryPaths.has(path))
      .sort(),
    staleInventoryPaths: [...inventoryPaths]
      .filter((path) => !changedPaths.has(path))
      .sort(),
    budgets: Object.fromEntries(
      [
        ["modifiedUpstreamFiles", observed.modifiedUpstreamFiles],
        [
          "modifiedUpstreamProductionSourceFiles",
          observed.modifiedUpstreamProductionSourceFiles,
        ],
        [
          "changedUpstreamProductionSourceLines",
          observed.changedUpstreamProductionSourceLines,
        ],
        [
          "upstreamProductionSourceDiffHunks",
          observed.upstreamProductionSourceDiffHunks,
        ],
      ].map(([name, value]) => [
        name,
        {
          value,
          limit: inventory.budgets[name],
          withinBudget: value <= inventory.budgets[name],
        },
      ]),
    ),
  };
};

const focusedChecks = (overlapPaths) => {
  const commands = ["node scripts/check-kiingo-fork-boundary.mjs"];
  if (
    overlapPaths.some((path) => path.startsWith("desktop/src/features/agents/"))
  ) {
    commands.push(
      "cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/agents/ui/ProviderConfigFields.test.mjs src/features/agents/ui/agentDefinitionExecutionReadiness.test.mjs",
    );
  }
  if (
    overlapPaths.some(
      (path) =>
        path.includes("local_publication") ||
        path.startsWith("crates/buzz-acp/"),
    )
  ) {
    commands.push("cargo test -p buzz-acp local_publication --locked");
  }
  if (
    overlapPaths.some(
      (path) =>
        path.includes("dmRecipientHydration") ||
        path.endsWith("features/messages/hooks.ts"),
    )
  ) {
    commands.push(
      "cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/extensions/messages/dmRecipientHydration.test.mjs",
    );
  }
  return commands;
};

export function renderMarkdown(report) {
  const list = (values) =>
    values.length
      ? values.map((value) => `- \`${value}\``).join("\n")
      : "- None";
  return (
    `# Upstream sync rehearsal\n\n` +
    `- Result: **${report.merge.status}**\n` +
    `- Fork commit: \`${report.refs.base}\`\n` +
    `- Upstream commit: \`${report.refs.upstream}\`\n` +
    `- Merge base: \`${report.refs.mergeBase}\`\n` +
    `- Divergent files: ${report.patchSurface.divergentFiles}\n` +
    `- Upstream changes since merge base: ${report.upstreamChangedPaths.length}\n` +
    `- Overlap files: ${report.overlapPaths.length}\n\n` +
    `## Conflicts\n\n${list(report.merge.conflictPaths)}\n\n` +
    `## Upstream/fork overlap\n\n${list(report.overlapPaths)}\n\n` +
    `## Inventory drift\n\n### Unclassified\n\n${list(report.patchSurface.unclassifiedPaths)}\n\n### Stale\n\n${list(report.patchSurface.staleInventoryPaths)}\n\n` +
    `## Patch budgets\n\n${Object.entries(report.patchSurface.budgets)
      .map(
        ([name, value]) =>
          `- ${name}: ${value.value}/${value.limit} (${value.withinBudget ? "within" : "exceeded"})`,
      )
      .join("\n")}\n\n` +
    `## Suggested focused validation\n\n${report.suggestedFocusedChecks.map((value) => `- \`${value}\``).join("\n")}\n`
  );
}

export function rehearseUpstreamSync({
  repositoryRoot = defaultRepositoryRoot,
  baseRef = "HEAD",
  upstreamSha,
  upstreamUrl,
  upstreamRef = "refs/heads/main",
  inventoryPath = resolve(repositoryRoot, "docs", "kiingo-fork-inventory.json"),
}) {
  const before = {
    refs: gitText(repositoryRoot, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]),
    branch: gitText(repositoryRoot, ["symbolic-ref", "-q", "HEAD"]),
    status: gitText(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=no",
    ]),
  };
  const base = exactCommit(repositoryRoot, baseRef, "base ref");
  const upstream = upstreamSha
    ? exactCommit(repositoryRoot, upstreamSha, "upstream commit")
    : remoteCommit(repositoryRoot, upstreamUrl, upstreamRef);
  const mergeBase = exactCommit(
    repositoryRoot,
    gitText(repositoryRoot, ["merge-base", base, upstream]),
    "merge base",
  );
  const merge = git(
    repositoryRoot,
    [
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      base,
      upstream,
    ],
    { allowFailure: true },
  );
  if (![0, 1].includes(merge.status))
    throw new Error(`git merge-tree failed: ${merge.stderr.trim()}`);
  const mergeLines = splitLines(merge.stdout);
  const mergeTree = mergeLines[0];
  if (!/^[a-f0-9]{40}$/.test(mergeTree ?? ""))
    throw new Error("git merge-tree did not return a merge tree object");
  const conflictPaths = merge.status === 1 ? mergeLines.slice(1).sort() : [];
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const surface = patchSurface(repositoryRoot, upstream, mergeTree, inventory);
  const upstreamChangedPaths = splitLines(
    gitText(repositoryRoot, ["diff", "--name-only", mergeBase, upstream]),
  ).sort();
  const forkChangedPaths = splitLines(
    gitText(repositoryRoot, ["diff", "--name-only", mergeBase, base]),
  ).sort();
  const upstreamChangedSet = new Set(upstreamChangedPaths);
  const overlapPaths = forkChangedPaths.filter((path) =>
    upstreamChangedSet.has(path),
  );
  const after = {
    refs: gitText(repositoryRoot, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]),
    branch: gitText(repositoryRoot, ["symbolic-ref", "-q", "HEAD"]),
    status: gitText(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=no",
    ]),
  };
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(
      "upstream rehearsal mutated the working tree, index, branch, or refs",
    );
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    refs: { base, upstream, mergeBase },
    merge: {
      status: merge.status === 0 ? "clean" : "conflicted",
      tree: mergeTree,
      conflictPaths,
    },
    upstreamChangedPaths,
    forkChangedPaths,
    overlapPaths,
    patchSurface: surface,
    suggestedFocusedChecks: focusedChecks(overlapPaths),
    mutationCheck: { workingTreeIndexBranchesAndRefsUnchanged: true },
  };
}

const parseArguments = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--"))
      throw new Error(`unknown argument ${argument}`);
    const name = argument.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`missing value for ${argument}`);
    options[name] = value;
    index += 1;
  }
  return options;
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const repositoryRoot = resolve(
      options.repository_root ?? defaultRepositoryRoot,
    );
    const inventoryPath = options.inventory
      ? resolve(repositoryRoot, options.inventory)
      : resolve(repositoryRoot, "docs", "kiingo-fork-inventory.json");
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    const report = rehearseUpstreamSync({
      repositoryRoot,
      baseRef: options.base ?? "HEAD",
      upstreamSha: options.upstream_sha,
      upstreamUrl: options.upstream_url ?? inventory.upstreamRepository,
      upstreamRef: options.upstream_ref ?? "refs/heads/main",
      inventoryPath,
    });
    if (options.json) {
      mkdirSync(dirname(resolve(options.json)), { recursive: true });
      writeFileSync(
        resolve(options.json),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
    if (options.markdown) {
      mkdirSync(dirname(resolve(options.markdown)), { recursive: true });
      writeFileSync(resolve(options.markdown), renderMarkdown(report));
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.merge.status !== "clean") process.exitCode = 2;
    else if (
      report.patchSurface.unclassifiedPaths.length ||
      report.patchSurface.staleInventoryPaths.length
    )
      process.exitCode = 3;
    else if (
      Object.values(report.patchSurface.budgets).some(
        ({ withinBudget }) => !withinBudget,
      )
    )
      process.exitCode = 4;
  } catch (error) {
    process.stderr.write(
      `[upstream-sync-rehearsal] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

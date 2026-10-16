#!/usr/bin/env node

// Static migration-ledger guard for the Kiingo fork. No database, no tests.
//
// sqlx keys migrations by the integer filename prefix and checksums the file
// bytes (SHA-384). The fork shipped its own 0041-0045 to production before
// upstream used those numbers, so upstream migrations above
// `migrationLedger.identityThroughVersion` are renamed byte for byte into the
// next free fork versions. A plain `git merge` of a later upstream batch would
// silently add a second file for an existing version (sqlx 0.9 accepts that at
// compile time; production then fails with VersionMismatch). This check makes
// that, and any drift between the recorded ledger and the bytes on disk, fail.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const inventoryPath = "docs/kiingo-fork-inventory.json";
const migrationsDir = "migrations";
const errors = [];
const fail = (message) => errors.push(message);
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
const sha384 = (bytes) => createHash("sha384").update(bytes).digest("hex");
const versionOf = (path) => {
  const match = /^(?:.*\/)?(\d+)_[^/]+\.sql$/.exec(path);
  return match ? Number(match[1]) : null;
};

const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
const ledger = inventory.migrationLedger;
const snapshot = process.env.BUZZ_UPSTREAM_REF || inventory.upstreamSnapshot;
if (!ledger || typeof ledger !== "object") {
  process.stderr.write("[kiingo-migration-ledger] inventory has no migrationLedger\n");
  process.exit(1);
}
const { identityThroughVersion, lastProductionVersion, entries } = ledger;
if (!Number.isInteger(identityThroughVersion) || !Number.isInteger(lastProductionVersion)) {
  fail("migrationLedger needs integer identityThroughVersion and lastProductionVersion");
}
if (!Array.isArray(entries) || entries.length === 0) {
  fail("migrationLedger.entries must be a non-empty array");
}

// (i) No two files on disk share a version prefix; every file is versioned.
const onDisk = readdirSync(migrationsDir)
  .filter((name) => statSync(join(migrationsDir, name)).isFile())
  .map((name) => `${migrationsDir}/${name}`);
const byVersion = new Map();
for (const path of onDisk) {
  const version = versionOf(path);
  if (version === null) {
    fail(`unversioned file in migrations/: ${path}`);
    continue;
  }
  byVersion.set(version, [...(byVersion.get(version) ?? []), path]);
}
for (const [version, paths] of byVersion) {
  if (paths.length > 1) fail(`duplicate migration version ${version}: ${paths.join(", ")}`);
}

// Upstream snapshot migrations.
const upstreamPaths = git("ls-tree", "--name-only", `${snapshot}:${migrationsDir}`)
  .toString("utf8")
  .split(/\r?\n/)
  .filter((name) => name.endsWith(".sql"))
  .map((name) => `${migrationsDir}/${name}`);
const upstreamBytes = (path) => git("show", `${snapshot}:${path}`);

// Ledger shape: ascending versions, version matches the fork filename.
const seenForkPaths = new Set();
const mappedUpstream = new Map();
let previousVersion = identityThroughVersion;
for (const [index, entry] of (entries ?? []).entries()) {
  const where = `migrationLedger.entries[${index}]`;
  if (!entry || typeof entry.forkPath !== "string" || !/^[a-f0-9]{96}$/.test(entry.sha384 ?? "")) {
    fail(`${where} needs forkPath and a 96-hex-character sha384`);
    continue;
  }
  const version = versionOf(entry.forkPath);
  if (version !== entry.version) {
    fail(`${where} version ${entry.version} does not match ${entry.forkPath}`);
  }
  // (vi) Ledger order is version order with no gaps above the identity range.
  if (entry.version !== previousVersion + 1) {
    fail(`${where} version ${entry.version} must follow ${previousVersion} (apply order, no gaps)`);
  }
  previousVersion = entry.version;
  if (seenForkPaths.has(entry.forkPath)) fail(`${where} repeats ${entry.forkPath}`);
  seenForkPaths.add(entry.forkPath);
  if (!existsSync(entry.forkPath)) {
    fail(`${where} ${entry.forkPath} is missing on disk`);
    continue;
  }
  const actual = sha384(readFileSync(entry.forkPath));
  // (v) Recorded checksums never drift; fork-owned production versions are frozen.
  if (actual !== entry.sha384) {
    fail(`${where} ${entry.forkPath} sha384 ${actual} differs from recorded ${entry.sha384}`);
  }
  if (entry.owner === "kiingo") {
    if (entry.upstreamPath !== undefined) fail(`${where} kiingo-owned entry must not map an upstream path`);
    if (entry.version <= lastProductionVersion && entry.appliedInProduction !== true) {
      fail(`${where} is at or below lastProductionVersion but not marked appliedInProduction`);
    }
  } else if (entry.owner === "upstream") {
    if (typeof entry.upstreamPath !== "string") {
      fail(`${where} upstream entry needs upstreamPath`);
      continue;
    }
    if (mappedUpstream.has(entry.upstreamPath)) fail(`${where} maps ${entry.upstreamPath} twice`);
    mappedUpstream.set(entry.upstreamPath, entry.forkPath);
    // (iii) A mapped file is byte-identical to the frozen upstream snapshot.
    let expected;
    try {
      expected = sha384(upstreamBytes(entry.upstreamPath));
    } catch {
      fail(`${where} ${entry.upstreamPath} does not exist at upstream snapshot ${snapshot}`);
      continue;
    }
    if (expected !== actual) {
      fail(`${where} ${entry.forkPath} is not byte-identical to ${snapshot}:${entry.upstreamPath}`);
    }
    if (entry.upstreamPath.slice(migrationsDir.length + 1).replace(/^\d+_/, "") !==
        entry.forkPath.slice(migrationsDir.length + 1).replace(/^\d+_/, "")) {
      fail(`${where} renamed ${entry.upstreamPath} to a different description (${entry.forkPath})`);
    }
  } else {
    fail(`${where} owner must be "kiingo" or "upstream"`);
  }
}
if (lastProductionVersion > previousVersion) {
  fail(`lastProductionVersion ${lastProductionVersion} exceeds the ledger (${previousVersion})`);
}

// (iv) Every upstream snapshot migration is either an unchanged identity file
// at or below identityThroughVersion, or mapped exactly once.
for (const path of upstreamPaths) {
  const version = versionOf(path);
  if (version !== null && version <= identityThroughVersion) {
    if (!existsSync(path)) {
      fail(`upstream identity migration ${path} is missing`);
    } else if (sha384(readFileSync(path)) !== sha384(upstreamBytes(path))) {
      fail(`upstream identity migration ${path} differs from ${snapshot}`);
    }
  } else if (!mappedUpstream.has(path)) {
    fail(`upstream migration ${path} (snapshot ${snapshot}) is not mapped in migrationLedger`);
  }
}
for (const path of mappedUpstream.keys()) {
  if (!upstreamPaths.includes(path)) fail(`ledger maps ${path}, which upstream snapshot lacks`);
}

// (ii) Every file on disk is an identity upstream file or a ledger entry.
for (const path of onDisk) {
  const version = versionOf(path);
  if (version === null) continue;
  if (version <= identityThroughVersion) {
    if (!upstreamPaths.includes(path)) fail(`${path} is at or below version ${identityThroughVersion} but not an upstream identity file`);
  } else if (!seenForkPaths.has(path)) {
    fail(`${path} is neither fork-owned nor mapped in migrationLedger`);
  }
}
for (let version = 1; version <= previousVersion; version += 1) {
  if (!byVersion.has(version)) fail(`migration version ${version} is missing on disk`);
}

// (vii) Every include_str!/include_bytes! of a migration resolves.
const rustFiles = git("ls-files", "-z", "--", "*.rs")
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const includePattern = /include_(?:str|bytes)!\(\s*"([^"]*migrations\/[^"]+\.sql)"\s*\)/g;
for (const file of rustFiles) {
  if (!existsSync(file)) continue;
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(includePattern)) {
    const target = resolve(dirname(file), match[1]);
    if (!existsSync(target)) fail(`${file} includes missing migration ${match[1]}`);
  }
}

if (errors.length) {
  for (const message of errors) process.stderr.write(`[kiingo-migration-ledger] ${message}\n`);
  process.exit(1);
}
process.stdout.write(
  `${JSON.stringify({
    migrationLedger: "ok",
    upstreamSnapshot: snapshot,
    migrations: onDisk.length,
    highestVersion: previousVersion,
    lastProductionVersion,
    forkOwned: entries.filter((entry) => entry.owner === "kiingo").length,
    upstreamMapped: mappedUpstream.size,
  })}\n`,
);

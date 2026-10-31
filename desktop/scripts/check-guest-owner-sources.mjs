import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Guards the guest-access owner-only data sources in CI (Kiingo 79
// SHOULD-BUZZ-SOURCES-PIN-NOT-IN-CI). Kiingo/kiingo owns the list
// (BUZZ_GUEST_OWNER_ONLY_SOURCES); desktop lib/copy.ts and mobile
// guest_owner_copy.dart mirror it, and accessTabs.test.mjs pins its sha256.
// This runs in `pnpm check` (CI "Desktop lint and format", which Kiingo/buzz
// runs on its self-hosted lane even though it skips tests): both copies must
// match each other and the pinned digest. Kiingo/kiingo is private, so the
// cross-repo read runs there instead (scripts/ci/check-buzz-guest-owner-sources.mjs
// reads this repository at a pinned revision).

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const read = (relative) =>
  readFileSync(path.resolve(desktopRoot, relative), "utf8");

const listIn = (text, blockRe, itemRe, where) => {
  const block = text.match(blockRe);
  if (!block) throw new Error(`owner-only source list not found in ${where}`);
  return [...block[1].matchAll(itemRe)].map((match) => match[1]);
};

const digest = (list) =>
  createHash("sha256").update(JSON.stringify(list)).digest("hex");

try {
  const desktop = listIn(
    read("src/features/guest-access/lib/copy.ts"),
    /GUEST_OWNER_ONLY_SOURCES: readonly string\[\] = \[([^\]]*)\]/,
    /"([^"]+)"/g,
    "desktop lib/copy.ts",
  );
  const mobile = listIn(
    read("../mobile/lib/shared/guest_access/guest_owner_copy.dart"),
    /const guestOwnerOnlySources = <String>\[([^\]]*)\]/,
    /'([^']+)'/g,
    "mobile guest_owner_copy.dart",
  );
  const pinned = read(
    "src/features/guest-access/ui/access/accessTabs.test.mjs",
  ).match(/matches the digest Kiingo pins[\s\S]*?"([0-9a-f]{64})"/)?.[1];
  if (!pinned)
    throw new Error("pinned digest not found in accessTabs.test.mjs");
  const problems = [];
  if (digest(desktop) !== pinned) {
    problems.push(`desktop list digest ${digest(desktop)} != pinned ${pinned}`);
  }
  if (JSON.stringify(mobile) !== JSON.stringify(desktop)) {
    problems.push(
      `mobile list ${JSON.stringify(mobile)} != desktop ${JSON.stringify(desktop)}`,
    );
  }
  if (problems.length > 0) {
    for (const problem of problems)
      console.error(`check-guest-owner-sources: ${problem}`);
    console.error(
      "Change Kiingo BUZZ_GUEST_OWNER_ONLY_SOURCES, desktop, mobile and both pinned digests together.",
    );
    process.exit(1);
  }
} catch (error) {
  console.error(`check-guest-owner-sources: ${error.message}`);
  process.exit(1);
}

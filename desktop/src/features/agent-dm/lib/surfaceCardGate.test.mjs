import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { surfaceCardAllowed, surfaceFromSigner } from "./surfaceCardGate.ts";

const ME = "a".repeat(64);
const AGENT = "b".repeat(64);
const OTHER = "c".repeat(64);

test("a surface card shows only in a 1:1 DM with my own verified agent", () => {
  const base = {
    viewerPubkey: ME,
    signerPubkey: AGENT,
    verifiedOwnerPubkey: ME,
    memberPubkeys: [ME, AGENT],
  };
  assert.equal(surfaceCardAllowed(base), true);
  assert.equal(
    surfaceCardAllowed({ ...base, memberPubkeys: [ME.toUpperCase(), AGENT] }),
    true,
  );
  // Someone else's agent, or no verified owner (a self-published listing).
  assert.equal(
    surfaceCardAllowed({ ...base, verifiedOwnerPubkey: OTHER }),
    false,
  );
  assert.equal(
    surfaceCardAllowed({ ...base, verifiedOwnerPubkey: null }),
    false,
  );
  // A group DM, a DM without me, or members not loaded yet.
  assert.equal(
    surfaceCardAllowed({ ...base, memberPubkeys: [ME, AGENT, OTHER] }),
    false,
  );
  assert.equal(
    surfaceCardAllowed({ ...base, memberPubkeys: [OTHER, AGENT] }),
    false,
  );
  assert.equal(
    surfaceCardAllowed({ ...base, memberPubkeys: undefined }),
    false,
  );
  assert.equal(surfaceCardAllowed({ ...base, viewerPubkey: undefined }), false);
  assert.equal(surfaceCardAllowed({ ...base, signerPubkey: ME }), false);
});

// The buzz-surface-tap tag is added only in the surface card's send path
// (the controller's single send), never by the composer or any other send.
test("only the surface card attaches the surface tap tag", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  // The tag literal, and calls of its builder (comments may name it).
  const needles = {
    literal: /["']buzz-surface-tap["']/,
    builder: /buzzSurfaceTapTag\(/,
  };
  const allowed = new Map([
    ["features/surfaces/core/sends.ts", ["literal", "builder"]],
    ["features/agent-dm/ui/AgentSurfaceCard.tsx", ["builder"]],
  ]);
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  for (const path of walk(src)) {
    if (!/\.(ts|tsx)$/.test(path)) continue;
    const rel = relative(src, path);
    const text = readFileSync(path, "utf8");
    for (const [name, pattern] of Object.entries(needles)) {
      if (!pattern.test(text)) continue;
      assert.ok(
        allowed.get(rel)?.includes(name),
        `${rel} must not use the surface tap ${name}`,
      );
    }
  }
});

test("a surface card shows only when the surface names the signing agent", () => {
  assert.equal(surfaceFromSigner(AGENT, AGENT), true);
  assert.equal(surfaceFromSigner(AGENT, ` ${AGENT.toUpperCase()} `), true);
  // Another agent's surface, or a surface record with no bound key.
  assert.equal(surfaceFromSigner(OTHER, AGENT), false);
  assert.equal(surfaceFromSigner(undefined, AGENT), false);
  assert.equal(surfaceFromSigner("", ""), false);
  assert.equal(surfaceFromSigner(AGENT, undefined), false);
  assert.equal(surfaceFromSigner(AGENT.slice(2), AGENT.slice(2)), false);
});

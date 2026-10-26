import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  mirrorAwareAuthorLabel,
  mirrorAwareCopyText,
  mirrorDisplay,
  mirrorPlainText,
} from "./mirrorDisplay.ts";
import { mirrorBadgeLabel, mirrorSurfaceLabel } from "./markers.ts";

// The same vectors drive the mobile rule
// (mobile/test/shared/agent_dm/agent_dm_mirror_display_test.dart), so the
// two clients cannot drift.
const VECTORS = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../test-fixtures/mirror-display.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function channelFor(vector) {
  if (!vector.channel) return null;
  return {
    channelType: vector.channel.isDm ? "dm" : "stream",
    participantPubkeys: vector.channel.memberPubkeys,
    memberPubkeys: [],
  };
}

function project(display, content) {
  if (!display) return null;
  return {
    authorPubkey: display.authorPubkey,
    authorName: display.authorName,
    relayedByPubkey: display.relayedByPubkey,
    relayedByName: display.relayedByName,
    surfaceLabel: display.surfaceLabel,
    relayLine: display.relayLine,
    relayed: display.relayed,
    plainText: mirrorPlainText(display, content),
  };
}

test("the shared mirror display vectors hold", () => {
  assert.ok(VECTORS.cases.length > 0);
  const names = (pubkey) => VECTORS.names[pubkey] ?? pubkey;
  for (const vector of VECTORS.cases) {
    const display = mirrorDisplay({
      event: vector.event,
      channel: channelFor(vector),
      names,
      signerIsAgent: vector.signerIsAgent,
    });
    assert.deepEqual(
      project(display, vector.content),
      vector.expected,
      vector.name,
    );
  }
});

test("surface labels cover the Kiingo surfaces and keep the existing badges", () => {
  assert.equal(mirrorSurfaceLabel("tasks"), "Kiingo Tasks");
  assert.equal(mirrorSurfaceLabel("companion"), "Kiingo Companion");
  assert.equal(mirrorSurfaceLabel("ask"), "Kiingo Ask");
  assert.equal(mirrorBadgeLabel("tasks"), "via Kiingo Tasks");
  assert.equal(mirrorBadgeLabel("email"), "via email");
  assert.equal(mirrorBadgeLabel("voice"), "via voice call");
  // Never resolves through the object prototype.
  assert.equal(mirrorSurfaceLabel("constructor"), "constructor");
});

test("one-line author labels and copy text use the relayed form", () => {
  const ROSS = "b".repeat(64);
  const AGENT = "a".repeat(64);
  const display = mirrorDisplay({
    event: {
      kind: 40002,
      pubkey: AGENT,
      tags: [
        ["buzz-mirror", "tasks", "t1", "1"],
        ["buzz-mirror-author", "requester", ROSS, ""],
      ],
    },
    channel: { channelType: "dm", participantPubkeys: [AGENT, ROSS] },
    names: (pubkey) => (pubkey === ROSS ? "Ross" : "Juniper"),
    signerIsAgent: true,
  });
  const row = { author: "Ross", body: "Move my 3pm", agentDmMirror: display };
  assert.equal(mirrorAwareAuthorLabel(row), "Ross (relayed by Juniper)");
  assert.equal(
    mirrorAwareCopyText(row),
    "Ross (via Kiingo Tasks, relayed by Juniper): Move my 3pm",
  );
  const plain = { author: "Ross", body: "Hi" };
  assert.equal(mirrorAwareAuthorLabel(plain), "Ross");
  assert.equal(mirrorAwareCopyText(plain), "Hi");
});

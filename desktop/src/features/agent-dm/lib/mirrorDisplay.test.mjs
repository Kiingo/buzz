import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  mirrorAwareAuthorLabel,
  mirrorAwareCopyText,
  mirrorDetails,
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
      viewerPubkey: vector.viewer ?? null,
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
  assert.equal(mirrorSurfaceLabel("companion"), "the Companion");
  assert.equal(mirrorSurfaceLabel("ask"), "Kiingo Ask");
  assert.equal(mirrorBadgeLabel("tasks"), "via Kiingo Tasks");
  assert.equal(mirrorBadgeLabel("email"), "via email");
  assert.equal(mirrorBadgeLabel("voice"), "via voice call");
  // Never resolves through the object prototype.
  assert.equal(mirrorSurfaceLabel("constructor"), "constructor");
});

test("one-line author labels and copy text use the relayed form", () => {
  const ALEX = "b".repeat(64);
  const AGENT = "a".repeat(64);
  const display = mirrorDisplay({
    event: {
      kind: 40002,
      pubkey: AGENT,
      tags: [
        ["buzz-mirror", "tasks", "t1", "1"],
        ["buzz-mirror-author", "requester", ALEX, ""],
      ],
    },
    channel: { channelType: "dm", participantPubkeys: [AGENT, ALEX] },
    names: (pubkey) => (pubkey === ALEX ? "Alex" : "Agent"),
    signerIsAgent: true,
  });
  const row = { author: "Alex", body: "Move my 3pm", agentDmMirror: display };
  assert.equal(mirrorAwareAuthorLabel(row), "Alex (relayed by Agent)");
  assert.equal(
    mirrorAwareCopyText(row),
    "Alex (via Kiingo Tasks, relayed by Agent): Move my 3pm",
  );
  const own = mirrorDisplay({
    event: {
      kind: 40002,
      pubkey: AGENT,
      tags: [
        ["buzz-mirror", "email", "e1", "1"],
        ["buzz-mirror-author", "requester", ALEX, ""],
      ],
    },
    channel: { channelType: "dm", participantPubkeys: [AGENT, ALEX] },
    names: (pubkey) => (pubkey === ALEX ? "Alex" : "Agent"),
    signerIsAgent: true,
    viewerPubkey: ALEX.toUpperCase(),
  });
  const ownRow = { author: "You", body: "Send it", agentDmMirror: own };
  assert.equal(mirrorAwareAuthorLabel(ownRow), "You (relayed by Agent)");
  assert.equal(
    mirrorAwareCopyText(ownRow),
    "You (via email, relayed by Agent): Send it",
  );
  const plain = { author: "Alex", body: "Hi" };
  assert.equal(mirrorAwareAuthorLabel(plain), "Alex");
  assert.equal(mirrorAwareCopyText(plain), "Hi");
});

test("details name the signer as the author and the requester as relayed for", () => {
  const ALEX = "b".repeat(64);
  const AGENT = "a".repeat(64);
  const channel = { channelType: "dm", participantPubkeys: [AGENT, ALEX] };
  const names = (pubkey) => (pubkey === ALEX ? "Alex" : "Agent");
  const shown = (tags, viewerPubkey) =>
    mirrorDetails(
      mirrorDisplay({
        event: { kind: 40002, pubkey: AGENT, tags },
        channel,
        names,
        signerIsAgent: true,
        viewerPubkey,
      }),
    );

  const own = shown(
    [
      ["buzz-mirror", "email", "e1", "1"],
      ["buzz-mirror-author", "requester", ALEX, ""],
    ],
    ALEX,
  );
  assert.deepEqual(own, {
    signedBy: `Agent (${AGENT})`,
    signerPubkey: AGENT,
    relayedFor: "You · via email",
    requesterPubkey: ALEX,
    mirroredVia: null,
  });

  const other = shown([
    ["buzz-mirror", "email", "e1", "1"],
    ["buzz-mirror-author", "requester", ALEX, ""],
  ]);
  assert.equal(other.relayedFor, "Alex · via email");
  assert.equal(other.signerPubkey, AGENT);

  // Missing author tag: still relayed, never attributed to anyone.
  const unattributed = shown([["buzz-mirror", "email", "e1", "1"]]);
  assert.equal(unattributed.signedBy, `Agent (${AGENT})`);
  assert.equal(unattributed.relayedFor, "unknown requester · via email");
  assert.equal(unattributed.requesterPubkey, null);

  // The agent's own mirror has no requester.
  const agentOwn = shown([
    ["buzz-mirror", "teams", "m1", "1"],
    ["buzz-mirror-author", "agent", "", ""],
  ]);
  assert.equal(agentOwn.relayedFor, null);
  assert.equal(agentOwn.requesterPubkey, null);
  assert.equal(agentOwn.signerPubkey, AGENT);
});

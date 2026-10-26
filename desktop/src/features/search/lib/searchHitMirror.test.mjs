import assert from "node:assert/strict";
import test from "node:test";

import { searchHitMirror, searchHitPreviewText } from "./searchHitMirror.ts";

const AGENT = "a".repeat(64);
const ALEX = "b".repeat(64);
const DM = {
  channelType: "dm",
  participantPubkeys: [AGENT, ALEX],
  memberPubkeys: [],
};
const names = (pubkey) => (pubkey === ALEX ? "Alex" : "Agent");

function hit(tags, kind = 40002) {
  return { kind, pubkey: AGENT, content: "Move my 3pm", tags };
}

test("a mirrored DM hit previews in its relayed form", () => {
  const mirrored = hit([
    ["h", "dm"],
    ["buzz-mirror", "tasks", "t1", "1"],
    ["buzz-mirror-author", "requester", ALEX, ""],
  ]);
  const mirror = searchHitMirror({
    hit: mirrored,
    channel: DM,
    names,
    signerIsAgent: true,
  });
  assert.equal(mirror?.relayLine, "via Kiingo Tasks · relayed by Agent");
  assert.equal(
    searchHitPreviewText(mirrored, mirror),
    "Alex (via Kiingo Tasks, relayed by Agent): Move my 3pm",
  );
});

test("an email mirror says email", () => {
  const mirrored = hit([
    ["buzz-mirror", "email", "m1", "1"],
    ["buzz-mirror-author", "requester", ALEX, ""],
  ]);
  const mirror = searchHitMirror({
    hit: mirrored,
    channel: DM,
    names,
    signerIsAgent: true,
  });
  assert.equal(
    searchHitPreviewText(mirrored, mirror),
    "Alex (via email, relayed by Agent): Move my 3pm",
  );
});

test("hits without tags, outside a DM or not mirrors keep their content", () => {
  const plain = hit(undefined, 9);
  assert.equal(
    searchHitMirror({ hit: plain, channel: DM, names, signerIsAgent: true }),
    null,
  );
  const stream = hit([["buzz-mirror", "tasks", "t1", "1"]]);
  const mirror = searchHitMirror({
    hit: stream,
    channel: { channelType: "stream", participantPubkeys: [AGENT, ALEX] },
    names,
    signerIsAgent: true,
  });
  assert.equal(mirror, null);
  assert.equal(searchHitPreviewText(stream, mirror), "Move my 3pm");
});

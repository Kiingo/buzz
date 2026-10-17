import assert from "node:assert/strict";
import test from "node:test";

import { parseTypingPhase, typingPhaseSentence } from "./typingStatus.ts";
import { selectTypingPhaseByPubkey } from "../../channels/ui/ChannelPane.helpers.ts";

test("typing content carries a versioned phase or nothing", () => {
  assert.equal(parseTypingPhase(""), null);
  assert.equal(parseTypingPhase(undefined), null);
  assert.equal(parseTypingPhase('{"v":1,"phase":"working"}'), "working");
  assert.equal(parseTypingPhase('{"v":1,"phase":"idle"}'), "idle");
  assert.equal(parseTypingPhase('{"v":2,"phase":"working"}'), null);
  assert.equal(parseTypingPhase('{"v":1,"phase":"dancing"}'), null);
  assert.equal(parseTypingPhase("not json"), null);
  assert.equal(parseTypingPhase("[1]"), null);
  assert.equal(
    parseTypingPhase(`{"v":1,"phase":"working","pad":"${"x".repeat(600)}"}`),
    null,
  );
});

test("each phase reads as one status line; unknown is typing", () => {
  assert.equal(typingPhaseSentence("starting"), "is starting up…");
  assert.equal(typingPhaseSentence("warming"), "is warming up a session…");
  assert.equal(typingPhaseSentence("reconnecting"), "is reconnecting…");
  assert.equal(typingPhaseSentence("working"), "is working…");
  assert.equal(typingPhaseSentence("typing"), "is typing…");
  assert.equal(typingPhaseSentence(null), "is typing…");
});

test("phases are selected per scope and keyed by lowercase pubkey", () => {
  const entries = [
    { pubkey: "AA", threadHeadId: null, phase: "starting" },
    { pubkey: "bb", threadHeadId: "head", phase: "working" },
    { pubkey: "cc", threadHeadId: null, phase: null },
  ];
  assert.deepEqual(selectTypingPhaseByPubkey(entries, null), {
    aa: "starting",
  });
  assert.deepEqual(selectTypingPhaseByPubkey(entries, "head"), {
    bb: "working",
  });
});

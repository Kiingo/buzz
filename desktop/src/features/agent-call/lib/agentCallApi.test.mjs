import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  AgentCallApiError,
  answerAgentCallQuestion,
  describeAgentCallError,
  getAgentCallFeed,
  setAgentCallSendForTests,
  startAgentCall,
  stopAgentCallWork,
} from "./agentCallApi.ts";

const CALL = "0192a6b0-0000-7000-8000-0000000000ac";

let restore = () => {};
afterEach(() => restore());

function harness(answer) {
  const sent = [];
  restore = setAgentCallSendForTests(async (method, path, body) => {
    sent.push({ method, path, body });
    return answer({ method, path, body });
  });
  return sent;
}

test("a call starts from the DM with the agent key, channel and offer", async () => {
  const sent = harness(() => ({
    status: 201,
    body: { callId: CALL, sdpAnswer: "v=0", executeUntil: null },
  }));
  const started = await startAgentCall({
    agentPubkey: "b".repeat(64),
    channelId: "0192a6b0-0000-7000-8000-0000000000af",
    sdpOffer: "v=0 offer",
  });
  assert.equal(started.callId, CALL);
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].path, "calls");
  assert.deepEqual(sent[0].body, {
    agentPubkey: "b".repeat(64),
    channelId: "0192a6b0-0000-7000-8000-0000000000af",
    sdpOffer: "v=0 offer",
    clientDiagnostics: { systemCallUI: "in_app" },
  });
});

test("host error codes become plain sentences", async () => {
  harness(() => ({ status: 409, body: { error: "voice_buzz_dm_required" } }));
  await assert.rejects(
    startAgentCall({
      agentPubkey: "b".repeat(64),
      channelId: "x",
      sdpOffer: "v",
    }),
    (error) => {
      assert.ok(error instanceof AgentCallApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "voice_buzz_dm_required");
      assert.match(describeAgentCallError(error), /private DM/);
      return true;
    },
  );
  restore();
  restore = setAgentCallSendForTests(async () => {
    throw new Error(
      JSON.stringify({ status: null, error: "voice_route_timeout" }),
    );
  });
  await assert.rejects(getAgentCallFeed(CALL, null, 20), (error) => {
    assert.equal(error.code, "voice_route_timeout");
    assert.match(describeAgentCallError(error), /reach the call service/);
    return true;
  });
});

test("the feed long-poll carries rev and a bounded wait", async () => {
  const sent = harness(() => ({
    status: 200,
    body: { rev: "r1", unchanged: true },
  }));
  await getAgentCallFeed(CALL, "l4.live.1", 99);
  assert.equal(sent[0].method, "GET");
  assert.equal(sent[0].path, `calls/${CALL}/feed?rev=l4.live.1&wait=20`);
  assert.equal(sent[0].body, undefined);
});

test("stop reports nothing to stop; a tap names the open question", async () => {
  harness(() => ({ status: 409, body: { error: "voice_nothing_to_stop" } }));
  assert.equal(await stopAgentCallWork(CALL), "nothing_to_stop");
  restore();
  const sent = harness(() => ({ status: 202, body: {} }));
  assert.equal(await stopAgentCallWork(CALL), "stopped");
  await answerAgentCallQuestion({
    callId: CALL,
    humanAskId: "q:1",
    questionId: "q1",
    optionIndex: 0,
  });
  assert.equal(sent[1].path, `calls/${CALL}/human-asks/q%3A1/answer`);
  assert.equal(sent[1].body.optionIndex, 0);
  assert.equal(sent[1].body.questionId, "q1");
  assert.equal(typeof sent[1].body.idempotencyKey, "string");
});

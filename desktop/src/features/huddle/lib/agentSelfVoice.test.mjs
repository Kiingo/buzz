import assert from "node:assert/strict";
import test from "node:test";

import {
  applyHuddleAudioPeers,
  EMPTY_AGENT_SELF_VOICE_STATE,
  SELF_VOICE_RESUME_GRACE_MS,
  selfVoiceSuppression,
} from "./agentSelfVoice.ts";
import {
  classifySpeakableAgentText,
  routeLiveAgentText,
} from "./ttsLiveMessages.ts";

const AGENT = "a".repeat(64);
const HUMAN = "b".repeat(64);
const CHANNEL = "active-huddle";
const agents = new Set([AGENT]);
const T0_MS = 1_700_000_000_000;
const message = (overrides = {}) => ({
  id: "1",
  kind: 9,
  pubkey: AGENT,
  content: "Here is the summary.",
  tags: [["h", CHANNEL]],
  created_at: T0_MS / 1000,
  ...overrides,
});
const peer = (peer_index, pubkey = AGENT, local = false) => ({
  pubkey,
  peer_index,
  local,
});
const roster = (state, peers, atMs) =>
  applyHuddleAudioPeers(state, peers, atMs);
const reason = (state, event = message()) =>
  classifySpeakableAgentText(event, agents, HUMAN, CHANNEL, state).reason;

test("neither signal keeps today's agent TTS unchanged", () => {
  assert.equal(reason(EMPTY_AGENT_SELF_VOICE_STATE), null);
  const humansOnly = roster(
    EMPTY_AGENT_SELF_VOICE_STATE,
    [peer(0, HUMAN), peer(1, "c".repeat(64))],
    T0_MS,
  );
  assert.equal(reason(humansOnly), null);
  assert.equal(
    classifySpeakableAgentText(message(), agents, HUMAN, CHANNEL).text,
    "Here is the summary.",
    "callers that pass no presence state behave as before",
  );
});

test("D1: a live audio admission suppresses the agent's text replies", () => {
  const live = roster(
    EMPTY_AGENT_SELF_VOICE_STATE,
    [peer(0, HUMAN), peer(4)],
    T0_MS,
  );
  assert.equal(reason(live), "agent_self_voiced");
  assert.equal(
    reason(live, message({ pubkey: AGENT.toUpperCase() })),
    "agent_self_voiced",
    "pubkey comparison is case-insensitive",
  );

  const spoken = [];
  const result = routeLiveAgentText(
    message(),
    agents,
    HUMAN,
    CHANNEL,
    7,
    (text) => {
      spoken.push(text);
      return "queued";
    },
    live,
  );
  assert.equal(result, "agent_self_voiced");
  assert.deepEqual(spoken, [], "the production route never enqueues it");
});

test("D1: the spoken marker suppresses TTS without any presence", () => {
  const tagged = message({
    tags: [
      ["h", CHANNEL],
      ["spoken", "1"],
    ],
  });
  assert.equal(reason(EMPTY_AGENT_SELF_VOICE_STATE, tagged), "spoken_marker");
  assert.equal(
    reason(
      EMPTY_AGENT_SELF_VOICE_STATE,
      message({
        tags: [
          ["h", CHANNEL],
          ["spoken", "0"],
        ],
      }),
    ),
    null,
    "only the exact marker value suppresses",
  );

  const spoken = [];
  assert.equal(
    routeLiveAgentText(tagged, agents, HUMAN, CHANNEL, 8, (text) => {
      spoken.push(text);
      return "queued";
    }),
    "spoken_marker",
  );
  assert.deepEqual(spoken, []);
});

test("D2: a make-before-break rejoin stays suppressed until the last admission leaves", () => {
  let state = roster(EMPTY_AGENT_SELF_VOICE_STATE, [peer(4)], T0_MS);
  state = roster(state, [peer(4), peer(9)], T0_MS + 500);
  assert.equal(reason(state), "agent_self_voiced", "both sockets admitted");

  state = roster(state, [peer(9)], T0_MS + 1_000);
  assert.equal(
    reason(state, message({ created_at: (T0_MS + 10_000) / 1000 })),
    "agent_self_voiced",
    "the old socket leaving does not hand TTS back",
  );
  assert.equal(state.lastLeftAtMs.has(AGENT), false, "no leave was recorded");

  const leftAtMs = T0_MS + 2_000;
  state = roster(state, [], leftAtMs);
  assert.equal(state.lastLeftAtMs.get(AGENT), leftAtMs);
});

test("D3: TTS resumes only for messages created after the resume grace", () => {
  const leftAtMs = T0_MS + 2_000;
  let state = roster(EMPTY_AGENT_SELF_VOICE_STATE, [peer(4)], T0_MS);
  state = roster(state, [], leftAtMs);
  const at = (ms) => message({ created_at: ms / 1000 });

  assert.equal(reason(state, at(T0_MS + 1_000)), "agent_self_voiced");
  assert.equal(reason(state, at(leftAtMs)), "agent_self_voiced");
  assert.equal(
    reason(state, at(leftAtMs + SELF_VOICE_RESUME_GRACE_MS)),
    "agent_self_voiced",
    "exactly at the grace boundary is still the agent's own voice",
  );
  assert.equal(
    reason(state, at(leftAtMs + SELF_VOICE_RESUME_GRACE_MS + 1_000)),
    null,
  );
  assert.equal(
    reason(state, message({ created_at: undefined })),
    "agent_self_voiced",
    "an undated message cannot prove it postdates the leave",
  );

  state = roster(state, [peer(6)], leftAtMs + 10_000);
  assert.equal(
    reason(state, at(leftAtMs + 20_000)),
    "agent_self_voiced",
    "a fresh admission suppresses again",
  );
  assert.equal(state.lastLeftAtMs.has(AGENT), false);
});

test("this desktop's own TTS publisher socket is not the agent speaking for itself", () => {
  const ownPublisherOnly = roster(
    EMPTY_AGENT_SELF_VOICE_STATE,
    [peer(0, HUMAN), peer(3, AGENT, true)],
    T0_MS,
  );
  assert.equal(reason(ownPublisherOnly), null);

  const ownPlusRemote = roster(
    ownPublisherOnly,
    [peer(0, HUMAN), peer(3, AGENT, true), peer(5)],
    T0_MS + 100,
  );
  assert.equal(
    reason(ownPlusRemote),
    "agent_self_voiced",
    "another socket for the same agent still counts",
  );

  // The local publisher's registration can trail the roster delta that
  // announces its socket. Reclassifying that index as local is not a leave.
  const announced = roster(EMPTY_AGENT_SELF_VOICE_STATE, [peer(3)], T0_MS);
  const reclassified = roster(announced, [peer(3, AGENT, true)], T0_MS + 500);
  assert.equal(reclassified.lastLeftAtMs.has(AGENT), false);
  assert.equal(
    selfVoiceSuppression(reclassified, message({ created_at: T0_MS / 1000 })),
    null,
  );
});

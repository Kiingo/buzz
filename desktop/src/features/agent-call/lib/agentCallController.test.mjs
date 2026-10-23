import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentCallApiError } from "./agentCallApi.ts";
import {
  AgentCallController,
  assertNoAgentCallForHuddle,
  feedRetryDelay,
} from "./agentCallController.ts";

const CALL = "0192a6b0-0000-7000-8000-0000000000ac";
const AGENT = "b".repeat(64);
const CHANNEL = "0192a6b0-0000-7000-8000-0000000000af";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeMedia() {
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  return {
    track,
    stream: { getAudioTracks: () => [track], getTracks: () => [track] },
  };
}

function fakePeer() {
  const peer = {
    connectionState: "new",
    closed: false,
    tracks: [],
    ontrack: null,
    onconnectionstatechange: null,
    remote: null,
    addTrack(track) {
      this.tracks.push(track);
    },
    createDataChannel() {
      const channel = { onmessage: null, onclose: null, close() {} };
      peer.channel = channel;
      return channel;
    },
    async createOffer() {
      return { type: "offer", sdp: "v=0 offer" };
    },
    async setLocalDescription() {},
    async setRemoteDescription(answer) {
      this.remote = answer;
    },
    close() {
      this.closed = true;
    },
    connect(state) {
      this.connectionState = state;
      this.onconnectionstatechange?.();
    },
  };
  return peer;
}

function harness(overrides = {}) {
  const media = fakeMedia();
  const peer = overrides.peer ?? fakePeer();
  const log = { starts: [], ends: [], feeds: [] };
  const feedAnswers = overrides.feedAnswers ?? [];
  const controller = new AgentCallController({
    isSupported: () => true,
    isHuddleActive: overrides.isHuddleActive ?? (async () => false),
    connectTimeoutMs: overrides.connectTimeoutMs ?? 20_000,
    getUserMedia: overrides.getUserMedia ?? (async () => media.stream),
    createPeerConnection: () => peer,
    createAudioElement: () => ({
      play: async () => {},
      pause() {},
      remove() {},
      srcObject: null,
    }),
    startCall:
      overrides.startCall ??
      (async (input) => {
        log.starts.push(input);
        return { callId: CALL, sdpAnswer: "v=0 answer", executeUntil: null };
      }),
    endCall: async (callId, reason) => {
      log.ends.push({ callId, reason });
    },
    stopWork: overrides.stopWork ?? (async () => "stopped"),
    getFeed: async (callId, rev, wait) => {
      log.feeds.push({ callId, rev, wait });
      if (feedAnswers.length > 0) return feedAnswers.shift();
      // Park like a long-poll that has not answered yet.
      return new Promise(() => {});
    },
    now: () => 1_000,
  });
  return { controller, peer, media, log };
}

test("a call starts from the DM, connects and follows the feed", async () => {
  const snapshot = {
    callId: CALL,
    rev: "r1",
    state: "live",
    agent: { id: "a", name: "Alfred" },
    destination: { kind: "buzz_dm", label: "your Buzz chat with Alfred" },
    asks: [],
    humanAsk: null,
    endedAt: null,
  };
  const h = harness({ feedAnswers: [snapshot] });
  await h.controller.start({
    agentPubkey: AGENT,
    channelId: CHANNEL,
    agentName: "Alfred",
  });
  assert.equal(h.log.starts.length, 1);
  assert.equal(h.log.starts[0].agentPubkey, AGENT);
  assert.equal(h.log.starts[0].channelId, CHANNEL);
  assert.equal(h.log.starts[0].sdpOffer, "v=0 offer");
  assert.equal(h.peer.remote.sdp, "v=0 answer");
  assert.equal(h.controller.getState().phase, "connecting");
  h.peer.connect("connected");
  assert.equal(h.controller.getState().phase, "live");
  await tick();
  assert.equal(h.controller.getState().feed?.rev, "r1");
  assert.deepEqual(h.log.feeds[0], { callId: CALL, rev: null, wait: 20 });
  assert.equal(h.log.feeds[1].rev, "r1");
});

test("hang-up ends the call only and releases the mic", async () => {
  const h = harness();
  await h.controller.start({ agentPubkey: AGENT, channelId: CHANNEL });
  h.peer.connect("connected");
  await h.controller.hangUp();
  assert.deepEqual(h.log.ends, [{ callId: CALL, reason: "hangup" }]);
  assert.equal(h.controller.getState().phase, "ended");
  assert.equal(h.media.track.stopped, true);
  assert.equal(h.peer.closed, true);
  h.controller.dismiss();
  assert.equal(h.controller.getState().phase, "idle");
});

test("mute toggles the mic track; stop reports its outcome", async () => {
  const h = harness({ stopWork: async () => "nothing_to_stop" });
  await h.controller.start({ agentPubkey: AGENT, channelId: CHANNEL });
  h.peer.connect("connected");
  h.controller.toggleMute();
  assert.equal(h.media.track.enabled, false);
  assert.equal(h.controller.getState().muted, true);
  await h.controller.stopAgentWork();
  assert.equal(h.controller.getState().stop.status, "nothing_to_stop");
  h.controller.reset();
});

test("a refused start shows the host's reason and holds no mic", async () => {
  const h = harness({
    startCall: async () => {
      throw new AgentCallApiError(403, "caller_not_allowed");
    },
  });
  await h.controller.start({ agentPubkey: AGENT, channelId: CHANNEL });
  const state = h.controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.error?.kind, "request_failed");
  assert.match(state.error?.message ?? "", /isn't linked/);
  assert.equal(h.media.track.stopped, true);
});

test("a denied microphone never reaches the host", async () => {
  const h = harness({
    getUserMedia: async () => {
      const error = new Error("denied");
      error.name = "NotAllowedError";
      throw error;
    },
  });
  await h.controller.start({ agentPubkey: AGENT, channelId: CHANNEL });
  assert.equal(h.controller.getState().error?.kind, "mic_denied");
  assert.equal(h.log.starts.length, 0);
});

test("a community switch hangs up and clears the screen", async () => {
  const h = harness();
  await h.controller.start({ agentPubkey: AGENT, channelId: CHANNEL });
  h.peer.connect("connected");
  h.controller.reset();
  assert.deepEqual(h.log.ends, [{ callId: CALL, reason: "community_changed" }]);
  assert.equal(h.controller.getState().phase, "idle");
});

test("feed retries back off from 1 s to 15 s", () => {
  assert.equal(feedRetryDelay(1), 1_000);
  assert.equal(feedRetryDelay(2), 2_000);
  assert.equal(feedRetryDelay(4), 8_000);
  assert.equal(feedRetryDelay(9), 15_000);
});

test("a call is refused while a huddle owns the mic", async () => {
  let asked = false;
  const h = harness({
    isHuddleActive: async () => true,
    getUserMedia: async () => {
      asked = true;
      return fakeMedia().stream;
    },
  });
  await h.controller.start({ agentPubkey: AGENT, channelId: CHANNEL });
  assert.equal(h.controller.getState().phase, "error");
  assert.equal(h.controller.getState().error?.kind, "huddle_active");
  assert.equal(asked, false);
  assert.equal(h.log.starts.length, 0);
});

test("an unreadable huddle state refuses the call (fails closed)", async () => {
  let asked = false;
  const h = harness({
    isHuddleActive: async () => {
      throw new Error("ipc_failed");
    },
    getUserMedia: async () => {
      asked = true;
      return fakeMedia().stream;
    },
  });
  await h.controller.start({ agentPubkey: AGENT, channelId: CHANNEL });
  assert.equal(h.controller.getState().phase, "error");
  assert.equal(h.controller.getState().error?.kind, "huddle_active");
  assert.match(h.controller.getState().error?.message ?? "", /couldn't check/);
  assert.equal(asked, false);
  assert.equal(h.log.starts.length, 0);
});

test("a huddle that starts while the mic opens refuses the call", async () => {
  let checks = 0;
  const h = harness({
    // Idle before the mic opens, active once it has.
    isHuddleActive: async () => ++checks > 1,
  });
  await h.controller.start({ agentPubkey: AGENT, channelId: CHANNEL });
  assert.equal(checks, 2);
  assert.equal(h.controller.getState().error?.kind, "huddle_active");
  assert.equal(h.media.track.stopped, true);
  assert.equal(h.log.starts.length, 0);
});

test("a huddle is refused while a call is busy, allowed once it ends", async () => {
  const h = harness();
  assert.doesNotThrow(() => assertNoAgentCallForHuddle("start", h.controller));
  await h.controller.start({
    agentPubkey: AGENT,
    channelId: CHANNEL,
    agentName: "Alfred",
  });
  assert.throws(
    () => assertNoAgentCallForHuddle("join", h.controller),
    /End your call with Alfred before you join a huddle/,
  );
  await h.controller.hangUp();
  assert.doesNotThrow(() => assertNoAgentCallForHuddle("start", h.controller));
});

test("a superseded mic request stops only its own stream", async () => {
  const first = fakeMedia();
  const second = fakeMedia();
  const pending = deferred();
  let calls = 0;
  const h = harness({
    getUserMedia: async () => (++calls === 1 ? pending.promise : second.stream),
  });
  const firstStart = h.controller.start({
    agentPubkey: AGENT,
    channelId: CHANNEL,
  });
  await tick();
  h.controller.reset();
  await h.controller.start({ agentPubkey: AGENT, channelId: CHANNEL });
  pending.resolve(first.stream);
  await firstStart;
  assert.equal(first.track.stopped, true);
  assert.equal(second.track.stopped, false);
  assert.equal(h.controller.getState().phase, "connecting");
  assert.equal(h.log.starts.length, 1);
  h.controller.reset();
});

test("a hang-up while the offer is made never reaches the host", async () => {
  const peer = fakePeer();
  const offer = deferred();
  peer.createOffer = () => offer.promise;
  const h = harness({ peer });
  const starting = h.controller.start({
    agentPubkey: AGENT,
    channelId: CHANNEL,
  });
  await tick();
  assert.equal(h.controller.getState().phase, "connecting");
  h.controller.reset();
  offer.resolve({ type: "offer", sdp: "v=0 offer" });
  await starting;
  assert.equal(h.log.starts.length, 0);
  assert.equal(peer.closed, true);
});

test("a call still connecting after the timeout ends as media_failed", async () => {
  const h = harness({ connectTimeoutMs: 5 });
  await h.controller.start({ agentPubkey: AGENT, channelId: CHANNEL });
  assert.equal(h.controller.getState().phase, "connecting");
  await sleep(20);
  assert.equal(h.controller.getState().phase, "error");
  assert.equal(h.controller.getState().error?.kind, "connection_failed");
  assert.deepEqual(h.log.ends, [{ callId: CALL, reason: "media_failed" }]);
  assert.equal(h.media.track.stopped, true);
  assert.equal(h.peer.closed, true);
});

test("a timed-out call the host answers late is ended as media_failed", async () => {
  const answer = deferred();
  const h = harness({
    connectTimeoutMs: 5,
    startCall: () => answer.promise,
  });
  const starting = h.controller.start({
    agentPubkey: AGENT,
    channelId: CHANNEL,
  });
  await sleep(20);
  assert.equal(h.controller.getState().phase, "error");
  answer.resolve({ callId: CALL, sdpAnswer: "v=0 answer", executeUntil: null });
  await starting;
  assert.deepEqual(h.log.ends, [{ callId: CALL, reason: "media_failed" }]);
});

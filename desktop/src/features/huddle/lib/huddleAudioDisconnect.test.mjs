import assert from "node:assert/strict";
import test from "node:test";
import { huddleAudioDisconnectAction } from "./huddleAudioDisconnect.ts";

test("a terminal removal leaves the current huddle without reconnect", () => {
  assert.equal(
    huddleAudioDisconnectAction({ channelId: "room", terminal: true }, "room"),
    "leave",
  );
});

test("a delayed exit from another huddle cannot leave or reconnect the current one", () => {
  for (const terminal of [true, false]) {
    assert.equal(
      huddleAudioDisconnectAction({ channelId: "old", terminal }, "new"),
      "ignore",
    );
  }
});

test("unexpected disconnects retain recovery, including legacy empty payloads", () => {
  for (const payload of [
    null,
    undefined,
    {},
    { channelId: "room", terminal: false },
  ]) {
    assert.equal(huddleAudioDisconnectAction(payload, "room"), "retry");
  }
});

test("no audio event can resurrect a huddle after leave", () => {
  for (const payload of [
    null,
    { channelId: "room", terminal: true },
    { channelId: "room", terminal: false },
  ]) {
    assert.equal(huddleAudioDisconnectAction(payload, null), "ignore");
  }
});

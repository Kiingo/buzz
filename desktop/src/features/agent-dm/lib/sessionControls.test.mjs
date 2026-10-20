import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { resetAgentDmState } from "./registry.ts";
import {
  cachedSessionControls,
  ensureSessionControls,
  resetSessionControlsCache,
  SESSION_CONTROLS_FALSE_TTL_MS,
  SESSION_CONTROLS_TRUE_TTL_MS,
  setSessionControlsLookupForTests,
} from "./sessionControls.ts";

const AGENT = "a".repeat(64);
const OTHER = "b".repeat(64);

let restore = () => {};
afterEach(() => {
  restore();
  resetSessionControlsCache();
});

function harness(answer) {
  const calls = [];
  let clock = 1_000_000;
  restore = setSessionControlsLookupForTests({
    lookup: async (key) => {
      calls.push(key);
      return typeof answer === "function" ? answer(key) : answer;
    },
    now: () => clock,
  });
  return {
    calls,
    advance(ms) {
      clock += ms;
    },
  };
}

test("hidden until the provider answers true; true is cached for 10 minutes", async () => {
  const h = harness(true);
  assert.equal(cachedSessionControls(AGENT), false, "unknown is hidden");
  assert.equal(await ensureSessionControls(AGENT.toUpperCase()), true);
  assert.equal(cachedSessionControls(AGENT), true);
  h.advance(SESSION_CONTROLS_TRUE_TTL_MS - 1);
  assert.equal(await ensureSessionControls(AGENT), true);
  assert.deepEqual(h.calls, [AGENT]);
  h.advance(1);
  await ensureSessionControls(AGENT);
  assert.equal(h.calls.length, 2, "an expired answer is looked up again");
});

test("false is cached for 2 minutes", async () => {
  const h = harness(false);
  assert.equal(await ensureSessionControls(AGENT), false);
  h.advance(SESSION_CONTROLS_FALSE_TTL_MS - 1);
  await ensureSessionControls(AGENT);
  assert.equal(h.calls.length, 1);
  h.advance(1);
  await ensureSessionControls(AGENT);
  assert.equal(h.calls.length, 2);
});

test("errors and non-boolean answers fail closed and are cached like false", async () => {
  const h = harness(() => {
    throw new Error("timeout");
  });
  assert.equal(await ensureSessionControls(AGENT), false);
  assert.equal(cachedSessionControls(AGENT), false);
  await ensureSessionControls(AGENT);
  assert.equal(h.calls.length, 1, "no retry loop after an error");

  restore();
  const odd = harness("true");
  assert.equal(await ensureSessionControls(OTHER), false);
  assert.equal(odd.calls.length, 1);
});

test("a previous true is withdrawn when a later lookup fails", async () => {
  let answer = true;
  const h = harness(() => {
    if (answer) return true;
    throw new Error("unreachable");
  });
  await ensureSessionControls(AGENT);
  assert.equal(cachedSessionControls(AGENT), true);
  answer = false;
  h.advance(SESSION_CONTROLS_TRUE_TTL_MS);
  await ensureSessionControls(AGENT);
  assert.equal(cachedSessionControls(AGENT), false);
});

test("concurrent opens share one lookup; invalid keys never call", async () => {
  const h = harness(true);
  const [first, second] = await Promise.all([
    ensureSessionControls(AGENT),
    ensureSessionControls(AGENT),
  ]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(h.calls.length, 1);
  assert.equal(await ensureSessionControls("not-a-key"), false);
  assert.equal(h.calls.length, 1);
});

test("a community switch clears answers and retires in-flight lookups", async () => {
  let release;
  restore = setSessionControlsLookupForTests({
    lookup: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    now: () => 1,
  });
  const pending = ensureSessionControls(AGENT);
  // resetCommunityState() runs this through the agent DM registry reset.
  resetAgentDmState();
  release(true);
  await pending;
  assert.equal(
    cachedSessionControls(AGENT),
    false,
    "an answer from the previous community is discarded",
  );
});

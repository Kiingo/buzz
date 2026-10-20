import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  AGENT_PREWARM_DEBOUNCE_MS,
  prewarmAgent,
  resetAgentPrewarm,
  setAgentPrewarmForTests,
} from "./agentPrewarm.ts";

const AGENT = "a".repeat(64);
const OTHER = "b".repeat(64);

let restore = () => {};
afterEach(() => {
  restore();
  resetAgentPrewarm();
});

function harness(send) {
  const calls = [];
  let clock = 1_000;
  restore = setAgentPrewarmForTests({
    send: async (key) => {
      calls.push(key);
      return send?.(key);
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

test("one prewarm per agent per two minutes", () => {
  const h = harness();
  assert.equal(prewarmAgent(AGENT.toUpperCase()), true);
  assert.equal(prewarmAgent(AGENT), false);
  assert.equal(prewarmAgent(OTHER), true, "agents are debounced separately");
  h.advance(AGENT_PREWARM_DEBOUNCE_MS - 1);
  assert.equal(prewarmAgent(AGENT), false);
  h.advance(1);
  assert.equal(prewarmAgent(AGENT), true);
  assert.deepEqual(h.calls, [AGENT, OTHER, AGENT]);
});

test("errors are ignored and never retried; invalid keys never send", async () => {
  const h = harness(() => {
    throw new Error("offline");
  });
  assert.equal(prewarmAgent(AGENT), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(prewarmAgent(AGENT), false, "a failure still counts");
  assert.equal(prewarmAgent("not-a-key"), false);
  assert.deepEqual(h.calls, [AGENT]);
});

test("a community switch clears the debounce", () => {
  const h = harness();
  prewarmAgent(AGENT);
  resetAgentPrewarm();
  assert.equal(prewarmAgent(AGENT), true);
  assert.equal(h.calls.length, 2);
});

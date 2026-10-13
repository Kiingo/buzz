import assert from "node:assert/strict";
import test from "node:test";

import {
  failedRemoteCreateMessage,
  rollbackFailedRemoteCreate,
} from "./rollbackFailedRemoteCreate.ts";

function recorder(outcomes) {
  const calls = [];
  return {
    calls,
    steps: {
      rollbackAgent: async (pubkey) => {
        calls.push(["agent", pubkey]);
        const outcome = outcomes.agent ?? { status: "removed" };
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      deleteDefinition: async (id) => {
        calls.push(["definition", id]);
        if (outcomes.definition instanceof Error) throw outcomes.definition;
      },
    },
  };
}

test("removes the agent first, then its definition", async () => {
  const { calls, steps } = recorder({});
  const result = await rollbackFailedRemoteCreate(
    { agentPubkey: "pk", definitionId: "def" },
    steps,
  );
  assert.deepEqual(calls, [
    ["agent", "pk"],
    ["definition", "def"],
  ]);
  assert.deepEqual(result, { clean: true, leftovers: [], remaining: null });
});

test("a kept agent keeps its definition and is reported for retry", async () => {
  const { calls, steps } = recorder({
    agent: { status: "kept", reason: "could not confirm remote state" },
  });
  const result = await rollbackFailedRemoteCreate(
    { agentPubkey: "pk", definitionId: "def" },
    steps,
  );
  assert.deepEqual(calls, [["agent", "pk"]]);
  assert.equal(result.clean, false);
  assert.deepEqual(result.remaining, {
    agentPubkey: "pk",
    definitionId: "def",
  });
  assert.match(result.leftovers[0], /could not confirm remote state/);
});

test("already-gone steps count as removed, so retries are idempotent", async () => {
  const { steps } = recorder({
    agent: new Error("agent pk not found"),
    definition: new Error("persona def does not exist"),
  });
  const result = await rollbackFailedRemoteCreate(
    { agentPubkey: "pk", definitionId: "def" },
    steps,
  );
  assert.equal(result.clean, true);
});

test("a definition-only leftover is retried without touching the agent", async () => {
  const { calls, steps } = recorder({ definition: new Error("disk busy") });
  const first = await rollbackFailedRemoteCreate(
    { agentPubkey: "pk", definitionId: "def" },
    steps,
  );
  assert.deepEqual(first.remaining, { agentPubkey: null, definitionId: "def" });
  const retry = recorder({});
  const second = await rollbackFailedRemoteCreate(first.remaining, retry.steps);
  assert.deepEqual(retry.calls, [["definition", "def"]]);
  assert.equal(second.clean, true);
  assert.equal(calls.length, 2);
});

test("an unexpected rollback error keeps everything", async () => {
  const { steps } = recorder({ agent: new Error("IPC failed") });
  const result = await rollbackFailedRemoteCreate(
    { agentPubkey: "pk", definitionId: "def" },
    steps,
  );
  assert.deepEqual(result.remaining, {
    agentPubkey: "pk",
    definitionId: "def",
  });
});

test("messages say what happened in plain words", () => {
  assert.equal(
    failedRemoteCreateMessage("Fizz", "subscription missing.", {
      clean: true,
      leftovers: [],
      remaining: null,
    }),
    "Fizz couldn't start: subscription missing. Nothing was kept, so you can fix this and try again.",
  );
  assert.match(
    failedRemoteCreateMessage("Fizz", "timeout.", {
      clean: false,
      leftovers: ["the agent (unconfirmed)"],
      remaining: { agentPubkey: "pk", definitionId: "def" },
    }),
    /Press Create agent again to retry the cleanup first\.$/,
  );
});

test("surfaces without a retry path point at Agents instead", () => {
  assert.match(
    failedRemoteCreateMessage(
      "Fizz",
      "timeout.",
      {
        clean: false,
        leftovers: ["the agent (unconfirmed)"],
        remaining: { agentPubkey: "pk", definitionId: "def" },
      },
      { retriesCleanup: false },
    ),
    /Delete Fizz from Agents before trying again\.$/,
  );
});

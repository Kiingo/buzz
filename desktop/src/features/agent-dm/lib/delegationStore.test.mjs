import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { setAgentCallSendForTests } from "@/features/agent-call/lib/agentCallApi";

import {
  answerDelegationAsk,
  cancelAllDelegations,
  getDelegationBoard,
  markDelegationsSeen,
  resetDelegationStore,
  subscribeDelegations,
  undoStopDelegation,
} from "./delegationStore.ts";

const AGENT_KEY = "a".repeat(64);
const AGENT = "0192a6b0-0000-6000-8000-0000000000a1";
const DELEGATION = "0192a6b0-0000-6000-8000-0000000000d1";
const ASK = "0192a6b0-0000-6000-8000-0000000000e1";

let restore = () => {};
afterEach(() => {
  restore();
  resetDelegationStore();
});

const never = () => new Promise(() => {});

function page(rev, pendingAsksCount) {
  return {
    rev,
    serverNow: "2026-10-31T10:10:00Z",
    agent: { id: AGENT, name: "Ada" },
    summary: {
      runningCount: 1,
      needsYouCount: pendingAsksCount,
      stalledCount: 0,
      costTodayUsd: 1,
      canStopAll: true,
    },
    cards: [
      {
        delegationId: DELEGATION,
        revision: 2,
        title: "Research",
        harness: "claude_code",
        state: pendingAsksCount ? "needs_input" : "running",
        taskId: null,
        cost: { costUsd: 1 },
        pendingAsksCount,
      },
    ],
  };
}

function host(routes) {
  const sent = [];
  restore = setAgentCallSendForTests(async (method, path, body) => {
    sent.push({ method, path, body });
    for (const [match, answer] of routes) {
      if (match(method, path)) return answer({ method, path, body });
    }
    return never();
  });
  return sent;
}

async function until(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out");
}

const LIST = `agents/-/delegations?agentPubkey=${AGENT_KEY}`;
const CHAT = `agents/${AGENT}/chat?limit=1`;

/** The owner chat head: no pending ack. */
const noAck = [
  (_method, path) => path === CHAT,
  () => ({ status: 200, body: { rev: "c1", entries: [] } }),
];

test("the board reads the cards by agent key and their asks, then long-polls", async () => {
  const sent = host([
    noAck,
    [
      (_method, path) => path === LIST,
      () => ({ status: 200, body: page("r1", 1) }),
    ],
    [
      (_method, path) => path === `agents/${AGENT}/delegations/${DELEGATION}`,
      () => ({
        status: 200,
        body: {
          delegation: {
            pendingAsks: [
              {
                id: ASK,
                delegationId: DELEGATION,
                workerTitle: "Research",
                question: "Which repo?",
                options: ["buzz"],
                state: "open",
              },
            ],
          },
        },
      }),
    ],
    [
      (method) => method === "POST",
      () => ({ status: 200, body: { cancelledIds: [DELEGATION] } }),
    ],
  ]);
  const stop = subscribeDelegations(AGENT_KEY, () => {});
  await until(() => getDelegationBoard(AGENT_KEY).status === "ready");
  const board = getDelegationBoard(AGENT_KEY);
  assert.equal(board.agentId, AGENT);
  assert.equal(board.ack, null);
  assert.ok(!sent.some((call) => call.path.startsWith("settings")));
  assert.equal(board.asks.get(DELEGATION)?.[0]?.id, ASK);
  await until(() =>
    sent.some((call) => call.path === `${LIST}&rev=r1&wait=20`),
  );

  await answerDelegationAsk(AGENT_KEY, ASK, "buzz");
  assert.ok(
    sent.some(
      (call) =>
        call.method === "POST" &&
        call.path === `agents/${AGENT}/delegations/asks/${ASK}/answer` &&
        call.body.answer === "buzz",
    ),
  );
  assert.equal(await cancelAllDelegations(AGENT_KEY), 1);
  assert.ok(
    sent.some(
      (call) =>
        call.method === "POST" &&
        call.path === `agents/${AGENT}/delegations/cancel-all`,
    ),
  );
  stop();
});

test("anyone but the owner gets no board (D5)", async () => {
  host([
    [
      (_method, path) => path === LIST,
      () => ({ status: 404, body: { error: "not_found" } }),
    ],
  ]);
  const stop = subscribeDelegations(AGENT_KEY, () => {});
  await until(() => getDelegationBoard(AGENT_KEY).status === "hidden");
  await assert.rejects(cancelAllDelegations(AGENT_KEY));
  stop();
});

test("a host that cannot resolve the key gets no board", async () => {
  host([
    [
      (_method, path) => path === LIST,
      () => ({
        status: 400,
        body: { error: "invalid_request", field: "agentPubkey" },
      }),
    ],
  ]);
  const stop = subscribeDelegations(AGENT_KEY, () => {});
  await until(() => getDelegationBoard(AGENT_KEY).status === "hidden");
  stop();
});

test("the pending ack shows until a chat page arrives without it", async () => {
  const ack = {
    id: `ack:${DELEGATION}`,
    text: "Starting 1 worker: Research",
    delegationIds: [DELEGATION],
    titles: ["Research"],
    createdAt: "2026-10-31T10:10:00Z",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    afterSequence: 4,
  };
  let replied = false;
  const sent = host([
    [
      (_method, path) => path === CHAT,
      () => ({
        status: 200,
        body: {
          rev: replied ? "c2" : "c1",
          ...(replied
            ? {}
            : {
                delegations: {
                  summary: {},
                  activeDelegationIds: [],
                  pendingAck: ack,
                },
              }),
        },
      }),
    ],
    [
      (_method, path) => path === LIST,
      () => ({ status: 200, body: page("r1", 0) }),
    ],
  ]);
  const stop = subscribeDelegations(AGENT_KEY, () => {});
  await until(() => getDelegationBoard(AGENT_KEY).ack?.id === ack.id);
  assert.equal(getDelegationBoard(AGENT_KEY).ack?.text, ack.text);
  replied = true;
  // Re-read while it shows; the agent's reply clears it.
  for (let i = 0; i < 100 && getDelegationBoard(AGENT_KEY).ack; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(getDelegationBoard(AGENT_KEY).ack, null);
  const reads = sent.filter((call) => call.path === CHAT).length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    sent.filter((call) => call.path === CHAT).length,
    reads,
    "no re-reads once the ack is gone",
  );
  stop();
});

test("a read that lands after the last viewer left is dropped", async () => {
  let release;
  host([
    [
      (_method, path) => path === LIST,
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 200, body: page("r1", 0) });
        }),
    ],
  ]);
  const stop = subscribeDelegations(AGENT_KEY, () => {});
  await until(() => typeof release === "function");
  stop();
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(getDelegationBoard(AGENT_KEY).status, "loading");
});

test("since you last looked is read once per viewing, and Mark seen moves the owner's cursor", async () => {
  const sent = host([
    noAck,
    [
      (_method, path) => path === `agents/${AGENT}/delegations/since`,
      () => ({
        status: 200,
        body: {
          seenAt: null,
          latestAt: "2026-10-31T10:05:00Z",
          serverNow: "2026-10-31T10:10:00Z",
          finished: { count: 1, delegationIds: [DELEGATION] },
          failed: { count: 0, delegationIds: [] },
          cancelled: { count: 0, delegationIds: [] },
          started: { count: 0, delegationIds: [] },
          newQuestions: { count: 0, askIds: [], delegationIds: [] },
          changedDelegationIds: [DELEGATION],
        },
      }),
    ],
    [
      (_method, path) => path === LIST,
      () => ({ status: 200, body: page("r1", 0) }),
    ],
    [
      (method) => method === "POST",
      () => ({ status: 200, body: { seenAt: "2026-10-31T10:05:00Z" } }),
    ],
  ]);
  const stop = subscribeDelegations(AGENT_KEY, () => {});
  await until(
    () =>
      getDelegationBoard(AGENT_KEY).since !== null &&
      getDelegationBoard(AGENT_KEY).since !== undefined,
  );
  assert.equal(getDelegationBoard(AGENT_KEY).since.text, "1 finished");
  await markDelegationsSeen(AGENT_KEY);
  assert.equal(getDelegationBoard(AGENT_KEY).since, null);
  const seen = sent.find(
    (call) => call.path === `agents/${AGENT}/delegations/seen`,
  );
  assert.equal(seen.method, "POST");
  assert.deepEqual(seen.body, { at: "2026-10-31T10:05:00Z" });
  await undoStopDelegation(AGENT_KEY, DELEGATION);
  assert.ok(
    sent.some(
      (call) =>
        call.method === "POST" &&
        call.path === `agents/${AGENT}/delegations/${DELEGATION}/undo-stop`,
    ),
  );
  assert.equal(
    sent.filter((call) => call.path === `agents/${AGENT}/delegations/since`)
      .length,
    1,
    "read once per viewing, not on every page",
  );
  stop();
});

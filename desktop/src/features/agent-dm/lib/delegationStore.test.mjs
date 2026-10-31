import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { setAgentCallSendForTests } from "@/features/agent-call/lib/agentCallApi";

import {
  answerDelegationAsk,
  cancelAllDelegations,
  getDelegationBoard,
  resetDelegationStore,
  subscribeDelegations,
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

const settings = [
  (method, path) =>
    method === "GET" && path.startsWith("settings?agentPubkey="),
  () => ({
    status: 200,
    body: {
      data: {
        providers: [],
        effective: { agentId: AGENT, provider: "gpt-live" },
      },
    },
  }),
];

test("the board maps the agent key, reads the cards and their asks, then long-polls", async () => {
  const sent = host([
    settings,
    [
      (_method, path) => path === `agents/${AGENT}/delegations`,
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
  assert.equal(board.asks.get(DELEGATION)?.[0]?.id, ASK);
  await until(() =>
    sent.some(
      (call) => call.path === `agents/${AGENT}/delegations?rev=r1&wait=20`,
    ),
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
    settings,
    [
      (_method, path) => path === `agents/${AGENT}/delegations`,
      () => ({ status: 404, body: { error: "not_found" } }),
    ],
  ]);
  const stop = subscribeDelegations(AGENT_KEY, () => {});
  await until(() => getDelegationBoard(AGENT_KEY).status === "hidden");
  await assert.rejects(cancelAllDelegations(AGENT_KEY));
  stop();
});

test("an agent with no Kiingo agent behind it gets no board", async () => {
  host([
    [
      (_method, path) => path.startsWith("settings?"),
      () => ({ status: 404, body: { error: "agent_not_found" } }),
    ],
  ]);
  const stop = subscribeDelegations(AGENT_KEY, () => {});
  await until(() => getDelegationBoard(AGENT_KEY).status === "hidden");
  stop();
});

test("a read that lands after the last viewer left is dropped", async () => {
  let release;
  host([
    settings,
    [
      (_method, path) => path === `agents/${AGENT}/delegations`,
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

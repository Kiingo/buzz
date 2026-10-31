import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DELEGATION_FOLD_AT,
  appOriginFor,
  askAsQuestion,
  delegationBoard,
  delegationDmAgent,
  delegationChatPath,
  delegationSeenPath,
  delegationSincePath,
  delegationsPath,
  doneTitle,
  formatElapsed,
  formatUsd,
  fromWorkerLabel,
  headerText,
  liveElapsed,
  parseDelegationAsks,
  parseDelegationCard,
  parsePendingAck,
  parseDelegationPoll,
  parseDelegationSince,
  sessionLink,
  stateLabel,
  taskLink,
  undoStopPath,
  undoStopRemainingMs,
  undoableCards,
} from "./delegations.ts";

const AGENT = "0192a6b0-0000-6000-8000-0000000000a1";
const TASK = "0192a6b0-0000-6000-8000-0000000000b1";
const TASK2 = "0192a6b0-0000-6000-8000-0000000000b2";
const SESSION = "0192a6b0-0000-6000-8000-0000000000c1";
const id = (n) => `0192a6b0-0000-6000-8000-${String(n).padStart(12, "0")}`;

function card(n, extra = {}) {
  return {
    delegationId: id(n),
    revision: 1,
    createdAt: "2026-10-31T10:00:00Z",
    initiatedBy: "orchestrator",
    doneWhen: null,
    waitingOnDelegationIds: [],
    title: `Worker ${n}`,
    harness: "codex",
    state: "running",
    stalled: false,
    decision: "new",
    continuedFromLedger: false,
    parallelGroup: null,
    taskId: TASK,
    taskTitle: "Ship the thing",
    conversationThreadId: null,
    workerSessionId: SESSION,
    startedAt: `2026-10-31T10:0${n % 10}:00Z`,
    finishedAt: null,
    elapsedSeconds: 90,
    cost: { costUsd: 0.42, outputTokens: 10, turns: 1, accounting: "x" },
    lastProgressLine: "Reading the repo",
    lastProgressAt: null,
    result: null,
    pendingAsksCount: 0,
    ownerActive: false,
    ...extra,
  };
}

function page(cards, summary = {}) {
  return {
    rev: "r1",
    serverNow: "2026-10-31T10:10:00Z",
    agent: { id: AGENT, name: "Ada" },
    summary: {
      runningCount: 1,
      needsYouCount: 0,
      stalledCount: 0,
      doneCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      costTodayUsd: 4.1,
      canStopAll: true,
      ...summary,
    },
    cards,
    nextCursor: null,
  };
}

test("a page parses, dropping malformed and repeated cards", () => {
  const poll = parseDelegationPoll(
    page([card(1), card(1), { ...card(2), state: "exploded" }, { title: "x" }]),
  );
  assert.equal(poll.kind, "page");
  assert.equal(poll.page.cards.length, 1);
  assert.equal(poll.page.agentName, "Ada");
  assert.equal(poll.page.agentId, AGENT);
  assert.equal(poll.page.cards[0].costUsd, 0.42);
  assert.deepEqual(parseDelegationPoll({ rev: "r2", unchanged: true }), {
    kind: "unchanged",
    rev: "r2",
  });
  assert.equal(parseDelegationPoll({ rev: "r2" }), null);
  assert.equal(parseDelegationPoll({ cards: [] }), null);
  assert.equal(parseDelegationPoll(null), null);
});

test("progress is never a result, and a running card has no result", () => {
  const running = parseDelegationCard(
    card(1, { result: { summary: "All done", at: "t", outcome: "done" } }),
  );
  assert.equal(running.result, null);
  assert.equal(running.lastProgressLine, "Reading the repo");
  const done = parseDelegationCard(
    card(2, {
      state: "done",
      result: { summary: "Merged", at: "t", outcome: "done" },
    }),
  );
  assert.equal(done.result.summary, "Merged");
  // Stalled counts only while running.
  assert.equal(
    parseDelegationCard(card(3, { state: "done", stalled: true })).stalled,
    false,
  );
});

test("the header reads running, needs you and today's cost", () => {
  const summary = parseDelegationPoll(
    page([], { runningCount: 3, needsYouCount: 1, costTodayUsd: 4.1 }),
  ).page.summary;
  assert.equal(headerText(summary), "3 running · 1 needs you · $4.10 today");
  assert.equal(
    headerText({ ...summary, runningCount: 0, needsYouCount: 0 }),
    null,
  );
  assert.equal(
    headerText({
      ...summary,
      runningCount: 2,
      needsYouCount: 0,
      costTodayUsd: null,
    }),
    "2 running",
  );
});

test("three or more running cards fold; asks come first", () => {
  const cards = [1, 2, 3].map((n) => parseDelegationCard(card(n)));
  assert.equal(DELEGATION_FOLD_AT, 3);
  assert.equal(delegationBoard(cards).folded, true);
  assert.equal(delegationBoard(cards.slice(0, 2)).folded, false);
  const asking = parseDelegationCard(card(4, { pendingAsksCount: 1 }));
  const board = delegationBoard([...cards.slice(0, 2), asking]);
  assert.deepEqual(
    board.needsYou.map((c) => c.delegationId),
    [id(4)],
  );
  assert.equal(board.running.length, 2);
  assert.equal(board.folded, false);
  assert.equal(stateLabel(asking), "needs you");
});

test("one done summary per task, only once the task has no active worker", () => {
  const doneA = parseDelegationCard(
    card(1, {
      state: "done",
      finishedAt: "2026-10-31T10:05:00Z",
      result: { summary: "Drafted", at: "t", outcome: "done" },
    }),
  );
  const failedA = parseDelegationCard(
    card(2, {
      state: "failed",
      finishedAt: "2026-10-31T10:06:00Z",
      result: { summary: "Timed out", at: "t", outcome: "failed" },
    }),
  );
  const runningA = parseDelegationCard(card(3));
  const doneB = parseDelegationCard(
    card(4, {
      state: "done",
      taskId: TASK2,
      taskTitle: "Other",
      finishedAt: "2026-10-31T10:07:00Z",
      result: { summary: "Fixed", at: "t", outcome: "done" },
    }),
  );
  let board = delegationBoard([doneA, failedA, runningA, doneB]);
  assert.deepEqual(
    board.done.map((s) => s.key),
    [TASK2],
  );
  board = delegationBoard([doneA, failedA, doneB]);
  assert.deepEqual(
    board.done.map((s) => [s.key, s.outcome, s.workers.length]),
    [
      [TASK2, "done", 1],
      [TASK, "mixed", 2],
    ],
  );
  assert.equal(doneTitle(board.done[0]), "Done · Other");
  assert.equal(doneTitle(board.done[1]), "Finished · Ship the thing");
  // Put away by the owner.
  assert.deepEqual(
    delegationBoard([doneA, doneB], new Set([TASK2])).done.map((s) => s.key),
    [TASK],
  );
});

test("a worker ask becomes the existing question card", () => {
  const asks = parseDelegationAsks({
    delegation: {
      pendingAsks: [
        {
          id: id(9),
          delegationId: id(1),
          workerTitle: "Research",
          question: "Which repo?",
          options: ["kiingo", "buzz", "buzz", " "],
          recommendation: "buzz",
          state: "open",
        },
        { id: id(10), delegationId: id(1), question: "Old", state: "answered" },
        { id: "nope", delegationId: id(1), question: "Bad id" },
      ],
    },
  });
  assert.equal(asks.length, 1);
  const question = askAsQuestion(asks[0]);
  assert.equal(question.askId, id(9));
  assert.equal(question.items.length, 1);
  assert.equal(question.items[0].allowOther, true);
  assert.deepEqual(question.items[0].options, [
    { label: "kiingo", description: null },
    { label: "buzz", description: "Recommended" },
  ]);
  assert.equal(fromWorkerLabel(asks[0]), "from worker: Research");
  assert.deepEqual(parseDelegationAsks({}), []);
});

test("links go to the task and the worker's session", () => {
  assert.equal(taskLink(TASK.toUpperCase()), `kiingotasks://task/${TASK}`);
  assert.equal(appOriginFor("api.kiingo.com"), "https://app.kiingo.com");
  assert.equal(appOriginFor("API.Kiingo.com"), "https://app.kiingo.com");
  assert.equal(appOriginFor("127.0.0.1:3000"), null);
  assert.equal(appOriginFor("voice.kiingo.com"), null);
  assert.equal(appOriginFor(null), null);
  assert.equal(
    sessionLink("https://app.kiingo.com", SESSION),
    `https://app.kiingo.com/team/harness-sessions/${SESSION}/feed`,
  );
});

test("the list path names the agent key and long-polls on the page's rev", () => {
  const key = "ab".repeat(32);
  const base = `agents/-/delegations?agentPubkey=${key}`;
  assert.equal(delegationsPath(key.toUpperCase(), null), base);
  assert.equal(delegationsPath(key, "a:b/c"), `${base}&rev=a%3Ab%2Fc&wait=20`);
  // The native route check admits only letters, digits, `-_.%` in rev.
  assert.equal(
    delegationsPath(key, "r!'()*~"),
    `${base}&rev=r%21%27%28%29%2A%7E&wait=20`,
  );
  assert.equal(
    delegationChatPath(AGENT.toUpperCase()),
    `agents/${AGENT}/chat?limit=1`,
  );
});

test("the pending ack is read off the owner chat page, and only while it lasts", () => {
  const now = Date.parse("2026-10-31T10:00:00Z");
  const chat = (pendingAck) => ({
    rev: "c1",
    delegations: { summary: {}, activeDelegationIds: [], pendingAck },
  });
  const ack = {
    id: "ack:x",
    text: " Starting 2 workers: A, B ",
    expiresAt: "2026-10-31T10:05:00Z",
  };
  assert.deepEqual(parsePendingAck(chat(ack), now), {
    id: "ack:x",
    text: "Starting 2 workers: A, B",
    expiresAtMs: Date.parse(ack.expiresAt),
  });
  assert.equal(parsePendingAck(chat(null), now), null);
  assert.equal(parsePendingAck({ rev: "c1" }, now), null);
  assert.equal(
    parsePendingAck(chat({ ...ack, expiresAt: "2026-10-31T09:59:59Z" }), now),
    null,
  );
  assert.equal(parsePendingAck(chat({ ...ack, text: " " }), now), null);
  assert.equal(parsePendingAck(chat({ ...ack, expiresAt: "soon" }), now), null);
});

test("the board shows only in the reader's own 1:1 DM", () => {
  const viewer = "b".repeat(64);
  const agent = "a".repeat(64);
  const dm = { channelType: "dm", participantPubkeys: [agent, viewer] };
  assert.equal(delegationDmAgent(dm, viewer.toUpperCase()), agent);
  assert.equal(
    delegationDmAgent(
      { ...dm, participantPubkeys: [agent, viewer, "c".repeat(64)] },
      viewer,
    ),
    null,
  );
  assert.equal(
    delegationDmAgent({ ...dm, channelType: "stream" }, viewer),
    null,
  );
  assert.equal(delegationDmAgent(dm, "c".repeat(64)), null);
  assert.equal(delegationDmAgent(dm, null), null);
});

test("time and money read briefly", () => {
  assert.equal(formatElapsed(45), "45s");
  assert.equal(formatElapsed(720), "12m");
  assert.equal(formatElapsed(3900), "1h 05m");
  assert.equal(formatElapsed(null), null);
  assert.equal(formatUsd(0), null);
  assert.equal(formatUsd(0.004), "<$0.01");
  assert.equal(formatUsd(4.1), "$4.10");
  const running = parseDelegationCard(card(1));
  assert.equal(
    liveElapsed(
      running,
      "2026-10-31T10:10:00Z",
      Date.parse("2026-10-31T10:11:00Z"),
    ),
    150,
  );
  const done = parseDelegationCard(card(2, { state: "done" }));
  assert.equal(liveElapsed(done, "2026-10-31T10:10:00Z", Date.now()), 90);
});

test("Undo shows only on a stopped card inside its window", () => {
  const serverNow = "2026-10-31T10:10:00Z";
  const at = Date.parse(serverNow);
  const stopped = (n, until, state = "cancelled") =>
    parseDelegationCard(
      card(n, {
        state,
        finishedAt: `2026-10-31T10:09:5${n}Z`,
        undoStopUntil: until,
      }),
    );
  const open = stopped(1, "2026-10-31T10:10:30Z");
  assert.equal(undoStopRemainingMs(open, serverNow, at), 30_000);
  // The reader's clock carries on from serverNow.
  assert.equal(undoStopRemainingMs(open, serverNow, at + 10_000), 20_000);
  assert.equal(undoStopRemainingMs(open, serverNow, at + 31_000), 0);
  // A stale reader clock never stretches the window past serverNow.
  assert.equal(undoStopRemainingMs(open, serverNow, at - 60_000), 30_000);
  const passed = stopped(2, "2026-10-31T10:09:59Z");
  const done = stopped(3, "2026-10-31T10:10:30Z", "done");
  assert.equal(done.undoStopUntil, null);
  const later = stopped(4, "2026-10-31T10:10:40Z");
  assert.deepEqual(
    undoableCards([open, passed, done, later], serverNow, at).map(
      (c) => c.delegationId,
    ),
    [id(4), id(1)],
  );
  assert.equal(
    undoStopPath(AGENT.toUpperCase(), id(1)),
    `agents/${AGENT}/delegations/${id(1)}/undo-stop`,
  );
});

test("since you last looked reads as one chip, or none", () => {
  const since = (counts) => ({
    seenAt: "2026-10-31T09:00:00Z",
    latestAt: "2026-10-31T10:00:00Z",
    serverNow: "2026-10-31T10:10:00Z",
    finished: { count: 0, delegationIds: [] },
    failed: { count: 0, delegationIds: [] },
    cancelled: { count: 0, delegationIds: [] },
    started: { count: 0, delegationIds: [] },
    newQuestions: { count: 0, askIds: [], delegationIds: [] },
    changedDelegationIds: [],
    ...counts,
  });
  assert.equal(parseDelegationSince(since({})), null);
  assert.deepEqual(
    parseDelegationSince(
      since({
        finished: { count: 2 },
        failed: { count: 1 },
        newQuestions: { count: 1 },
      }),
    ),
    {
      latestAt: "2026-10-31T10:00:00Z",
      text: "2 finished · 1 failed · 1 new question",
    },
  );
  assert.equal(
    parseDelegationSince(since({ cancelled: { count: 3 } }))?.text,
    "3 stopped",
  );
  assert.equal(parseDelegationSince({}), null);
  assert.equal(delegationSincePath(AGENT), `agents/${AGENT}/delegations/since`);
  assert.equal(delegationSeenPath(AGENT), `agents/${AGENT}/delegations/seen`);
});

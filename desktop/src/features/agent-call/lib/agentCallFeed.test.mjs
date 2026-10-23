import assert from "node:assert/strict";
import { test } from "node:test";

import {
  askKeyOf,
  askNowLine,
  askStatusLabel,
  askTitle,
  feedWantsMore,
  isFeedSnapshot,
  openHumanAsk,
  safeHttpsUrl,
  visibleAsks,
} from "./agentCallFeed.ts";

const ask = (overrides = {}) => ({
  askId: null,
  utteranceId: "d1",
  kind: "ask",
  text: "email Nicole the Q3 deck before the board meeting on Thursday please",
  status: "submitted",
  statusReason: null,
  createdAt: "2026-10-23T12:00:00.000Z",
  closedAt: null,
  progress: null,
  result: null,
  links: [],
  ...overrides,
});

const feed = (overrides = {}) => ({
  callId: "c1",
  rev: "r1",
  state: "live",
  agent: { id: "a", name: "Alfred" },
  destination: null,
  asks: [],
  humanAsk: null,
  endedAt: null,
  ...overrides,
});

test("ask keys, titles and live lines follow the host's ledger", () => {
  assert.equal(askKeyOf(ask()), "d1");
  assert.equal(askKeyOf(ask({ askKey: "k1" })), "k1");
  assert.equal(
    askTitle(ask({ title: { text: "Email Nicole", source: "model" } })),
    "Email Nicole",
  );
  assert.equal(askTitle(ask()), "email Nicole the Q3 deck before the board…");
  assert.equal(
    askNowLine(ask({ progress: { text: "drafting", at: "x" } })),
    "drafting",
  );
  assert.equal(
    askNowLine(
      ask({
        nowLine: { text: "now", at: "x" },
        progress: { text: "old", at: "x" },
      }),
    ),
    "now",
  );
  assert.equal(
    askNowLine(ask({ status: "answered", progress: { text: "x", at: "x" } })),
    null,
  );
  assert.equal(askStatusLabel(ask()), "Working");
  assert.equal(askStatusLabel(ask({ status: "answered" })), "Done");
  assert.equal(
    askStatusLabel(ask({ status: "failed", cancelledAt: "x" })),
    "Cancelled",
  );
});

test("pinned asks first (newest pin first), archived apart, answers folded", () => {
  const list = visibleAsks(
    feed({
      asks: [
        ask({ utteranceId: "a" }),
        ask({ utteranceId: "b", pinnedAt: "2026-10-23T12:01:00.000Z" }),
        ask({ utteranceId: "c", archivedAt: "2026-10-23T12:02:00.000Z" }),
        ask({ utteranceId: "d", pinnedAt: "2026-10-23T12:03:00.000Z" }),
        ask({ utteranceId: "e", kind: "answer" }),
      ],
    }),
  );
  assert.deepEqual(
    list.shown.map((a) => a.utteranceId),
    ["d", "b", "a"],
  );
  assert.deepEqual(
    list.archived.map((a) => a.utteranceId),
    ["c"],
  );
});

test("only https links open", () => {
  assert.equal(safeHttpsUrl("https://example.com/x"), "https://example.com/x");
  assert.equal(safeHttpsUrl("http://example.com"), null);
  assert.equal(safeHttpsUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpsUrl("not a url"), null);
  assert.equal(safeHttpsUrl(null), null);
});

test("snapshots, the open question and when to keep following", () => {
  assert.equal(isFeedSnapshot(feed()), true);
  assert.equal(isFeedSnapshot({ rev: "r1", unchanged: true }), false);
  assert.equal(isFeedSnapshot(null), false);

  assert.equal(openHumanAsk(feed()), null);
  const question = {
    humanAskId: "h1",
    state: "open",
    answeredBy: null,
    answerText: null,
    questions: [
      { id: "q1", question: "Send it?", options: [], allowsText: false },
    ],
  };
  assert.equal(openHumanAsk(feed({ humanAsk: question }))?.humanAskId, "h1");
  assert.equal(
    openHumanAsk(feed({ humanAsk: { ...question, state: "answered" } })),
    null,
  );

  assert.equal(feedWantsMore(null), true);
  assert.equal(feedWantsMore(feed()), true);
  assert.equal(feedWantsMore(feed({ state: "ended" })), false);
  assert.equal(
    feedWantsMore(feed({ state: "ended", contract: 2, recap: null })),
    true,
  );
  assert.equal(
    feedWantsMore(
      feed({ state: "ended", contract: 2, recap: { summary: null } }),
    ),
    true,
  );
  assert.equal(
    feedWantsMore(
      feed({ state: "ended", contract: 2, recap: { summary: "- Sent" } }),
    ),
    false,
  );
});

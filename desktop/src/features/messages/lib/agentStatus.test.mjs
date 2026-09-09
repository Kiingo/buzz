import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentStatusRow } from "../ui/AgentStatusRow.tsx";
import { MessageThreadRow } from "../ui/MessageThreadRow.tsx";
import { parseAgentStatus } from "./agentStatus.ts";
import {
  isTimelineContentEvent,
  formatTimelineMessages,
} from "./formatTimelineMessages.ts";
import {
  buildMainTimelineEntries,
  buildThreadPanelData,
  buildThreadSummaryFromVisibleEntries,
} from "./threadPanel.ts";
import { buildTimelineItems } from "./timelineItems.ts";
import {
  CHANNEL_EVENT_KINDS,
  CHANNEL_MESSAGE_EVENT_KINDS,
  CHANNEL_TIMELINE_CONTENT_KINDS,
  isConversationalUnreadKind,
} from "@/shared/constants/kinds";

const root = "a".repeat(64);
const channel = "a0000000-0000-4000-8000-000000000001";
const receipt = "b0000000-0000-4000-8000-000000000001";
function event(overrides = {}) {
  return {
    id: "b".repeat(64),
    pubkey: "c".repeat(64),
    kind: 40098,
    created_at: 10,
    tags: [
      ["h", channel],
      ["e", root, "", "reply"],
      ["d", "fence"],
    ],
    content: JSON.stringify({
      version: 1,
      receipt_id: receipt,
      state: "cancelled",
      text: "Cancelled by the user.",
    }),
    ...overrides,
  };
}

test("operational status is durable readable system content, not an unread chat message", () => {
  const status = event();
  assert.equal(parseAgentStatus(status)?.rootId, root);
  assert.equal(isTimelineContentEvent(status), true);
  assert.equal(CHANNEL_EVENT_KINDS.includes(40098), true);
  assert.equal(CHANNEL_TIMELINE_CONTENT_KINDS.includes(40098), true);
  assert.equal(CHANNEL_MESSAGE_EVENT_KINDS.includes(40098), false);
  assert.equal(isConversationalUnreadKind(40098), false);
  const [message] = formatTimelineMessages([status], null, undefined, null);
  assert.equal(message.parentId, root);
  assert.equal(message.signerPubkey, status.pubkey);
  assert.equal(buildMainTimelineEntries([message]).length, 0);
  assert.equal(
    buildTimelineItems([{ message, summary: null }], null).items.at(-1).kind,
    "system",
  );
});

test("malformed, actor-forged, root-channel, and chat status lookalikes do not render", () => {
  const base = event();
  const payload = JSON.parse(base.content);
  for (const invalid of [
    event({ kind: 9 }),
    event({ kind: 40099 }),
    event({ tags: [["h", channel]] }),
    event({ tags: [...base.tags, ["broadcast", "1"]] }),
    event({ tags: [...base.tags, ["actor", "d".repeat(64)]] }),
    event({ content: JSON.stringify({ ...payload, actor: "d".repeat(64) }) }),
    event({ content: JSON.stringify({ ...payload, state: "completed" }) }),
  ]) {
    assert.equal(parseAgentStatus(invalid), null);
    if (invalid.kind === 40098)
      assert.equal(isTimelineContentEvent(invalid), false);
  }
});

test("the real status row is plain signer-attributed text, with no chat actions", () => {
  const [message] = formatTimelineMessages([event()], null, undefined, null);
  const markup = renderToStaticMarkup(
    createElement(AgentStatusRow, { message }),
  );
  assert.match(markup, /System status/);
  assert.match(markup, /Cancelled by the user\./);
  assert.match(markup, new RegExp(`data-thread-root="${root}"`));
  assert.doesNotMatch(markup, /<button|removed a message|message_deleted/);
  assert.equal(
    renderToStaticMarkup(
      createElement(AgentStatusRow, {
        message: { ...message, parentId: null },
      }),
    ),
    "",
  );
});

test("the canonical thread row routes operational events to the system renderer", () => {
  const [message] = formatTimelineMessages([event()], null, undefined, null);
  const row = MessageThreadRow({ message });
  assert.equal(row.type, AgentStatusRow);
  const markup = renderToStaticMarkup(row);
  assert.match(markup, /System status/);
  assert.match(markup, /Cancelled by the user\./);
  assert.doesNotMatch(markup, /receipt_id|<button|message-actions/);
  assert.equal(
    renderToStaticMarkup(
      MessageThreadRow({ message: { ...message, parentId: null } }),
    ),
    "",
  );
});

test("status updates coalesce per signed actor, receipt, and thread in event-time order", () => {
  const older = event();
  const latest = event({ id: "d".repeat(64), created_at: 20 });
  const otherActor = event({ id: "e".repeat(64), pubkey: "f".repeat(64) });
  const otherReceipt = event({
    id: "1".repeat(64),
    content: JSON.stringify({
      ...JSON.parse(older.content),
      receipt_id: channel,
    }),
  });
  const otherThread = event({
    id: "2".repeat(64),
    tags: [
      ["h", channel],
      ["e", "3".repeat(64), "", "reply"],
      ["d", "other"],
    ],
  });
  const formatted = formatTimelineMessages(
    [latest, older, otherActor, otherReceipt, otherThread],
    null,
    undefined,
    null,
  );
  assert.deepEqual(
    new Set(formatted.map(({ id }) => id)),
    new Set([latest.id, otherActor.id, otherReceipt.id, otherThread.id]),
  );
});

test("operational rows stay visible in the thread without inflating reply counts or participants", () => {
  const rootEvent = event({
    id: root,
    kind: 9,
    tags: [["h", channel]],
    content: "Discuss this.",
  });
  const reply = event({
    id: "d".repeat(64),
    pubkey: "e".repeat(64),
    kind: 9,
    created_at: 11,
    content: "A contribution.",
  });
  const status = event({ created_at: 12 });
  const messages = formatTimelineMessages(
    [rootEvent, reply, status],
    null,
    undefined,
    null,
  );
  const panel = buildThreadPanelData(messages, root, null, new Set());
  assert.equal(panel.visibleReplies.length, 2);
  assert.equal(panel.totalReplyCount, 1);
  for (const summary of [
    buildMainTimelineEntries(messages)[0].summary,
    buildThreadSummaryFromVisibleEntries(root, panel.visibleReplies),
  ]) {
    assert.equal(summary.replyCount, 1);
    assert.equal(summary.lastReplyAt, 11);
    assert.deepEqual(
      summary.participants.map(({ id }) => id),
      [reply.pubkey],
    );
  }
  const statusOnly = formatTimelineMessages(
    [rootEvent, status],
    null,
    undefined,
    null,
  );
  assert.equal(buildMainTimelineEntries(statusOnly)[0].summary, null);
  assert.equal(
    buildThreadPanelData(statusOnly, root, null, new Set()).visibleReplies
      .length,
    1,
  );
});

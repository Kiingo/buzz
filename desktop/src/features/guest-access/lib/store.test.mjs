import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  closeApprovalReview,
  dismissGuestAlert,
  getGuestAccessSnapshot,
  guestApprovalIdOf,
  isGuestApprovalFeedItem,
  mergeGuestApprovalFeed,
  openApprovalReview,
  reconcilePendingApprovals,
  recordApprovalRequested,
  recordApprovalResolved,
  recordEndpointStatus,
  recordGuestAlert,
  resetGuestAccessStore,
  subscribeGuestAccessStore,
} from "./store.ts";
import { parseApproval } from "./wire.ts";

const AGENT = "b".repeat(64);

function entry(approvalId, createdAt = 100, extra = {}) {
  return {
    approvalId,
    eventId: `event-${approvalId}`,
    agentPubkey: AGENT,
    agentName: null,
    requesterName: null,
    summary: "Jess asked Atlas something that needs your approval.",
    createdAt,
    ...extra,
  };
}

function feed(needsAction = []) {
  return {
    feed: { mentions: [], needsAction, activity: [], agentActivity: [] },
    meta: { since: 0, total: 0, generatedAt: 0 },
  };
}

function approval(id, overrides = {}) {
  return parseApproval({
    approval_id: id,
    agent: { pubkey: AGENT, display_name: "Atlas" },
    requester: { pubkey: "c".repeat(64), display_name: "Jess", linked: true },
    question_text: "What did Ross decide about pricing?",
    draft_text: "Ross decided to hold prices.",
    state: "pending",
    created_at: "2026-10-10T07:00:00.000Z",
    ...overrides,
  });
}

beforeEach(() => resetGuestAccessStore());

test("a resolved approval leaves the pending set and closes its dialog", () => {
  recordApprovalRequested(entry("a1"));
  openApprovalReview("a1");
  assert.equal(getGuestAccessSnapshot().pending.length, 1);
  recordApprovalResolved("a1");
  assert.equal(getGuestAccessSnapshot().pending.length, 0);
  assert.equal(getGuestAccessSnapshot().openApprovalId, null);
  // A late duplicate 46040 for a resolved id does not resurrect it.
  recordApprovalRequested(entry("a1"));
  assert.equal(getGuestAccessSnapshot().pending.length, 0);
});

test("the pending poll is authoritative and never puts question text in the inbox", () => {
  recordApprovalRequested(entry("stale"));
  reconcilePendingApprovals([approval("live")]);
  const pending = getGuestAccessSnapshot().pending;
  assert.deepEqual(
    pending.map((row) => row.approvalId),
    ["live"],
  );
  assert.equal(
    pending[0].summary,
    "Jess asked Atlas something that needs your approval.",
  );
  assert.doesNotMatch(pending[0].summary, /pricing|hold prices/);
});

test("merging projects pending approvals into Needs Action idempotently", () => {
  const workflow = {
    id: "wf",
    kind: 46010,
    pubkey: "d".repeat(64),
    content: "",
    createdAt: 50,
    channelId: null,
    channelName: "",
    tags: [],
    category: "needs_action",
  };
  recordApprovalRequested(entry("a1", 200));
  recordApprovalRequested(entry("a2", 300, { eventId: null }));
  const once = mergeGuestApprovalFeed(feed([workflow]));
  const twice = mergeGuestApprovalFeed(once);
  const ids = twice.feed.needsAction.map((item) => item.id);
  assert.deepEqual(ids, ["guest-approval-a2", "event-a1", "wf"]);
  const guest = twice.feed.needsAction.filter(isGuestApprovalFeedItem);
  assert.equal(guest.length, 2);
  assert.equal(guestApprovalIdOf(guest[1]), "a1");
  assert.equal(guest[0].category, "needs_action");

  recordApprovalResolved("a1");
  recordApprovalResolved("a2");
  assert.deepEqual(
    mergeGuestApprovalFeed(twice).feed.needsAction.map((item) => item.id),
    ["wf"],
  );
});

test("an unchanged feed with nothing pending is returned as-is", () => {
  const original = feed([]);
  assert.equal(mergeGuestApprovalFeed(original), original);
});

test("alerts can be dismissed and listeners are notified", () => {
  let notified = 0;
  const unsubscribe = subscribeGuestAccessStore(() => {
    notified += 1;
  });
  recordGuestAlert({
    alertId: "x",
    eventId: "e",
    agentPubkey: AGENT,
    severity: "high",
    content: "Blocked",
    createdAt: 1,
  });
  recordGuestAlert({
    alertId: "x",
    eventId: "e",
    agentPubkey: AGENT,
    severity: "high",
    content: "Blocked",
    createdAt: 1,
  });
  assert.equal(getGuestAccessSnapshot().alerts.length, 1);
  dismissGuestAlert("x");
  assert.equal(getGuestAccessSnapshot().alerts.length, 0);
  assert.ok(notified >= 2);
  unsubscribe();
});

test("reset clears every community-scoped field", () => {
  recordApprovalRequested(entry("a1"));
  openApprovalReview("a1");
  recordEndpointStatus(AGENT.toUpperCase(), {
    status: "owner_unlinked",
    linkUrl: null,
    classifierMode: null,
    guestEndpointId: null,
  });
  assert.equal(
    getGuestAccessSnapshot().endpointStatus[AGENT].status,
    "owner_unlinked",
  );
  resetGuestAccessStore();
  const snapshot = getGuestAccessSnapshot();
  assert.equal(snapshot.pending.length, 0);
  assert.equal(snapshot.openApprovalId, null);
  assert.deepEqual(snapshot.endpointStatus, {});
  closeApprovalReview();
});

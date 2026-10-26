import assert from "node:assert/strict";
import test from "node:test";

import { canManageMessageForCurrentUser } from "@/features/messages/lib/canManageMessage";
import { formatTimelineMessages } from "@/features/messages/lib/formatTimelineMessages";
import { buildTimelineItems } from "@/features/messages/lib/timelineItems";

import {
  mirrorAwareAuthorLabel,
  mirrorAwareCopyText,
} from "./mirrorDisplay.ts";
import { agentDmMessageKinds, agentDmRowEqual } from "./timeline.ts";

const AGENT = "a".repeat(64);
const ROSS = "b".repeat(64);
const STRANGER = "c".repeat(64);
const DM_ID = "36411e44-0e2d-4cfe-bd6e-567eb169db9f";

function dm(overrides = {}) {
  return {
    id: DM_ID,
    name: "",
    channelType: "dm",
    visibility: "private",
    description: "",
    topic: null,
    purpose: null,
    memberCount: 2,
    memberPubkeys: [AGENT, ROSS],
    lastMessageAt: null,
    archivedAt: null,
    participants: ["Agent", "Ross"],
    participantPubkeys: [AGENT, ROSS],
    isMember: true,
    ttlSeconds: null,
    ttlDeadline: null,
    ...overrides,
  };
}

const PROFILES = {
  [AGENT]: {
    displayName: "Ross's agent",
    avatarUrl: "agent.png",
    isAgent: true,
  },
  [ROSS]: { displayName: "Ross", avatarUrl: "ross.png" },
};

let sequence = 0;
function event(kind, tags, overrides = {}) {
  sequence += 1;
  return {
    id: sequence.toString(16).padStart(64, "0"),
    pubkey: AGENT,
    kind,
    created_at: 1_700_000_000 + sequence,
    content: `content ${sequence}`,
    tags: [["h", DM_ID], ...tags],
    sig: "sig",
    ...overrides,
  };
}

function mirror(pubkey, role = "requester") {
  return event(40002, [
    ["buzz-mirror", "email", "msg-1", "1760000000"],
    ["buzz-mirror-author", role, pubkey, "Claimed Name"],
  ]);
}

function format(events, channel = dm()) {
  return formatTimelineMessages(events, channel, ROSS, "me.png", PROFILES);
}

test("a requester mirror takes the member's identity; manage stays with the signer", () => {
  const [row] = format([mirror(ROSS)]);
  assert.equal(row.pubkey, ROSS);
  assert.equal(row.signerPubkey, AGENT);
  assert.equal(row.author, "Ross");
  assert.equal(row.avatarUrl, "me.png");
  assert.equal(row.isAgent, false);
  assert.equal(row.agentDmMarkers, true);
  assert.deepEqual(agentDmMessageKinds(row), ["mirror"]);
  // Ross does not own this agent here, so he cannot edit or delete the
  // agent-signed mirror even though it is displayed as his.
  assert.equal(canManageMessageForCurrentUser(row, ROSS, PROFILES), false);
  const owned = {
    ...PROFILES,
    [AGENT]: { ...PROFILES[AGENT], ownerPubkey: ROSS },
  };
  assert.equal(canManageMessageForCurrentUser(row, ROSS, owned), true);
});

test("a mirror that fails the override rule stays the signer's row", () => {
  for (const candidate of [
    mirror(STRANGER),
    mirror(AGENT),
    mirror(""),
    mirror(ROSS, "agent"),
  ]) {
    const [row] = format([candidate]);
    assert.equal(row.pubkey, AGENT);
    assert.equal(row.author, "Ross's agent");
    assert.equal(row.agentDmMarkers, true);
  }
  // A signer not known to be an agent never takes another member's identity.
  const [human] = formatTimelineMessages([mirror(ROSS)], dm(), ROSS, null, {
    [ROSS]: PROFILES[ROSS],
  });
  assert.equal(human.pubkey, AGENT);
});

test("markers outside a DM or from a non-member are plain messages", () => {
  const [stream] = format([mirror(ROSS)], dm({ channelType: "stream" }));
  assert.equal(stream.pubkey, AGENT);
  assert.equal(stream.agentDmMarkers, undefined);
  const [outsider] = format([{ ...mirror(ROSS), pubkey: STRANGER }]);
  assert.equal(outsider.pubkey, STRANGER);
  assert.equal(outsider.agentDmMarkers, undefined);
  const state = event(40002, [["buzz-question-state", "ask-1", "closed"]]);
  assert.equal(format([state], dm({ channelType: "stream" })).length, 1);
});

function question(askId = "ask-1") {
  return event(9, [
    ["buzz-question", askId],
    ["buzz-question-item", "q1", "Which plan?", "", "0", "0"],
    ["buzz-question-option", "q1", "Basic", ""],
  ]);
}

test("question-state events render no row and close or answer the card", () => {
  const ask = question();
  const closed = format([
    ask,
    event(40002, [["buzz-question-state", "ask-1", "closed"]]),
  ]);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].agentDmQuestionState, "closed");

  const expired = format([
    ask,
    event(40002, [["buzz-question-state", "ask-1", "expired"]]),
  ]);
  assert.equal(expired[0].agentDmQuestionState, "closed");

  assert.equal(format([ask])[0].agentDmQuestionState, "open");

  const answered = format([
    ask,
    event(9, [["buzz-answer", "ask-1"]], { pubkey: ROSS, content: "Basic" }),
  ]);
  assert.equal(answered[0].agentDmQuestionState, "answered");
  assert.equal(answered.length, 2, "the answer stays visible as a message");

  // The agent's own buzz-answer tag and other asks do not answer the card.
  const unrelated = format([
    ask,
    event(9, [["buzz-answer", "ask-1"]]),
    event(9, [["buzz-answer", "ask-2"]], { pubkey: ROSS }),
  ]);
  assert.equal(unrelated[0].agentDmQuestionState, "open");
});

test("session dividers render as system rows that break message grouping", () => {
  const before = event(9, []);
  const divider = event(40002, [["buzz-session", "new", ""]]);
  const after = event(9, []);
  const rows = format([before, divider, after]);
  const items = buildTimelineItems(
    rows.map((message) => ({ message, summary: null })),
    null,
  ).items.filter((item) => item.kind !== "day-divider");
  assert.deepEqual(
    items.map((item) => item.kind),
    ["message", "system", "message"],
  );
  assert.equal(items[2].isContinuation, false);
});

test("the row comparator tracks the projection fields", () => {
  const [row] = format([question()]);
  assert.equal(agentDmRowEqual(row, { ...row }), true);
  assert.equal(
    agentDmRowEqual(row, { ...row, agentDmQuestionState: "closed" }),
    false,
  );
  assert.equal(
    agentDmRowEqual(row, { ...row, agentDmMarkers: undefined }),
    false,
  );
});

function tasksMirror(pubkey = ROSS) {
  return event(40002, [
    ["buzz-mirror", "tasks", "task-1", "1760000000"],
    ["buzz-mirror-author", "requester", pubkey, "Claimed Name"],
  ]);
}

test("a relayed requester mirror row is never drawn like the viewer's own message", () => {
  const [row] = format([tasksMirror()]);
  assert.equal(row.pubkey, ROSS);
  assert.equal(row.author, "Ross");
  assert.equal(row.accent, false, "no own-message accent");
  assert.equal(row.agentDmMirror?.relayed, true);
  assert.equal(
    row.agentDmMirror?.relayLine,
    "via Kiingo Tasks · relayed by Ross's agent",
  );
  // A signer-attributed requester mirror is relayed too.
  const [fallback] = format([tasksMirror(STRANGER)]);
  assert.equal(fallback.pubkey, AGENT);
  assert.equal(fallback.agentDmMirror?.relayed, true);
  // The agent's own mirror keeps the plain badge.
  const [own] = format([mirror(ROSS, "agent")]);
  assert.equal(own.agentDmMirror?.relayed, false);
  assert.equal(own.agentDmMirror?.relayLine, "via email");
});

test("a relayed row never groups with messages its displayed author signed", () => {
  const real = event(9, [], { pubkey: ROSS });
  const relayed = tasksMirror();
  const realAfter = event(9, [], { pubkey: ROSS });
  const rows = format([real, relayed, realAfter]);
  const items = buildTimelineItems(
    rows.map((message) => ({ message, summary: null })),
    null,
  ).items.filter((item) => item.kind === "message");
  assert.deepEqual(
    items.map((item) => item.isContinuation),
    [false, false, false],
  );
});

test("copy and reply labels of a relayed row use the relayed form", () => {
  const [row] = format([tasksMirror()]);
  assert.equal(
    mirrorAwareCopyText(row),
    `Ross (via Kiingo Tasks, relayed by Ross's agent): ${row.body}`,
  );
  assert.equal(mirrorAwareAuthorLabel(row), "Ross (relayed by Ross's agent)");
});

test("the row comparator tracks the mirror display", () => {
  const [row] = format([tasksMirror()]);
  assert.equal(agentDmRowEqual(row, { ...row }), true);
  assert.equal(
    agentDmRowEqual(row, { ...row, agentDmMirror: undefined }),
    false,
  );
});

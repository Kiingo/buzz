import assert from "node:assert/strict";
import test from "node:test";

import {
  MASTER_SWITCH_LABEL,
  SETTINGS_SECTION_LABEL,
  channelTarget,
  promptActionLabel,
  readKindsLabel,
  remainingLabel,
  requesterLines,
  scopeLabel,
} from "./display.ts";

const SELF = "a".repeat(64);
const PEER = "b".repeat(64);
const channels = [
  {
    id: "c1",
    name: "launch",
    channelType: "stream",
    memberCount: 12,
    participants: [],
    participantPubkeys: [],
  },
  {
    id: "d1",
    name: "",
    channelType: "dm",
    memberCount: 2,
    participants: ["Ross", "Alice"],
    participantPubkeys: [SELF, PEER],
  },
];

function prompt(overrides) {
  return {
    requestId: "r",
    method: "publish",
    action: "send_message",
    serverActionLabel: null,
    kind: 9,
    content: "hi",
    channelId: "c1",
    reportedChannelId: "c1",
    targetEventId: null,
    targetContent: null,
    mentions: [],
    isReply: false,
    read: null,
    requester: {
      mcpClient: "Kiingo MCP",
      sessionId: null,
      jobId: null,
      agentId: null,
      label: null,
    },
    deadlineMs: 0,
    ...overrides,
  };
}

test("labels name the service and the switch", () => {
  assert.equal(SETTINGS_SECTION_LABEL, "Kiingo signing");
  assert.equal(MASTER_SWITCH_LABEL, "Allow Kiingo to request signatures");
});

test("channels resolve locally with member counts, and DMs name the peer", () => {
  assert.deepEqual(channelTarget("c1", channels, SELF), {
    label: "#launch",
    detail: "12 members",
    known: true,
  });
  assert.equal(channelTarget("d1", channels, SELF).label, "DM with Alice");
  assert.equal(channelTarget("zz", channels, SELF).known, false);
  assert.equal(channelTarget(null, channels, SELF), null);
});

test("action labels come from what is signed, not the requester's text", () => {
  assert.equal(
    promptActionLabel(prompt({ serverActionLabel: "Harmless" })),
    "Post a message",
  );
  assert.equal(
    promptActionLabel(prompt({ isReply: true })),
    "Reply in a thread",
  );
  assert.equal(
    promptActionLabel(prompt({ kind: 9005, content: "" })),
    "Delete your message",
  );
  assert.equal(
    promptActionLabel(prompt({ method: "read", action: "search_messages" })),
    "Search your messages",
  );
});

test("read scopes and scopes read plainly", () => {
  assert.equal(
    readKindsLabel([9, 40002, 39000]),
    "messages and channel details",
  );
  assert.equal(
    scopeLabel(
      {
        id: "s",
        kind: "publish",
        kinds: [9, 7],
        channelId: "c1",
        createdAt: 0,
        expiresAt: 0,
      },
      channels,
      SELF,
    ),
    "Message, Reaction in #launch",
  );
  assert.equal(
    scopeLabel(
      {
        id: "s",
        kind: "read",
        kinds: [],
        channelId: null,
        createdAt: 0,
        expiresAt: 0,
      },
      channels,
      SELF,
    ),
    "Read all your channels",
  );
});

test("remaining time and requester lines", () => {
  assert.equal(remainingLabel(15 * 60_000, 0), "15 min left");
  assert.equal(remainingLabel(90 * 60_000, 0), "1 h 30 min left");
  assert.deepEqual(
    requesterLines({
      mcpClient: "Kiingo MCP",
      sessionId: "s1",
      jobId: null,
      agentId: "agent-7",
      label: null,
    }),
    ["Kiingo MCP", "Agent agent-7", "Session s1"],
  );
});

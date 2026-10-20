import assert from "node:assert/strict";
import test from "node:test";

import { formatTimelineMessages } from "@/features/messages/lib/formatTimelineMessages";

import {
  callTitle,
  mirrorBadgeLabel,
  parseCall,
  splitCallContent,
} from "./markers.ts";
import { isAgentDmQuietEvent } from "./quiet.ts";
import { agentDmMessageKinds } from "./timeline.ts";

const AGENT = "a".repeat(64);
const ROSS = "b".repeat(64);
const DM_ID = "36411e44-0e2d-4cfe-bd6e-567eb169db9f";
const DM = {
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
};

const CONTENT =
  "Call · 3 min\n\nWe agreed to move the review to Friday.\n\nTranscript\nYou: Can we move it?\nAgent: Friday works.";

function callTags(extra = [["buzz-call", "outbound", "170", "web"]]) {
  return [
    ["h", DM_ID],
    ["buzz-mirror", "voice", "call-1", "1760000000"],
    ["buzz-mirror-author", "agent", "", ""],
    ...extra,
  ];
}

test("a voice mirror with exactly one buzz-call tag is a call card", () => {
  assert.deepEqual(parseCall(callTags()), {
    direction: "outbound",
    durationS: 170,
    surface: "web",
  });
  assert.equal(parseCall(callTags([])), null, "no buzz-call");
  assert.equal(
    parseCall(
      callTags([
        ["buzz-call", "inbound", "60", "web"],
        ["buzz-call", "inbound", "60", "web"],
      ]),
    ),
    null,
    "two buzz-call tags",
  );
  assert.equal(parseCall(callTags([["buzz-call", "inbound", "60"]])), null);
  assert.equal(
    parseCall(callTags([["buzz-call", "inbound", "60", "web", "x"]])),
    null,
  );
  assert.equal(
    parseCall(callTags([["buzz-call", "sideways", "60", "web"]])),
    null,
  );
  assert.equal(
    parseCall(callTags([["buzz-call", "inbound", "-1", "web"]])),
    null,
  );
  assert.equal(
    parseCall(callTags([["buzz-call", "inbound", "60", "Web"]])),
    null,
  );
  const email = callTags().map((tag) =>
    tag[0] === "buzz-mirror" ? ["buzz-mirror", "email", "m", "1"] : tag,
  );
  assert.equal(parseCall(email), null, "only voice mirrors");
});

test("titles round to whole minutes and never go below one", () => {
  const title = (durationS) =>
    callTitle({ direction: "inbound", durationS, surface: "web" });
  assert.equal(title(0), "Call · 1 min");
  assert.equal(title(29), "Call · 1 min");
  assert.equal(title(170), "Call · 3 min");
  assert.equal(title(3600), "Call · 60 min");
});

test("content splits into the summary and the transcript", () => {
  assert.deepEqual(splitCallContent(CONTENT), {
    summary: "We agreed to move the review to Friday.",
    transcript: "You: Can we move it?\nAgent: Friday works.",
  });
  assert.deepEqual(splitCallContent("Call · 1 min\n\nShort call."), {
    summary: "Short call.",
    transcript: null,
  });
  assert.deepEqual(splitCallContent("Just a summary"), {
    summary: "Just a summary",
    transcript: null,
  });
});

test("a voice mirror without buzz-call is badged via voice call", () => {
  assert.equal(mirrorBadgeLabel("voice"), "via voice call");
});

test("call cards stay quiet and render as call rows in the timeline", () => {
  const event = {
    id: "f".repeat(64),
    pubkey: AGENT,
    kind: 40002,
    created_at: 1_760_000_100,
    content: CONTENT,
    tags: callTags(),
    sig: "sig",
  };
  assert.equal(isAgentDmQuietEvent(event, DM), true);
  const [row] = formatTimelineMessages([event], DM, ROSS, null, {
    [AGENT]: { displayName: "Agent", isAgent: true },
  });
  assert.deepEqual(agentDmMessageKinds(row), ["mirror", "call"]);
  const [plain] = formatTimelineMessages(
    [{ ...event, tags: callTags([]) }],
    DM,
    ROSS,
    null,
    { [AGENT]: { displayName: "Agent", isAgent: true } },
  );
  assert.deepEqual(agentDmMessageKinds(plain), ["mirror"]);
});

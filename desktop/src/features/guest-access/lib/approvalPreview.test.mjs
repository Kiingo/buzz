import assert from "node:assert/strict";
import test from "node:test";

import { approvalPreviewSentence } from "./approvalPreview.ts";
import { parseApproval } from "./wire.ts";

function approval(previewOverrides = {}, extra = {}) {
  return parseApproval({
    approval_id: "ap-1",
    agent: { display_name: "Atlas" },
    requester: { pubkey: "c".repeat(64), display_name: "Jess", linked: true },
    channel: { type: "dm", audience_total: 2 },
    reason_codes: ["owner_data_requested"],
    preview: {
      agent_name: "Atlas",
      recipient_name: "Jess",
      action: "read_and_reply",
      sources: [{ id: "calendar_events", label: "your calendar events" }],
      destination: "dm",
      audience_total: 2,
      scope: "once",
      summary:
        "Atlas will read your calendar events and reply to Jess in this DM, once.",
      ...previewOverrides,
    },
    ...extra,
  });
}

const once = { scope: "once", days: 7 };

test("names what will be read, who gets the reply, where, and how often", () => {
  assert.equal(
    approvalPreviewSentence(approval(), {
      sharedSources: ["calendar_events"],
      grant: once,
      writingReply: false,
    }),
    "Atlas will read your calendar events and reply to Jess in this DM, once.",
  );
  assert.equal(
    approvalPreviewSentence(approval(), {
      sharedSources: ["calendar_events", "outlook_mailbox", "kiingo_files"],
      grant: { scope: "person_days", days: 30 },
      writingReply: false,
    }),
    "Atlas will read your calendar events, your Outlook mailbox and your Kiingo files and reply to Jess in this DM and keep answering them for 30 days without asking you.",
  );
});

test("with nothing ticked it asks the owner to choose", () => {
  assert.equal(
    approvalPreviewSentence(approval(), {
      sharedSources: [],
      grant: once,
      writingReply: false,
    }),
    "Choose what Atlas may read before it replies to Jess in this DM, once.",
  );
});

test("a channel reply says how many people can see it", () => {
  assert.equal(
    approvalPreviewSentence(
      approval(
        { destination: "channel", audience_total: 12 },
        { channel: { type: "channel", name: "ops", audience_total: 12 } },
      ),
      { sharedSources: ["calendar_events"], grant: once, writingReply: false },
    ),
    "Atlas will read your calendar events and reply to Jess in #ops, where 12 people can see it, once.",
  );
});

test("writing the reply yourself, and held drafts, use the right sentence", () => {
  assert.equal(
    approvalPreviewSentence(approval(), {
      sharedSources: ["calendar_events"],
      grant: once,
      writingReply: true,
    }),
    "Your reply goes to Jess in this DM. Atlas won't read anything.",
  );
  const draft = approval({
    action: "send_draft",
    summary:
      "Atlas will send its drafted reply, which uses your calendar events, to Jess in this DM.",
  });
  assert.equal(
    approvalPreviewSentence(draft, {
      sharedSources: [],
      grant: once,
      writingReply: false,
    }),
    "Atlas will send its drafted reply, which uses your calendar events, to Jess in this DM.",
  );
});

test("no preview from the route means no sentence", () => {
  const legacy = parseApproval({ approval_id: "ap-2" });
  assert.equal(
    approvalPreviewSentence(legacy, {
      sharedSources: ["calendar_events"],
      grant: once,
      writingReply: false,
    }),
    null,
  );
});

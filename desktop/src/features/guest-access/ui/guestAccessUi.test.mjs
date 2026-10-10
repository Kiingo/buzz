import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { parseApproval } from "../lib/wire.ts";
import { ApprovalDetails } from "./ApprovalDetails.tsx";
import { GrantScopePicker, grantForChoice } from "./GrantScopePicker.tsx";
import { GuestAlertBanner } from "./GuestAlertBanner.tsx";
import { guestMarkerView } from "./GuestReplyMarker.tsx";
import { isPlausibleLinkCode, normalizeLinkCode } from "./LinkAccountForm.tsx";
import { shouldShowLinkPrompt } from "./LinkAccountPrompt.tsx";

const approval = parseApproval({
  approval_id: "ap-1",
  agent: { pubkey: "b".repeat(64), display_name: "Atlas" },
  requester: { pubkey: "c".repeat(64), display_name: "Jess", linked: true },
  question_text: "When is Ross free on Thursday, and why is he out?",
  draft_text: "Ross is out Thursday 2–4pm for a dentist appointment.",
  data_sources: ["calendar_free_busy", "calendar_details"],
  owner_only_sources: ["calendar_details"],
  classifier: {
    route: "approve",
    categories: ["needs_owner_data"],
    top_scores: { extraction_attempt: 0.42 },
  },
  reason_codes: ["owner_only_data"],
  channel: { type: "channel", name: "agent-lab", audience_total: 7 },
  state: "pending",
});

test("review shows the exact draft, requester, venue, sources and plain reasons", () => {
  const html = renderToStaticMarkup(
    React.createElement(ApprovalDetails, { approval }),
  );
  assert.match(html, /Ross is out Thursday 2–4pm for a dentist appointment\./);
  assert.match(html, /When is Ross free on Thursday/);
  assert.match(html, />Jess</);
  assert.match(html, /Linked account/);
  assert.match(html, /agent-lab/);
  assert.match(html, /7 people can see the reply/);
  assert.match(html, /Calendar free\/busy/);
  assert.match(html, /Calendar event details · only you can see this/);
  assert.match(html, /uses information only you can see/);
  assert.match(html, /Answering needs information only you can see\./);
  assert.match(html, /extraction attempt 42%/);
});

test("an unlinked requester can only be approved once", () => {
  const html = renderToStaticMarkup(
    React.createElement(GrantScopePicker, {
      onChange: () => {},
      requesterLinked: false,
      requesterName: "Sam",
      value: { scope: "once", days: 7 },
    }),
  );
  const disabledRadios =
    html.match(/type="radio"[^>]*disabled=""|disabled=""[^>]*type="radio"/g) ??
    [];
  assert.equal(disabledRadios.length, 4);
  assert.match(html, /Sam hasn&#x27;t linked their account/);
});

test("grant choice maps to the decision body", () => {
  assert.equal(grantForChoice({ scope: "once", days: 7 }), null);
  assert.deepEqual(grantForChoice({ scope: "person_days", days: 30 }), {
    scope: "person_days",
    days: 30,
  });
  assert.deepEqual(grantForChoice({ scope: "always", days: 7 }), {
    scope: "always",
  });
});

test("high-severity alerts render first as an alert role", () => {
  const html = renderToStaticMarkup(
    React.createElement(GuestAlertBanner, {
      alerts: [
        {
          alertId: "i",
          eventId: "e1",
          agentPubkey: "b".repeat(64),
          severity: "info",
          content: "Your daily digest is ready.",
          createdAt: 2,
        },
        {
          alertId: "h",
          eventId: "e2",
          agentPubkey: "b".repeat(64),
          severity: "high",
          content: "A request to Atlas was blocked.",
          createdAt: 1,
        },
      ],
      onDismiss: () => {},
    }),
  );
  assert.ok(html.indexOf("was blocked") < html.indexOf("digest is ready"));
  assert.match(html, /role="alert"/);
  assert.equal(
    renderToStaticMarkup(
      React.createElement(GuestAlertBanner, {
        alerts: [],
        onDismiss: () => {},
      }),
    ),
    "",
  );
});

test("guest markers tell the asker what state their request is in", () => {
  const base = { requesterPubkey: "c".repeat(64), turnId: "gt" };
  assert.equal(
    guestMarkerView({ ...base, kind: "hold_notice" }, false).label,
    "Waiting for the owner",
  );
  assert.equal(
    guestMarkerView({ ...base, kind: "hold_notice" }, true).label,
    "Owner responded below",
  );
  assert.equal(
    guestMarkerView({ ...base, kind: "refusal" }, false).label,
    "Declined",
  );
  assert.equal(
    guestMarkerView({ ...base, kind: "approved_answer" }, false).label,
    "Guest reply · approved by owner",
  );
  assert.equal(
    guestMarkerView({ ...base, kind: "unknown" }, false).label,
    "Guest reply",
  );
});

test("link codes are normalized from pasted text", () => {
  assert.equal(
    normalizeLinkCode(" kiingo-ab12-cd34-ef56-7890 "),
    "KIINGO-AB12-CD34-EF56-7890",
  );
  assert.equal(
    normalizeLinkCode("/kiingo link KIINGO-AB12-CD34-EF56-7890"),
    "KIINGO-AB12-CD34-EF56-7890",
  );
  assert.equal(isPlausibleLinkCode("KIINGO-AB12-CD34-EF56-7890"), true);
  assert.equal(isPlausibleLinkCode("KIINGO-XYZ"), false);
});

test("the link prompt shows at most once a day", () => {
  const now = 10 * 24 * 60 * 60_000;
  assert.equal(shouldShowLinkPrompt(null, now), true);
  assert.equal(shouldShowLinkPrompt(String(now - 60_000), now), false);
  assert.equal(shouldShowLinkPrompt(String(now - 25 * 60 * 60_000), now), true);
});

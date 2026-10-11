import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { parseApproval } from "../lib/wire.ts";
import { ApprovalDetails } from "./ApprovalDetails.tsx";
import { GuestApprovalReview } from "./GuestApprovalReview.tsx";
import {
  SourcesToSharePicker,
  initialSharedSources,
} from "./SourcesToSharePicker.tsx";

function approval(overrides = {}) {
  return parseApproval({
    approval_id: "ap-9",
    agent: { pubkey: "b".repeat(64), display_name: "Atlas" },
    requester: { pubkey: "c".repeat(64), display_name: "Jess", linked: true },
    question_text: "What meetings does Ross have tomorrow?",
    draft_text: "I've asked Ross; I'll reply here when Ross answers.",
    reason_codes: ["owner_data_requested"],
    requested_sources: ["calendar_events"],
    requestable_sources: ["calendar_events", "outlook_mailbox", "kiingo_files"],
    channel: { type: "channel", name: "agent-lab", audience_total: 3 },
    state: "pending",
    ...overrides,
  });
}

function renderReview(record) {
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      React.createElement(GuestApprovalReview, { approval: record }),
    ),
  );
}

test("the hold message is not presented as the reply that will be sent", () => {
  const html = renderToStaticMarkup(
    React.createElement(ApprovalDetails, { approval: approval() }),
  );
  assert.match(html, /What they were told while you decide/);
  assert.doesNotMatch(html, /Reply that will be sent/);
  assert.match(html, /Nothing is shared unless you approve/);
});

test("named sources start checked and approve says what it does", () => {
  const html = renderReview(approval());
  assert.match(html, /What you&#x27;re sharing/);
  assert.match(html, /data-testid="guest-share-source-calendar_events"/);
  assert.doesNotMatch(html, /guest-share-source-outlook_mailbox/);
  assert.match(
    html,
    /type="checkbox"[^>]*checked=""|checked=""[^>]*type="checkbox"/,
  );
  assert.match(html, /Share and let Atlas answer/);
  assert.match(html, /Write the reply myself/);
  assert.match(html, /Just this once/);
});

test("with no named sources the owner must pick before approving", () => {
  const html = renderReview(approval({ requested_sources: [] }));
  assert.match(html, /Choose what to share/);
  for (const source of ["calendar_events", "outlook_mailbox", "kiingo_files"]) {
    assert.match(html, new RegExp(`guest-share-source-${source}`));
  }
  assert.match(html, /Choose at least one to approve/);
  assert.match(
    html,
    /data-testid="guest-approval-approve"[^>]*disabled=""|disabled=""[^>]*data-testid="guest-approval-approve"/,
  );
});

test("ordinary held drafts keep the original review", () => {
  const html = renderReview(
    approval({
      reason_codes: ["owner_only_data"],
      requested_sources: null,
      requestable_sources: null,
      draft_text: "Ross is free after 4pm.",
    }),
  );
  assert.doesNotMatch(html, /guest-sources-to-share/);
  assert.match(html, />Approve</);
  assert.match(html, /Edit then approve/);
});

test("initial selection and the picker's narrowing", () => {
  assert.deepEqual(initialSharedSources(["a", "b"], false), ["a", "b"]);
  assert.deepEqual(initialSharedSources(["a", "b"], true), []);
  const html = renderToStaticMarkup(
    React.createElement(SourcesToSharePicker, {
      agentName: "Atlas",
      mustChoose: false,
      onChange: () => {},
      selected: ["calendar_events"],
      sources: ["calendar_events", "outlook_mailbox"],
    }),
  );
  assert.match(html, /Calendar events/);
  assert.match(html, /Outlook mailbox/);
  assert.match(html, /answer once more using only what&#x27;s checked/);
});

test("the owner-data reason is not repeated by the classifier category", () => {
  const html = renderToStaticMarkup(
    React.createElement(ApprovalDetails, {
      approval: approval({
        classifier: { route: "approve", categories: ["needs_owner_data"] },
      }),
    }),
  );
  assert.equal(
    html.match(/Answering needs information only you can see/g).length,
    1,
  );
});

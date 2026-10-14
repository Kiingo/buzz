import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  dataSourceDescription,
  linkedAgoLabel,
  requestCountLabel,
} from "../lib/copy.ts";
import { parseApproval } from "../lib/wire.ts";
import { RequesterLine } from "./RequesterLine.tsx";
import { SourcesToSharePicker } from "./SourcesToSharePicker.tsx";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");

function requester(fields) {
  return parseApproval({ approval_id: "a", requester: fields }).requester;
}

test("request counts read as first, then ordinals", () => {
  assert.equal(requestCountLabel(0), "First request");
  assert.equal(requestCountLabel(1), "2nd request");
  assert.equal(requestCountLabel(2), "3rd request");
  assert.equal(requestCountLabel(3), "4th request");
  assert.equal(requestCountLabel(10), "11th request");
  assert.equal(requestCountLabel(20), "21st request");
});

test("linked-ago reads in days, months, then years", () => {
  assert.equal(linkedAgoLabel("2026-10-14T08:00:00.000Z", NOW), "linked today");
  assert.equal(
    linkedAgoLabel("2026-10-13T08:00:00.000Z", NOW),
    "linked yesterday",
  );
  assert.equal(
    linkedAgoLabel("2026-10-04T08:00:00.000Z", NOW),
    "linked 10 days ago",
  );
  assert.equal(
    linkedAgoLabel("2026-08-01T08:00:00.000Z", NOW),
    "linked 2 months ago",
  );
  assert.equal(
    linkedAgoLabel("2024-09-01T08:00:00.000Z", NOW),
    "linked 2 years ago",
  );
  assert.equal(linkedAgoLabel("not a date", NOW), null);
});

test("a test requester shows a TEST badge, kind and history", () => {
  const html = renderToStaticMarkup(
    React.createElement(RequesterLine, {
      requester: requester({
        pubkey: "c".repeat(64),
        display_name: "E2E Tester",
        linked: true,
        kind: "test",
        is_test: true,
        linked_at: "2026-10-14T08:00:00.000Z",
        prior_request_count: 0,
      }),
      nowMs: NOW,
    }),
  );
  assert.match(html, /E2E Tester/);
  assert.match(html, /data-testid="guest-approval-requester-test"/);
  assert.match(html, /TEST/);
  assert.match(html, /linked today · First request/);
  // "test" is already said by the badge; no duplicate kind badge.
  assert.doesNotMatch(html, /guest-approval-requester-kind/);
});

test("a new colleague shows the kind badge without a TEST badge", () => {
  const html = renderToStaticMarkup(
    React.createElement(RequesterLine, {
      requester: requester({
        display_name: "Jess",
        linked: true,
        kind: "new",
        linked_at: "2026-10-11T08:00:00.000Z",
        prior_request_count: 2,
      }),
      nowMs: NOW,
    }),
  );
  assert.match(html, />New</);
  assert.doesNotMatch(html, /TEST/);
  assert.match(html, /linked 3 days ago · 3rd request/);
});

test("an older route's requester renders the name and link state only", () => {
  const html = renderToStaticMarkup(
    React.createElement(RequesterLine, {
      requester: requester({ display_name: "Jess", linked: false }),
      nowMs: NOW,
    }),
  );
  assert.match(html, /Jess/);
  assert.match(html, /Not linked/);
  assert.doesNotMatch(html, /TEST|request|linked \d/);
});

test("with nothing requested, nothing is pre-ticked and each source says what it exposes", () => {
  const html = renderToStaticMarkup(
    React.createElement(SourcesToSharePicker, {
      agentName: "Atlas",
      mustChoose: true,
      onChange: () => {},
      selected: [],
      sources: ["calendar_events", "outlook_mailbox", "kiingo_files"],
    }),
  );
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /Choose at least one to approve/);
  for (const source of ["calendar_events", "outlook_mailbox", "kiingo_files"]) {
    assert.ok(dataSourceDescription(source));
    assert.match(html, new RegExp(`guest-share-source-${source}-description`));
  }
  assert.equal(dataSourceDescription("unknown_source"), null);
});

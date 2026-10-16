import assert from "node:assert/strict";
import test from "node:test";

import { adminAlertText, suspensionReasonText } from "./adminCopy.ts";
import { alertDestination, alertReviewLabel } from "./alertRoute.ts";

test("alert kinds open the place they point to", () => {
  assert.deepEqual(alertDestination("daily_digest"), {
    type: "agent",
    tab: "digest",
  });
  for (const kind of ["requester_suspended", "org_pattern"]) {
    assert.deepEqual(alertDestination(kind), { type: "admin" });
  }
  for (const kind of [
    "high_block",
    "requester_rate_limited",
    "budget_exhausted",
    null,
    undefined,
    "future_kind",
  ]) {
    assert.deepEqual(alertDestination(kind), {
      type: "agent",
      tab: "requests",
    });
  }
  assert.equal(alertDestination("agent_request_outcome"), null);
  assert.equal(alertReviewLabel(null), null);
  assert.equal(alertReviewLabel({ type: "admin" }), "Review in Settings");
  assert.equal(
    alertReviewLabel({ type: "agent", tab: "digest" }),
    "Open digest",
  );
});

test("admin alerts read as plain sentences", () => {
  const base = {
    alertId: "a1",
    severity: "high",
    requesterPubkey: "c".repeat(64),
    createdAt: null,
  };
  assert.match(
    adminAlertText(
      { ...base, kind: "requester_suspended", pattern: null, count: 2 },
      "Jess",
    ),
    /^Jess can't ask anyone's agents anything until an admin restores access\. .* 2 times in 24 hours\.$/,
  );
  assert.equal(
    adminAlertText(
      {
        ...base,
        kind: "org_pattern",
        pattern: "flagged_across_owners",
        count: 3,
      },
      "Jess",
    ),
    "Jess sent flagged requests to 3 different people's agents in 24 hours.",
  );
  assert.equal(
    suspensionReasonText("two_high_flags_24h"),
    "Two high-risk requests within 24 hours",
  );
  assert.equal(suspensionReasonText("other_code"), "other_code");
});

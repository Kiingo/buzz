import assert from "node:assert/strict";
import test from "node:test";

import { GuestAccessError } from "./lib/client.ts";
import { parseApproval } from "./lib/wire.ts";
import { submitApprovalDecision } from "./useApprovalDecision.ts";

const AGENT = "b".repeat(64);
const approval = parseApproval({
  approval_id: "ap-1",
  guest_turn_id: "gt-1",
  agent: { pubkey: AGENT, display_name: "Atlas" },
  requester: { pubkey: "c".repeat(64), linked: true },
  draft_text: "Draft",
  state: "pending",
});

function deps(overrides = {}) {
  const log = [];
  return {
    log,
    deps: {
      decide: async (id, input) => {
        log.push(["decide", id, input]);
      },
      sendControl: async (pubkey, payload) => {
        log.push(["control", pubkey, payload]);
      },
      resolved: (id) => log.push(["resolved", id]),
      ...overrides,
    },
  };
}

test("approve records the decision first, then sends the control frame", async () => {
  const { log, deps: d } = deps();
  const result = await submitApprovalDecision(
    approval,
    { decision: "approve", grant: { scope: "thread" } },
    "key-1",
    d,
  );
  assert.deepEqual(result, { alreadyDecided: false, rerunGuestTurnId: null });
  assert.deepEqual(
    log.map((entry) => entry[0]),
    ["decide", "resolved", "control"],
  );
  assert.deepEqual(log[0][2], {
    decision: "approve",
    editedText: undefined,
    grant: { scope: "thread" },
    idempotencyKey: "key-1",
  });
  assert.deepEqual(log[2], [
    "control",
    AGENT,
    { type: "approve_guest_reply", approvalId: "ap-1", guestTurnId: "gt-1" },
  ]);
});

test("deny never sends a grant and uses deny_guest_reply", async () => {
  const { log, deps: d } = deps();
  await submitApprovalDecision(
    approval,
    { decision: "deny_and_block", grant: { scope: "always" } },
    "key-2",
    d,
  );
  assert.equal(log[0][2].grant, null);
  assert.equal(log[2][2].type, "deny_guest_reply");
});

test("an API failure sends no control frame and leaves the request pending", async () => {
  const { log, deps: d } = deps({
    decide: async () => {
      throw new GuestAccessError("guest_route_unreachable", null);
    },
  });
  await assert.rejects(
    submitApprovalDecision(approval, { decision: "approve" }, "key-3", d),
    /Couldn't reach/,
  );
  assert.deepEqual(log, []);
});

test("already decided elsewhere clears local state without a control frame", async () => {
  const { log, deps: d } = deps({
    decide: async () => {
      throw new GuestAccessError("approval_already_decided", 409);
    },
  });
  const result = await submitApprovalDecision(
    approval,
    { decision: "approve" },
    "key-4",
    d,
  );
  assert.deepEqual(result, { alreadyDecided: true, rerunGuestTurnId: null });
  assert.deepEqual(log, [["resolved", "ap-1"]]);
});

test("a failed control frame does not fail the decision", async () => {
  const { log, deps: d } = deps({
    sendControl: async () => {
      throw new Error("agent offline");
    },
  });
  const result = await submitApprovalDecision(
    approval,
    { decision: "deny" },
    "key-5",
    d,
  );
  assert.deepEqual(result, { alreadyDecided: false, rerunGuestTurnId: null });
  assert.deepEqual(
    log.map((entry) => entry[0]),
    ["decide", "resolved"],
  );
});

const ownerDataApproval = parseApproval({
  approval_id: "ap-2",
  guest_turn_id: "gt-2",
  agent: { pubkey: AGENT, display_name: "Atlas" },
  requester: { pubkey: "c".repeat(64), linked: true },
  draft_text: "I've asked Ross; I'll reply here when Ross answers.",
  reason_codes: ["owner_data_requested"],
  requested_sources: ["calendar_events", "outlook_mailbox"],
  requestable_sources: ["calendar_events", "outlook_mailbox", "kiingo_files"],
  state: "pending",
});

test("owner-data approve sends the narrowed sources and returns the re-run id", async () => {
  const { log, deps: d } = deps({
    decide: async (id, input) => {
      log.push(["decide", id, input]);
      return { rerunGuestTurnId: "rerun-1" };
    },
  });
  const result = await submitApprovalDecision(
    ownerDataApproval,
    { decision: "approve", grantedSources: ["calendar_events"] },
    "key-6",
    d,
  );
  assert.deepEqual(result, {
    alreadyDecided: false,
    rerunGuestTurnId: "rerun-1",
  });
  assert.deepEqual(log[0][2].grantedSources, ["calendar_events"]);
  assert.equal(log[2][2].type, "approve_guest_reply");
});

test("granted sources are never sent with a deny or an edited reply", async () => {
  for (const decision of ["deny", "deny_and_block", "approve_edited"]) {
    const { log, deps: d } = deps();
    await submitApprovalDecision(
      ownerDataApproval,
      {
        decision,
        editedText: "My own reply",
        grantedSources: ["kiingo_files"],
      },
      `key-${decision}`,
      d,
    );
    assert.equal("grantedSources" in log[0][2], false, decision);
  }
});

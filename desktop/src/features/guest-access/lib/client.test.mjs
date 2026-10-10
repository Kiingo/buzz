import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  GuestAccessError,
  guestAccessApi,
  setGuestAccessTransportForTests,
  toGuestAccessError,
} from "./client.ts";

let restore = () => {};
afterEach(() => restore());

function capture(response = {}) {
  const calls = [];
  restore = setGuestAccessTransportForTests({
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      return typeof response === "function" ? response(path) : response;
    },
  });
  return calls;
}

test("route errors keep their contract code and get plain-language text", () => {
  const error = toGuestAccessError(
    new Error('{"status":403,"error":"owner_not_linked"}'),
  );
  assert.ok(error instanceof GuestAccessError);
  assert.equal(error.code, "owner_not_linked");
  assert.equal(error.status, 403);
  assert.match(error.message, /Link your account/);
  assert.equal(toGuestAccessError("boom").code, "request_failed");
});

test("pending approvals poll the owner route with state=pending", async () => {
  const calls = capture({ items: [{ approval_id: "a1" }] });
  const approvals = await guestAccessApi.pendingApprovals();
  assert.equal(approvals[0].approvalId, "a1");
  assert.deepEqual(calls[0], {
    method: "GET",
    path: "/owner/approvals?state=pending&limit=50",
    body: undefined,
  });
});

test("an edited approval sends the exact edited text and the grant", async () => {
  const calls = capture({ approval: { approval_id: "a1" }, grant: null });
  await guestAccessApi.decide("a1", {
    decision: "approve_edited",
    editedText: "Ross is busy Thursday afternoon.",
    grant: { scope: "person_days", days: 7 },
    idempotencyKey: "key-12345678",
  });
  assert.deepEqual(calls[0], {
    method: "POST",
    path: "/owner/approvals/a1/decision",
    body: {
      decision: "approve_edited",
      edited_text: "Ross is busy Thursday afternoon.",
      grant: { scope: "person_days", days: 7 },
      idempotency_key: "key-12345678",
    },
  });
});

test("a plain deny sends no edited text or grant", async () => {
  const calls = capture({});
  await guestAccessApi.decide("a1", {
    decision: "deny",
    idempotencyKey: "key-12345678",
  });
  assert.deepEqual(calls[0].body, {
    decision: "deny",
    idempotency_key: "key-12345678",
  });
});

test("identity link posts the trimmed code with the community id", async () => {
  const calls = capture({ linked: true, display_name: "Jess Doe" });
  const result = await guestAccessApi.linkIdentity(
    "chat.example.com",
    "  KIINGO-ABCD-1234-ABCD-1234 ",
  );
  assert.equal(result.displayName, "Jess Doe");
  assert.deepEqual(calls[0], {
    method: "POST",
    path: "/identity/link",
    body: {
      community_id: "chat.example.com",
      code: "KIINGO-ABCD-1234-ABCD-1234",
    },
  });
});

test("owner settings routes use the documented paths and bodies", async () => {
  const calls = capture({});
  await guestAccessApi.accessLog("ge-1");
  await guestAccessApi.block({ pubkey: "c".repeat(64) });
  await guestAccessApi.unblock("b1");
  await guestAccessApi.revokeGrant("g1");
  await guestAccessApi.addShareable({
    resourceKind: "status",
    content: "Heads down",
    expiresInDays: 7,
  });
  await guestAccessApi.decideSuggestion("s1", true);
  await guestAccessApi.setAgentEnabled("ge-1", false);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      "GET /owner/access-log?agent=ge-1&limit=50",
      "POST /owner/blocks",
      "DELETE /owner/blocks/b1",
      "DELETE /owner/grants/g1",
      "POST /owner/shareables",
      "POST /owner/suggestions/s1/accept",
      "PATCH /owner/agents/ge-1",
    ],
  );
  assert.deepEqual(calls[1].body, {
    guest_endpoint_id: null,
    pubkey: "c".repeat(64),
  });
  assert.deepEqual(calls[4].body, {
    resource_kind: "status",
    content: "Heads down",
    expires_in_days: 7,
  });
  assert.deepEqual(calls[6].body, { enabled: false });
});

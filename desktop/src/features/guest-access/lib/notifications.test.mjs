import assert from "node:assert/strict";
import test from "node:test";

import {
  createNotifierTrust,
  parseGuestNotification,
} from "./notifications.ts";

const OWNER = "a".repeat(64);
const AGENT = "b".repeat(64);
const OTHER = "c".repeat(64);
const APPROVAL = "0b6c9f3e-2d3b-4b8a-9d55-0f3c1d2e3f4a";
const NOW = 1_800_000_000;

function event(kind, tags, overrides = {}) {
  return {
    id: "e".repeat(64),
    pubkey: AGENT,
    kind,
    content: "Jess asked Atlas something that needs your approval.",
    created_at: NOW - 10,
    tags,
    sig: "f".repeat(128),
    ...overrides,
  };
}

const requested = (extra = []) =>
  event(46040, [
    ["p", OWNER],
    ["buzz-guest-approval", APPROVAL],
    ["agent", AGENT],
    ["expiration", String(NOW + 3600)],
    ["alt", "Approval requested"],
    ...extra,
  ]);

test("parses a 46040 approval request addressed to the owner", () => {
  const parsed = parseGuestNotification(requested(), OWNER, NOW);
  assert.equal(parsed?.type, "requested");
  assert.equal(parsed.approvalId, APPROVAL);
  assert.equal(parsed.agentPubkey, AGENT);
  assert.equal(parsed.expiresAt, NOW + 3600);
});

test("rejects requests for someone else, with extra p tags, h tags, or self-authored", () => {
  assert.equal(parseGuestNotification(requested(), OTHER, NOW), null);
  assert.equal(
    parseGuestNotification(requested([["p", OTHER]]), OWNER, NOW),
    null,
  );
  assert.equal(
    parseGuestNotification(requested([["h", "channel"]]), OWNER, NOW),
    null,
  );
  assert.equal(
    parseGuestNotification({ ...requested(), pubkey: OWNER }, OWNER, NOW),
    null,
  );
});

test("drops expired requests and malformed correlation ids", () => {
  const expired = event(46040, [
    ["p", OWNER],
    ["buzz-guest-approval", APPROVAL],
    ["agent", AGENT],
    ["expiration", String(NOW - 1)],
  ]);
  assert.equal(parseGuestNotification(expired, OWNER, NOW), null);
  const badId = event(46040, [
    ["p", OWNER],
    ["buzz-guest-approval", "../../etc"],
    ["agent", AGENT],
  ]);
  assert.equal(parseGuestNotification(badId, OWNER, NOW), null);
});

test("parses 46041 resolved with a known status only", () => {
  const resolved = event(46041, [
    ["p", OWNER],
    ["buzz-guest-approval", APPROVAL],
    ["agent", AGENT],
    ["status", "approved"],
  ]);
  assert.deepEqual(
    {
      ...parseGuestNotification(resolved, OWNER, NOW),
      eventId: undefined,
    },
    {
      type: "resolved",
      eventId: undefined,
      author: AGENT,
      approvalId: APPROVAL,
      agentPubkey: AGENT,
      status: "approved",
      createdAt: NOW - 10,
    },
  );
  const bogus = event(46041, [
    ["p", OWNER],
    ["buzz-guest-approval", APPROVAL],
    ["agent", AGENT],
    ["status", "maybe"],
  ]);
  assert.equal(parseGuestNotification(bogus, OWNER, NOW), null);
});

test("parses a high-severity 46042 alert", () => {
  const alert = event(
    46042,
    [
      ["p", OWNER],
      ["buzz-guest-alert", "alert-1"],
      ["severity", "high"],
      ["agent", AGENT],
    ],
    { content: "A request to Atlas was blocked." },
  );
  const parsed = parseGuestNotification(alert, OWNER, NOW);
  assert.equal(parsed?.type, "alert");
  assert.equal(parsed.severity, "high");
  assert.equal(parsed.content, "A request to Atlas was blocked.");
});

function trust({ local = [], profiles = {}, verify } = {}) {
  const calls = { fetch: 0, verify: 0 };
  const isTrusted = createNotifierTrust({
    ownerPubkey: OWNER,
    localAgentPubkeys: () => new Set(local),
    fetchProfileEvent: async (pubkey) => {
      calls.fetch += 1;
      const profile = profiles[pubkey];
      if (profile instanceof Error) throw profile;
      return profile ?? null;
    },
    verifyProfileOwner: async (json) => {
      calls.verify += 1;
      return verify(JSON.parse(json));
    },
  });
  return { isTrusted, calls };
}

test("trusts local managed agents without a lookup", async () => {
  const { isTrusted, calls } = trust({ local: [AGENT], verify: () => null });
  assert.equal(await isTrusted(AGENT), true);
  assert.equal(calls.fetch, 0);
});

test("trusts another agent only when its NIP-OA owner is this owner", async () => {
  const profiles = {
    [AGENT]: { pubkey: AGENT, kind: 0, tags: [["auth", OWNER, "", "sig"]] },
    [OTHER]: { pubkey: OTHER, kind: 0, tags: [["auth", OTHER, "", "sig"]] },
  };
  const { isTrusted, calls } = trust({
    profiles,
    verify: (profile) => profile.tags[0][1],
  });
  assert.equal(await isTrusted(AGENT), true);
  assert.equal(await isTrusted(OTHER), false);
  // Cached per author.
  assert.equal(await isTrusted(AGENT), true);
  assert.equal(calls.fetch, 2);
});

test("never trusts the owner key itself or a profile signed by someone else", async () => {
  const { isTrusted } = trust({
    profiles: { [AGENT]: { pubkey: OTHER, kind: 0, tags: [] } },
    verify: () => OWNER,
  });
  assert.equal(await isTrusted(OWNER), false);
  assert.equal(await isTrusted(AGENT), false);
});

test("a failed profile lookup is not cached", async () => {
  const profiles = { [AGENT]: new Error("relay down") };
  const { isTrusted, calls } = trust({ profiles, verify: () => OWNER });
  assert.equal(await isTrusted(AGENT), false);
  profiles[AGENT] = { pubkey: AGENT, kind: 0, tags: [] };
  assert.equal(await isTrusted(AGENT), true);
  assert.equal(calls.fetch, 2);
});

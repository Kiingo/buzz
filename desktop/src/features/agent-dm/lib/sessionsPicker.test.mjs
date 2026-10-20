import assert from "node:assert/strict";
import test from "node:test";

import {
  findFreshListing,
  findListingReply,
  LISTING_REUSE_SECONDS,
  LISTING_WAIT_MS,
  loadSessionCommand,
  NEW_SESSION_COMMAND,
  pickerReducer,
  SESSIONS_LIST_COMMAND,
} from "./sessionsPicker.ts";

const AGENT = "a".repeat(64);
const ROSS = "b".repeat(64);
const REQUEST_ID = "d".repeat(64);
const DM = {
  channelType: "dm",
  participantPubkeys: [AGENT, ROSS],
  memberPubkeys: [],
};
const NOW = 1_760_000_000;

function listing(id, createdAt, requestId = "", overrides = {}) {
  return {
    id,
    pubkey: AGENT,
    kind: 40002,
    created_at: createdAt,
    content: "1. Planning",
    tags: [
      ["h", "dm"],
      ["buzz-sessions", requestId],
      ["buzz-session-item", "s-1", "current", "1", "2", "Planning", "1", "3"],
    ],
    sig: "",
    ...overrides,
  };
}

test("commands match the contract exactly", () => {
  assert.equal(SESSIONS_LIST_COMMAND, "/sessions");
  assert.equal(NEW_SESSION_COMMAND, "/new");
  assert.equal(loadSessionCommand("s-1", false), "/sessions load s-1");
  assert.equal(loadSessionCommand("s-1", true), "/sessions load s-1 catchup");
  assert.equal(LISTING_REUSE_SECONDS, 120);
  assert.equal(LISTING_WAIT_MS, 15_000);
});

test("a listing under two minutes old is reused; older ones are not", () => {
  const events = [listing("old", NOW - 500), listing("new", NOW - 119)];
  assert.equal(findFreshListing(events, DM, AGENT, NOW)?.eventId, "new");
  assert.equal(
    findFreshListing([listing("stale", NOW - 120)], DM, AGENT, NOW),
    null,
  );
  // Only the agent's own honoured listings count.
  assert.equal(
    findFreshListing([listing("x", NOW, "", { pubkey: ROSS })], DM, AGENT, NOW),
    null,
  );
  assert.equal(
    findFreshListing(
      [listing("x", NOW)],
      { ...DM, channelType: "stream" },
      AGENT,
      NOW,
    ),
    null,
  );
});

test("a reply names our request or arrives after it", () => {
  const request = { eventId: REQUEST_ID, sentAt: NOW };
  assert.equal(
    findListingReply(
      [listing("named", NOW - 60, REQUEST_ID)],
      DM,
      AGENT,
      request,
    )?.eventId,
    "named",
  );
  assert.equal(
    findListingReply([listing("later", NOW + 2)], DM, AGENT, request)?.eventId,
    "later",
  );
  assert.equal(
    findListingReply([listing("before", NOW - 60)], DM, AGENT, request),
    null,
  );
  assert.equal(
    findListingReply(
      [listing("other", NOW + 2, "e".repeat(64))],
      DM,
      AGENT,
      request,
    ),
    null,
  );
});

test("picker transitions are fenced by request id", () => {
  let state = pickerReducer({ status: "idle" }, { type: "request-started" });
  assert.deepEqual(state, { status: "requesting" });
  const request = { eventId: REQUEST_ID, sentAt: NOW };
  state = pickerReducer(state, { type: "request-sent", request });
  assert.deepEqual(state, { status: "waiting", request });

  assert.equal(
    pickerReducer(state, { type: "timed-out", requestId: "other" }),
    state,
    "a stale timer is ignored",
  );
  assert.deepEqual(
    pickerReducer(state, { type: "timed-out", requestId: REQUEST_ID }),
    { status: "timeout" },
  );
  assert.deepEqual(
    pickerReducer(state, {
      type: "listing-arrived",
      listingEventId: "l-1",
      requestId: REQUEST_ID,
    }),
    { status: "ready", listingEventId: "l-1" },
  );
  const ready = { status: "ready", listingEventId: "l-1" };
  assert.equal(
    pickerReducer(ready, { type: "timed-out", requestId: REQUEST_ID }),
    ready,
    "a timer after the reply is ignored",
  );
  assert.deepEqual(
    pickerReducer(
      { status: "requesting" },
      {
        type: "request-failed",
        message: "offline",
      },
    ),
    { status: "error", message: "offline" },
  );
  assert.deepEqual(pickerReducer(ready, { type: "reset" }), { status: "idle" });
});

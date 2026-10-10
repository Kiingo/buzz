import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  isGuestTurnResolved,
  parseGuestReplyMarker,
  registerGuestReply,
  resetGuestTurns,
} from "./guestReply.ts";

const REQUESTER = "c".repeat(64);

beforeEach(() => resetGuestTurns());

test("ordinary messages have no guest marker", () => {
  assert.equal(parseGuestReplyMarker(undefined), null);
  assert.equal(parseGuestReplyMarker([["p", REQUESTER]]), null);
  assert.equal(parseGuestReplyMarker([["buzz-guest", "not-hex"]]), null);
});

test("reads requester, turn and kind; unknown kinds fall back", () => {
  assert.deepEqual(
    parseGuestReplyMarker([
      ["buzz-guest", REQUESTER.toUpperCase()],
      ["buzz-guest-turn", "gt-1"],
      ["buzz-guest-kind", "hold_notice"],
    ]),
    { requesterPubkey: REQUESTER, turnId: "gt-1", kind: "hold_notice" },
  );
  assert.equal(
    parseGuestReplyMarker([
      ["buzz-guest", REQUESTER],
      ["buzz-guest-kind", "mystery"],
    ]).kind,
    "unknown",
  );
});

test("a hold notice resolves once a later reply for the same turn appears", () => {
  const hold = {
    requesterPubkey: REQUESTER,
    turnId: "gt-1",
    kind: "hold_notice",
  };
  registerGuestReply(hold, 100);
  assert.equal(isGuestTurnResolved("gt-1"), false);
  // An outcome copy to the requesting agent's owner is not a resolution.
  registerGuestReply({ ...hold, kind: "outcome_copy" }, 150);
  assert.equal(isGuestTurnResolved("gt-1"), false);
  registerGuestReply({ ...hold, kind: "approved_answer" }, 200);
  assert.equal(isGuestTurnResolved("gt-1"), true);
  assert.equal(isGuestTurnResolved("other"), false);
  assert.equal(isGuestTurnResolved(null), false);
});

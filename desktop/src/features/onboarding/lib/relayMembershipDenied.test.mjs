import assert from "node:assert/strict";
import test from "node:test";

import { isRelayMembershipDeniedError } from "./relayMembershipDenied.ts";

test("recognizes relay membership and allowlist denials", () => {
  for (const message of [
    "You must be a relay member to do that",
    "relay_membership_required",
    "restricted: not a relay member",
    "restricted: pubkey not allowlisted",
    "invalid: you are not a relay member",
    "Relay session is terminal: restricted: not a relay member",
    "relay returned 403 Forbidden: You must be a relay member to access this relay",
  ]) {
    assert.equal(isRelayMembershipDeniedError(new Error(message)), true);
  }
});

test("treats retryable auth failures as ordinary errors", () => {
  assert.equal(
    isRelayMembershipDeniedError(
      new Error("auth-required: verification failed"),
    ),
    false,
  );
  assert.equal(
    isRelayMembershipDeniedError(new Error("relay unreachable: timed out")),
    false,
  );
});

test("ignores non-Error values", () => {
  assert.equal(
    isRelayMembershipDeniedError("restricted: not a relay member"),
    false,
  );
  assert.equal(isRelayMembershipDeniedError(undefined), false);
});

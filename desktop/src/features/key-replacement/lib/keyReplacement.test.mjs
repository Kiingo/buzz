import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  describeRemovalOutcome,
  describeRemovalReason,
  describeKeyReplacementError,
  describeOutcome,
  KeyReplacementError,
  keyReplacementApi,
  setKeyReplacementTransportForTests,
  toKeyReplacementError,
} from "./keyReplacement.ts";
import { offeredRemoval, offeredReplacement } from "./offer.ts";

const OLD = "6d".padEnd(64, "1");
const CURRENT = "3f".padEnd(64, "2");

let restore = () => {};
afterEach(() => restore());

test("the control is offered only when the native check offers it", () => {
  const status = {
    offer: true,
    currentPublicKey: CURRENT,
    replacement: { oldPublicKey: OLD.toUpperCase(), revokedAt: null },
  };
  assert.deepEqual(offeredReplacement(status), { old: OLD, current: CURRENT });
  assert.equal(offeredReplacement({ ...status, offer: false }), null);
  assert.equal(offeredReplacement({ ...status, replacement: null }), null);
  assert.equal(offeredReplacement(undefined), null);
  assert.equal(
    offeredReplacement({
      ...status,
      replacement: { oldPublicKey: "xyz", revokedAt: null },
    }),
    null,
  );
  assert.equal(
    offeredReplacement({
      ...status,
      replacement: { oldPublicKey: CURRENT, revokedAt: null },
    }),
    null,
  );
});

test("confirm sends exactly the key the owner saw, once", async () => {
  const calls = [];
  restore = setKeyReplacementTransportForTests({
    confirm: async (expected) => {
      calls.push(expected);
      return { accepted: true, message: "", confirmed: true };
    },
  });
  const outcome = await keyReplacementApi.confirm(OLD);
  assert.deepEqual(calls, [OLD]);
  assert.match(describeOutcome(outcome), /^Confirmed/);
});

test("a malformed key never reaches the native signer", async () => {
  let called = false;
  restore = setKeyReplacementTransportForTests({
    confirm: async () => {
      called = true;
      return { accepted: true, message: "", confirmed: true };
    },
  });
  await assert.rejects(
    keyReplacementApi.confirm("not-a-key"),
    KeyReplacementError,
  );
  assert.equal(called, false);
});

test("a native failure is one error, not a retry", async () => {
  let calls = 0;
  restore = setKeyReplacementTransportForTests({
    confirm: async () => {
      calls += 1;
      throw new Error('{"error":"key_replacement_changed"}');
    },
  });
  await assert.rejects(
    keyReplacementApi.confirm(OLD),
    (error) =>
      error instanceof KeyReplacementError &&
      error.code === "key_replacement_changed" &&
      /nothing was signed/.test(error.message),
  );
  assert.equal(calls, 1);
});

test("outcomes read in plain words", () => {
  assert.match(
    describeOutcome({ accepted: true, message: "", confirmed: true }),
    /replaced by your current key/,
  );
  assert.match(
    describeOutcome({ accepted: true, message: "", confirmed: false }),
    /check again/,
  );
  assert.match(
    describeOutcome({ accepted: false, message: "blocked", confirmed: false }),
    /didn't accept the request: blocked/,
  );
});

test("error codes map to one sentence each", () => {
  for (const code of [
    "key_replacement_not_admin",
    "key_replacement_none",
    "key_replacement_changed",
    "key_replacement_already_archived",
    "relay_unreachable",
    "hosted_agents_unreachable",
    "owner_proof_invalid",
    "owner_not_linked",
    "key_replacement_unavailable",
  ]) {
    const text = describeKeyReplacementError(code);
    assert.notEqual(text, describeKeyReplacementError("unknown"), code);
    assert.equal(text.split(".").length, 2, `${code}: one sentence`);
  }
  assert.equal(
    describeKeyReplacementError("buzz_hosted_owner_not_linked"),
    describeKeyReplacementError("owner_not_linked"),
  );
  assert.equal(toKeyReplacementError("boom").code, "request_failed");
});

test("the re-read is read-only and reports the relay's answer", async () => {
  const seen = [];
  restore = setKeyReplacementTransportForTests({
    confirmed: async (old) => {
      seen.push(old);
      return false;
    },
  });
  assert.equal(await keyReplacementApi.confirmed(OLD), false);
  assert.deepEqual(seen, [OLD]);
});

const RETIRED = "4d".padEnd(64, "3");

const withRemoval = (removal) => ({
  offer: false,
  currentPublicKey: CURRENT,
  replacement: null,
  removal,
});

test("the removal step appears only when the provider names a retired key", () => {
  assert.equal(offeredRemoval(withRemoval(null)), null);
  assert.equal(offeredRemoval(undefined), null);
  assert.deepEqual(
    offeredRemoval(
      withRemoval({
        publicKey: RETIRED.toUpperCase(),
        removable: true,
        reason: null,
      }),
    ),
    { publicKey: RETIRED, removable: true, reason: null },
  );
  // A malformed key is never offered.
  assert.equal(
    offeredRemoval(
      withRemoval({ publicKey: "xyz", removable: true, reason: null }),
    ),
    null,
  );
});

test("the removal step fails closed with a reason", () => {
  // The signed-in key itself is never removable, whatever the native side says.
  assert.deepEqual(
    offeredRemoval(
      withRemoval({ publicKey: CURRENT, removable: true, reason: null }),
    ),
    { publicKey: CURRENT, removable: false, reason: "is_current_key" },
  );
  for (const reason of ["not_owner", "not_a_member", "is_owner"]) {
    const step = offeredRemoval(
      withRemoval({ publicKey: RETIRED, removable: false, reason }),
    );
    assert.equal(step.removable, false, reason);
    assert.equal(step.reason, reason);
    const text = describeRemovalReason(reason);
    assert.notEqual(text, describeKeyReplacementError("unknown"), reason);
    assert.equal(text.split(".").length, 2, `${reason}: one sentence`);
  }
  // Inconsistent native answers are disabled, not enabled.
  assert.equal(
    offeredRemoval(
      withRemoval({ publicKey: RETIRED, removable: true, reason: "not_owner" }),
    ).removable,
    false,
  );
  assert.deepEqual(
    offeredRemoval(
      withRemoval({ publicKey: RETIRED, removable: false, reason: null }),
    ),
    { publicKey: RETIRED, removable: false, reason: "not_owner" },
  );
});

test("remove sends exactly the displayed key, once", async () => {
  const calls = [];
  restore = setKeyReplacementTransportForTests({
    remove: async (expected) => {
      calls.push(expected);
      return { accepted: true, message: "", removed: true };
    },
  });
  const outcome = await keyReplacementApi.remove(RETIRED);
  assert.deepEqual(calls, [RETIRED]);
  assert.match(describeRemovalOutcome(outcome), /^Removed/);
});

test("a malformed removal target never reaches the native signer", async () => {
  let called = false;
  restore = setKeyReplacementTransportForTests({
    remove: async () => {
      called = true;
      return { accepted: true, message: "", removed: true };
    },
  });
  await assert.rejects(keyReplacementApi.remove(""), KeyReplacementError);
  await assert.rejects(keyReplacementApi.remove("zz"), KeyReplacementError);
  assert.equal(called, false);
});

test("a native removal refusal is one error, not a retry", async () => {
  let calls = 0;
  restore = setKeyReplacementTransportForTests({
    remove: async () => {
      calls += 1;
      throw new Error('{"error":"removal_changed"}');
    },
  });
  await assert.rejects(
    keyReplacementApi.remove(RETIRED),
    (error) =>
      error instanceof KeyReplacementError &&
      /nothing was signed/.test(error.message),
  );
  assert.equal(calls, 1);
  assert.match(
    describeRemovalOutcome({ accepted: true, message: "", removed: false }),
    /check again/,
  );
});

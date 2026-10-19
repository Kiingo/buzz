import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { hostedOwnerRelinkApi, setRelinkTransportForTests } from "./client.ts";
import {
  agentsToSend,
  currentAgents,
  describeOutcome,
  describeRejection,
  describeRequestError,
  isRetryable,
  MAX_REBIND_AGENTS,
  mergeResults,
  RelinkRequestError,
  selectableAgents,
  staleAgents,
  toRelinkRequestError,
} from "./relink.ts";

const CURRENT = "a".repeat(64);
const OLD = "b".repeat(64);

const agent = (id, ownerPublicKey, extra = {}) => ({
  providerAgentId: id,
  agentPublicKey: id.padEnd(64, "0").slice(0, 64),
  displayName: id,
  ownerPublicKey,
  deleted: false,
  ...extra,
});

const view = {
  currentOwnerPublicKey: CURRENT,
  agents: [
    agent("ada", OLD),
    agent("mira", OLD.toUpperCase()),
    agent("ellis", CURRENT),
    agent("sage", null),
    agent("gone", OLD, { deleted: true }),
  ],
};

let restore = () => {};
afterEach(() => restore());

test("stale means a reported owner key other than the current one", () => {
  assert.deepEqual(
    staleAgents(view).map((a) => a.providerAgentId),
    ["ada", "mira"],
  );
  assert.deepEqual(
    currentAgents(view).map((a) => a.providerAgentId),
    ["ellis"],
  );
  // Case does not matter for the current key either.
  assert.equal(
    staleAgents({ ...view, currentOwnerPublicKey: CURRENT.toUpperCase() })
      .length,
    2,
  );
  // Null owner keys are never stale.
  assert.deepEqual(
    staleAgents({ currentOwnerPublicKey: CURRENT, agents: [agent("x", null)] }),
    [],
  );
});

test("outcomes read in plain words and only some rejections retry", () => {
  assert.equal(
    describeOutcome({ providerAgentId: "a", outcome: "rebound", code: null }),
    "Re-linked",
  );
  assert.equal(
    describeOutcome({
      providerAgentId: "a",
      outcome: "already_current",
      code: null,
    }),
    "Already linked",
  );
  const retryable = new Set(["profile_revision_conflict", "rebind_failed"]);
  for (const code of [
    "endpoint_not_found",
    "agent_key_mismatch",
    "owner_attestation_invalid",
    "previous_owner_not_revoked",
    "identity_unreadable",
    "rotation_in_progress",
    "profile_revision_conflict",
    "rebind_failed",
  ]) {
    const result = { providerAgentId: "a", outcome: "rejected", code };
    const text = describeOutcome(result);
    assert.notEqual(text, describeRejection("something_else"), code);
    assert.equal(text.split(".").length, 2, `${code}: one sentence`);
    assert.equal(isRetryable(result), retryable.has(code), code);
  }
  assert.equal(
    isRetryable({ providerAgentId: "a", outcome: "rebound", code: null }),
    false,
  );
});

test("whole-request errors become one sentence each", () => {
  for (const code of [
    "rebind_invalid",
    "owner_proof_invalid",
    "owner_proof_replayed",
    "owner_not_linked",
    "owner_ambiguous",
    "scope_unconfigured",
    "provisioning_keys_unconfigured",
    "provisioning_keys_invalid",
    "database_unavailable",
  ]) {
    const plain = describeRequestError(code);
    assert.equal(describeRequestError(`buzz_hosted_${code}`), plain);
    assert.notEqual(plain, describeRequestError("unknown"), code);
    assert.equal(plain.split(".").length, 2, `${code}: one sentence`);
  }
  const parsed = toRelinkRequestError(
    new Error(
      '{"status":409,"error":"owner_proof_replayed","correlation_id":"c1"}',
    ),
  );
  assert.ok(parsed instanceof RelinkRequestError);
  assert.equal(parsed.status, 409);
  assert.equal(parsed.correlationId, "c1");
  assert.match(parsed.message, /already used/);
  assert.equal(toRelinkRequestError("boom").code, "request_failed");
});

test("selection sends only chosen agents and retries only retryable ones", () => {
  const stale = staleAgents(view);
  const selected = new Set(["ada"]);
  assert.deepEqual(
    agentsToSend(stale, selected, {}).map((a) => a.providerAgentId),
    ["ada"],
  );
  const results = mergeResults({}, [
    { providerAgentId: "ada", outcome: "rejected", code: "rebind_failed" },
    { providerAgentId: "mira", outcome: "rebound", code: null },
  ]);
  assert.deepEqual(
    selectableAgents(stale, results).map((a) => a.providerAgentId),
    ["ada"],
  );
  // Mira was re-linked: even if still "selected" she is never sent again.
  assert.deepEqual(
    agentsToSend(stale, new Set(["ada", "mira"]), results).map(
      (a) => a.providerAgentId,
    ),
    ["ada"],
  );
  const final = mergeResults(results, [
    { providerAgentId: "ada", outcome: "rejected", code: "endpoint_not_found" },
  ]);
  assert.deepEqual(selectableAgents(stale, final), []);
});

test("rebind passes exactly the selected agents in one native call", async () => {
  const calls = [];
  restore = setRelinkTransportForTests({
    rebind: async (agents) => {
      calls.push(agents);
      return agents.map((a) => ({
        providerAgentId: a.providerAgentId,
        outcome: "rebound",
        code: null,
      }));
    },
  });
  const [ada] = staleAgents(view);
  const results = await hostedOwnerRelinkApi.rebind([ada]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    { providerAgentId: "ada", agentPublicKey: ada.agentPublicKey },
  ]);
  assert.equal(describeOutcome(results[0]), "Re-linked");
});

test("an empty or oversized selection never reaches the native signer", async () => {
  let called = false;
  restore = setRelinkTransportForTests({
    rebind: async () => {
      called = true;
      return [];
    },
  });
  await assert.rejects(hostedOwnerRelinkApi.rebind([]), RelinkRequestError);
  const many = Array.from({ length: MAX_REBIND_AGENTS + 1 }, (_, index) =>
    agent(`a${index}`, OLD),
  );
  await assert.rejects(hostedOwnerRelinkApi.rebind(many), RelinkRequestError);
  assert.equal(called, false);
});

test("a native failure surfaces as one request error, not a retry", async () => {
  let calls = 0;
  restore = setRelinkTransportForTests({
    rebind: async () => {
      calls += 1;
      throw new Error('{"status":503,"error":"database_unavailable"}');
    },
  });
  await assert.rejects(
    hostedOwnerRelinkApi.rebind([staleAgents(view)[0]]),
    (error) =>
      error instanceof RelinkRequestError &&
      error.code === "database_unavailable",
  );
  assert.equal(calls, 1);
});

test("availability failures hide the feature", async () => {
  restore = setRelinkTransportForTests({
    available: async () => {
      throw new Error("unknown command");
    },
  });
  assert.equal(await hostedOwnerRelinkApi.available(), false);
});

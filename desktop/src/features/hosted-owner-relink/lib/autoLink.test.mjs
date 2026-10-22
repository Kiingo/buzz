import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  AUTO_LINK_INTERVAL_MS,
  AUTO_LINK_RESUME_GAP_MS,
  autoLinkStorageKey,
  chunk,
  createAutoLinkScheduler,
  linkedNote,
  newAutoLinkMemory,
  readAutoLinkSetting,
  runAutoLinkPass,
  subscribeAutoLinkSetting,
  writeAutoLinkSetting,
} from "./autoLink.ts";
import { hostedOwnerRelinkApi, setRelinkTransportForTests } from "./client.ts";
import {
  describeAttestOutcome,
  isAttested,
  isRetryableAttest,
  pendingAgents,
  RelinkRequestError,
  staleAgents,
} from "./relink.ts";

const CURRENT = "a".repeat(64);
const OLD = "b".repeat(64);

const agent = (id, extra = {}) => ({
  providerAgentId: `buzz:${id}`,
  agentPublicKey: id
    .padEnd(64, "0")
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "1"),
  displayName: id,
  ownerPublicKey: CURRENT,
  deleted: false,
  status: "active",
  kiingoAgentId: null,
  ...extra,
});

const pending = (id, extra = {}) =>
  agent(id, { status: "pending_attestation", ownerPublicKey: null, ...extra });

const view = (agents, current = CURRENT) => ({
  currentOwnerPublicKey: current,
  agents,
});

let restore = () => {};
afterEach(() => restore());

/** A fake API that answers every agent with `answer(agent)`. */
function fakeApi(listed, { attest, rebind, list } = {}) {
  const calls = { list: 0, attest: [], rebind: [] };
  return {
    calls,
    api: {
      list: async () => {
        calls.list += 1;
        if (list) return list();
        return listed;
      },
      attestPending: async (agents) => {
        calls.attest.push(agents.map((a) => a.providerAgentId));
        return agents.map((a) => ({
          providerAgentId: a.providerAgentId,
          outcome: "activated",
          code: null,
          dmOpened: true,
          kiingoAgentId: null,
          ...(attest ? attest(a) : {}),
        }));
      },
      rebind: async (agents) => {
        calls.rebind.push(agents.map((a) => a.providerAgentId));
        return agents.map((a) => ({
          providerAgentId: a.providerAgentId,
          outcome: "rebound",
          code: null,
          ...(rebind ? rebind(a) : {}),
        }));
      },
    },
  };
}

test("pending agents are only those the list reports pending and live", () => {
  const listed = view([
    pending("scout"),
    pending("gone", { deleted: true }),
    agent("ada", { ownerPublicKey: OLD }),
    agent("odd", { status: "unknown", ownerPublicKey: OLD }),
    agent("legacy", { status: undefined, ownerPublicKey: OLD }),
  ]);
  assert.deepEqual(
    pendingAgents(listed).map((a) => a.displayName),
    ["scout"],
  );
  // A pending agent is never stale, an unknown status is neither, and an
  // agent from an older provider without status is live.
  assert.deepEqual(
    staleAgents(listed).map((a) => a.displayName),
    ["ada", "legacy"],
  );
});

test("a pass attests pending agents, re-links stale ones, and names them", async () => {
  const listed = view([
    pending("scout"),
    agent("ada", { ownerPublicKey: OLD }),
    agent("mira"),
    pending("Mail Helper"),
  ]);
  const { api, calls } = fakeApi(listed);
  const result = await runAutoLinkPass(api, CURRENT, newAutoLinkMemory());
  assert.deepEqual(calls.attest, [["buzz:scout", "buzz:Mail Helper"]]);
  assert.deepEqual(calls.rebind, [["buzz:ada"]]);
  // Names come in list order, live agents already current are not named.
  assert.deepEqual(result.linked, ["scout", "ada", "Mail Helper"]);
  assert.equal(result.sent, true);
  assert.deepEqual(result.errors, []);
  assert.equal(linkedNote(result.linked), "Linked: scout, ada, Mail Helper");
});

test("a pass sends at most 20 agents per request", async () => {
  const many = Array.from({ length: 45 }, (_, index) => pending(`p${index}`));
  const { api, calls } = fakeApi(view(many));
  const result = await runAutoLinkPass(api, CURRENT, newAutoLinkMemory());
  assert.deepEqual(
    calls.attest.map((batch) => batch.length),
    [20, 20, 5],
  );
  assert.equal(result.linked.length, 45);
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
});

test("a pass never signs for a key other than the one it runs for", async () => {
  const { api, calls } = fakeApi(view([pending("scout")], OLD));
  const result = await runAutoLinkPass(api, CURRENT, newAutoLinkMemory());
  assert.equal(calls.list, 1);
  assert.deepEqual(calls.attest, []);
  assert.equal(result.sent, false);
  assert.equal(linkedNote(result.linked), null);
});

test("nothing to do sends nothing and says nothing", async () => {
  const { api, calls } = fakeApi(view([agent("mira")]));
  const result = await runAutoLinkPass(api, CURRENT, newAutoLinkMemory());
  assert.deepEqual(calls.attest, []);
  assert.deepEqual(calls.rebind, []);
  assert.equal(result.sent, false);
  assert.deepEqual(result.linked, []);
});

test("permanent refusals are not signed again; retryable ones are", async () => {
  const listed = view([
    pending("scout"),
    pending("theirs"),
    agent("ada", { ownerPublicKey: OLD }),
    agent("sage", { ownerPublicKey: OLD }),
  ]);
  const { api, calls } = fakeApi(listed, {
    attest: (a) =>
      a.displayName === "theirs"
        ? { outcome: "rejected", code: "not_agent_owner", dmOpened: false }
        : { outcome: "rejected", code: "activate_failed", dmOpened: false },
    rebind: (a) =>
      a.displayName === "ada"
        ? { outcome: "rejected", code: "previous_owner_not_revoked" }
        : { outcome: "rejected", code: "rebind_failed" },
  });
  const memory = newAutoLinkMemory();
  const first = await runAutoLinkPass(api, CURRENT, memory);
  assert.deepEqual(first.linked, []);
  await runAutoLinkPass(api, CURRENT, memory);
  assert.deepEqual(calls.attest, [
    ["buzz:scout", "buzz:theirs"],
    ["buzz:scout"],
  ]);
  assert.deepEqual(calls.rebind, [["buzz:ada", "buzz:sage"], ["buzz:sage"]]);
  // A different key starts with a clean slate.
  const other = fakeApi(view([pending("theirs")], OLD));
  await runAutoLinkPass(other.api, OLD, memory);
  assert.deepEqual(other.calls.attest, [["buzz:theirs"]]);
});

test("an agent whose DM failed to open is linked, not retried", async () => {
  const listed = view([pending("scout")]);
  const { api, calls } = fakeApi(listed, {
    attest: () => ({ outcome: "rejected", code: "dm_open_failed" }),
  });
  const memory = newAutoLinkMemory();
  const result = await runAutoLinkPass(api, CURRENT, memory);
  assert.deepEqual(result.linked, ["scout"]);
  const dmFailed = {
    providerAgentId: "buzz:x",
    outcome: "rejected",
    code: "dm_open_failed",
    dmOpened: false,
    kiingoAgentId: null,
  };
  assert.equal(isAttested(dmFailed), true);
  assert.equal(isRetryableAttest(dmFailed), false);
  assert.match(describeAttestOutcome(dmFailed), /^Linked/);
  // Already active (another device linked it) is not named again.
  const again = fakeApi(listed, {
    attest: () => ({ outcome: "already_active" }),
  });
  assert.deepEqual(
    (await runAutoLinkPass(again.api, CURRENT, newAutoLinkMemory())).linked,
    [],
  );
  assert.equal(calls.attest.length, 1);
});

test("a whole-request failure stops the pass and reports its code", async () => {
  const listed = view([
    pending("scout"),
    agent("ada", { ownerPublicKey: OLD }),
  ]);
  const { api, calls } = fakeApi(listed);
  api.attestPending = async () => {
    throw new RelinkRequestError("owner_proof_invalid", 401, null);
  };
  const result = await runAutoLinkPass(api, CURRENT, newAutoLinkMemory());
  assert.deepEqual(result.errors, ["owner_proof_invalid"]);
  assert.deepEqual(calls.rebind, []);
  assert.deepEqual(result.linked, []);

  const failing = fakeApi(listed, {
    list: () => {
      throw new Error("offline");
    },
  });
  const listed2 = await runAutoLinkPass(
    failing.api,
    CURRENT,
    newAutoLinkMemory(),
  );
  assert.deepEqual(listed2.errors, ["request_failed"]);
  assert.equal(listed2.sent, false);
});

test("the pass uses the production client against the native transport", async () => {
  const sent = [];
  restore = setRelinkTransportForTests({
    list: async () => view([pending("scout")]),
    attestPending: async (agents) => {
      sent.push(agents);
      return agents.map((a) => ({
        providerAgentId: a.providerAgentId,
        outcome: "activated",
        code: null,
        dmOpened: true,
        kiingoAgentId: null,
      }));
    },
  });
  const result = await runAutoLinkPass(
    {
      list: () => hostedOwnerRelinkApi.list(),
      attestPending: (agents) => hostedOwnerRelinkApi.attestPending(agents),
      rebind: (agents) => hostedOwnerRelinkApi.rebind(agents),
    },
    CURRENT,
    newAutoLinkMemory(),
  );
  assert.deepEqual(result.linked, ["scout"]);
  // Only the id and key cross to the native side.
  assert.deepEqual(Object.keys(sent[0][0]).sort(), [
    "agentPublicKey",
    "providerAgentId",
  ]);
  await assert.rejects(
    hostedOwnerRelinkApi.attestPending([]),
    (error) => error.code === "attest_selection_invalid",
  );
});

test("the note is short and quiet", () => {
  assert.equal(linkedNote([]), null);
  assert.equal(linkedNote(["scout"]), "Linked: scout");
  assert.equal(
    linkedNote(["a", "b", "c", "d", "e", "f"]),
    "Linked: a, b, c and 3 more",
  );
  assert.equal(linkedNote(["  "]), "Linked: an agent");
});

test("the setting is off by default and per signed-in key", () => {
  const store = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  restore = () => {
    globalThis.localStorage = previous;
  };
  let notified = 0;
  const unsubscribe = subscribeAutoLinkSetting(() => {
    notified += 1;
  });
  assert.equal(readAutoLinkSetting(CURRENT), false);
  assert.equal(readAutoLinkSetting(null), false);
  writeAutoLinkSetting(CURRENT.toUpperCase(), true);
  assert.equal(readAutoLinkSetting(CURRENT), true);
  assert.equal(readAutoLinkSetting(OLD), false);
  writeAutoLinkSetting(CURRENT, false);
  assert.equal(readAutoLinkSetting(CURRENT), false);
  assert.equal(store.size, 0);
  assert.equal(notified, 2);
  unsubscribe();
  assert.equal(autoLinkStorageKey("not-a-key"), null);
  writeAutoLinkSetting("not-a-key", true);
  assert.equal(store.size, 0);
});

test("the scheduler runs on launch, on resume after a minute, and every 15 minutes in the foreground", async () => {
  let now = 0;
  let foreground = true;
  let tick = null;
  let runs = 0;
  let release = () => {};
  const scheduler = createAutoLinkScheduler({
    isForeground: () => foreground,
    now: () => now,
    setInterval: (callback, ms) => {
      assert.equal(ms, AUTO_LINK_INTERVAL_MS);
      tick = callback;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
    runPass: () => {
      runs += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  scheduler.start();
  assert.equal(runs, 1);
  // Never two at once.
  now += AUTO_LINK_RESUME_GAP_MS;
  assert.equal(scheduler.resume(), false);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  // A resume within a minute of the last pass waits.
  now = AUTO_LINK_RESUME_GAP_MS - 1;
  assert.equal(scheduler.resume(), false);
  now = AUTO_LINK_RESUME_GAP_MS;
  assert.equal(scheduler.resume(), true);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  // In the background the interval does nothing.
  foreground = false;
  now += AUTO_LINK_INTERVAL_MS;
  tick();
  assert.equal(runs, 2);
  foreground = true;
  tick();
  assert.equal(runs, 3);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.stop();
  assert.equal(tick, null);
  assert.equal(scheduler.trigger("resume"), false);
});

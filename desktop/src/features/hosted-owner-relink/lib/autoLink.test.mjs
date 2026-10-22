import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  AUTO_LINK_BACKOFF_BASE_MS,
  AUTO_LINK_BACKOFF_MAX_MS,
  AUTO_LINK_FAILURES_BEFORE_BACKOFF,
  AUTO_LINK_INTERVAL_MS,
  AUTO_LINK_RESUME_GAP_MS,
  autoLinkStorageKey,
  chunk,
  createAutoLinkBackoff,
  createAutoLinkScheduler,
  linkedNote,
  notLinkedNote,
  newAutoLinkMemory,
  readAutoLinkSetting,
  runAutoLinkPass,
  subscribeAutoLinkSetting,
  writeAutoLinkSetting,
} from "./autoLink.ts";
import { hostedOwnerRelinkApi, setRelinkTransportForTests } from "./client.ts";
import {
  agentFingerprint,
  agentLabel,
  agentName,
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

const view = (agents, current = CURRENT, listId = "list-1") => ({
  currentOwnerPublicKey: current,
  listId,
  agents,
});

/** How notes name the agent `id` (its name and key fingerprint). */
const labelOf = (id) => agentLabel(agent(id));

let restore = () => {};
afterEach(() => restore());

/** A fake API that answers every agent with `answer(agent)`. */
function fakeApi(listed, { attest, rebind, list } = {}) {
  const calls = { list: 0, attest: [], rebind: [], lists: [] };
  return {
    calls,
    api: {
      list: async () => {
        calls.list += 1;
        if (list) return list();
        return listed;
      },
      attestPending: async (agents, listedIn) => {
        calls.attest.push(agents.map((a) => a.providerAgentId));
        calls.lists.push(listedIn);
        return agents.map((a) => ({
          providerAgentId: a.providerAgentId,
          outcome: "activated",
          code: null,
          dmOpened: true,
          kiingoAgentId: null,
          ...(attest ? attest(a) : {}),
        }));
      },
      rebind: async (agents, listedIn) => {
        calls.rebind.push(agents.map((a) => a.providerAgentId));
        calls.lists.push(listedIn);
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
  // Names come in list order, live agents already current are not named,
  // and each carries its key fingerprint.
  const labels = ["scout", "ada", "Mail Helper"].map(labelOf);
  assert.deepEqual(result.linked, labels);
  assert.equal(result.sent, true);
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.errors, []);
  assert.equal(linkedNote(result.linked), `Linked: ${labels.join(", ")}`);
  assert.equal(
    labelOf("scout"),
    `scout (${agentFingerprint(agent("scout").agentPublicKey)})`,
  );
  // Every signed request is held to the list the pass read.
  assert.deepEqual(calls.lists, [listed, listed]);
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
  // Permanent refusals are said plainly, once; retryable ones are not.
  assert.deepEqual(first.notLinked, [
    { name: labelOf("theirs"), reason: "Only this agent's owner can link it." },
    {
      name: labelOf("ada"),
      reason: "Your old key is still active, so this agent stays linked to it.",
    },
  ]);
  const second = await runAutoLinkPass(api, CURRENT, memory);
  assert.deepEqual(second.notLinked, []);
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
  assert.deepEqual(result.linked, [labelOf("scout")]);
  const dmFailed = {
    providerAgentId: "buzz:x",
    outcome: "rejected",
    code: "dm_open_failed",
    dmOpened: false,
    kiingoAgentId: null,
  };
  assert.equal(isAttested(dmFailed), true);
  // The provider's own shape: activated, with dm_open_failed as a note.
  const activatedNote = {
    ...dmFailed,
    outcome: "activated",
  };
  assert.equal(isAttested(activatedNote), true);
  assert.equal(isRetryableAttest(activatedNote), false);
  assert.equal(
    describeAttestOutcome(activatedNote),
    "Linked; its chat with you opens shortly",
  );
  assert.equal(
    describeAttestOutcome({ ...activatedNote, code: null }),
    "Linked",
  );
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
  const listArgs = [];
  restore = setRelinkTransportForTests({
    list: async (args) => {
      listArgs.push(args);
      return view([pending("scout")], CURRENT, "list-7");
    },
    attestPending: async (args) => {
      sent.push(args);
      return args.agents.map((a) => ({
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
      list: () => hostedOwnerRelinkApi.list({ background: true }),
      attestPending: (agents, listedIn) =>
        hostedOwnerRelinkApi.attestPending(agents, listedIn),
      rebind: (agents, listedIn) =>
        hostedOwnerRelinkApi.rebind(agents, listedIn),
    },
    CURRENT,
    newAutoLinkMemory(),
  );
  assert.deepEqual(result.linked, [labelOf("scout")]);
  // A pass's lists are kept apart from the ones an open card signs against;
  // the card's own list is not marked.
  await hostedOwnerRelinkApi.list();
  assert.deepEqual(listArgs, [{ background: true }, {}]);
  // Only the id and key cross to the native side, with the list they came
  // from and the owner key it was listed for.
  assert.deepEqual(Object.keys(sent[0].agents[0]).sort(), [
    "agentPublicKey",
    "providerAgentId",
  ]);
  assert.equal(sent[0].expectedOwner, CURRENT);
  assert.equal(sent[0].listId, "list-7");
  await assert.rejects(
    hostedOwnerRelinkApi.attestPending([], view([])),
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
  assert.equal(linkedNote(["  "]), "Linked: An agent");
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

test("the refused note names each agent and its reason", () => {
  assert.equal(notLinkedNote([]), null);
  assert.deepEqual(notLinkedNote([{ name: "ada", reason: "Nope." }]), {
    title: "Couldn't link an agent",
    description: "ada: Nope.",
  });
  const many = ["a", "b", "c", "d", "e"].map((name) => ({
    name,
    reason: "Nope.",
  }));
  assert.deepEqual(notLinkedNote(many), {
    title: "Couldn't link 5 agents",
    description: "a: Nope.\nb: Nope.\nc: Nope.\nAnd 2 more.",
  });
});

test("turning the setting off stops a pass before its next signed request", async () => {
  // Off before the first request: the list is read, nothing is signed.
  const off = fakeApi(
    view([pending("scout"), agent("ada", { ownerPublicKey: OLD })]),
  );
  const stopped = await runAutoLinkPass(off.api, CURRENT, newAutoLinkMemory(), {
    shouldContinue: () => false,
  });
  assert.equal(off.calls.list, 1);
  assert.deepEqual(off.calls.attest, []);
  assert.deepEqual(off.calls.rebind, []);
  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.sent, false);

  // Off between batches: the batch in flight finishes, no later one starts.
  const many = Array.from({ length: 45 }, (_, index) => pending(`p${index}`));
  const midway = fakeApi(
    view([...many, agent("ada", { ownerPublicKey: OLD })]),
  );
  let enabled = true;
  const original = midway.api.attestPending;
  midway.api.attestPending = async (agents, listedIn) => {
    const outcomes = await original(agents, listedIn);
    enabled = false;
    return outcomes;
  };
  const partial = await runAutoLinkPass(
    midway.api,
    CURRENT,
    newAutoLinkMemory(),
    { shouldContinue: () => enabled },
  );
  assert.deepEqual(
    midway.calls.attest.map((batch) => batch.length),
    [20],
  );
  assert.deepEqual(midway.calls.rebind, []);
  assert.equal(partial.cancelled, true);
  // What the finished batch linked is still reported.
  assert.equal(partial.linked.length, 20);

  // Switching keys mid-pass stops it the same way.
  let signedIn = CURRENT;
  const switched = fakeApi(
    view([pending("scout"), agent("ada", { ownerPublicKey: OLD })]),
  );
  const originalSwitch = switched.api.attestPending;
  switched.api.attestPending = async (agents, listedIn) => {
    const outcomes = await originalSwitch(agents, listedIn);
    signedIn = OLD;
    return outcomes;
  };
  const afterSwitch = await runAutoLinkPass(
    switched.api,
    CURRENT,
    newAutoLinkMemory(),
    { shouldContinue: () => signedIn === CURRENT },
  );
  assert.deepEqual(switched.calls.attest, [["buzz:scout"]]);
  assert.deepEqual(switched.calls.rebind, []);
  assert.equal(afterSwitch.cancelled, true);
});

test("a native refusal for a changed key or an unlisted agent is one plain error", async () => {
  for (const [code, pattern] of [
    ["owner_key_changed", /different key/],
    ["rebind_selection_not_listed", /latest list/],
    ["attest_selection_not_listed", /latest list/],
  ]) {
    restore = setRelinkTransportForTests({
      list: async () =>
        view([pending("scout"), agent("ada", { ownerPublicKey: OLD })]),
      attestPending: async () => {
        throw new Error(JSON.stringify({ status: null, error: code }));
      },
      rebind: async () => {
        throw new Error(JSON.stringify({ status: null, error: code }));
      },
    });
    const result = await runAutoLinkPass(
      {
        list: () => hostedOwnerRelinkApi.list(),
        attestPending: (agents, listedIn) =>
          hostedOwnerRelinkApi.attestPending(agents, listedIn),
        rebind: (agents, listedIn) =>
          hostedOwnerRelinkApi.rebind(agents, listedIn),
      },
      CURRENT,
      newAutoLinkMemory(),
    );
    assert.deepEqual(result.errors, [code]);
    const backoff = createAutoLinkBackoff();
    let note = null;
    for (let index = 0; index < AUTO_LINK_FAILURES_BEFORE_BACKOFF; index += 1) {
      note = backoff.record(result, 0) ?? note;
    }
    assert.match(note.description, pattern);
    restore();
  }
});

test("whole-request failures back off and say so once", () => {
  const backoff = createAutoLinkBackoff();
  const failed = { errors: ["hosted_agents_unreachable"], cancelled: false };
  const ok = { errors: [], cancelled: false };
  let now = 1_000_000;
  // The first failures stay quiet and do not delay the next pass.
  for (let index = 1; index < AUTO_LINK_FAILURES_BEFORE_BACKOFF; index += 1) {
    assert.equal(backoff.record(failed, now), null);
    assert.equal(backoff.allows(now), true);
  }
  // Then one plain note, and the next pass waits.
  const note = backoff.record(failed, now);
  assert.equal(note.title, "Couldn't link your agents automatically");
  assert.match(note.description, /Couldn't reach the hosted service/);
  assert.equal(backoff.allows(now + AUTO_LINK_BACKOFF_BASE_MS - 1), false);
  assert.equal(backoff.allows(now + AUTO_LINK_BACKOFF_BASE_MS), true);
  // Each further failure doubles the wait, silently, up to the cap.
  now += AUTO_LINK_BACKOFF_BASE_MS;
  assert.equal(backoff.record(failed, now), null);
  assert.equal(backoff.allows(now + 2 * AUTO_LINK_BACKOFF_BASE_MS - 1), false);
  assert.equal(backoff.allows(now + 2 * AUTO_LINK_BACKOFF_BASE_MS), true);
  for (let index = 0; index < 20; index += 1) backoff.record(failed, now);
  assert.equal(backoff.allows(now + AUTO_LINK_BACKOFF_MAX_MS - 1), false);
  assert.equal(backoff.allows(now + AUTO_LINK_BACKOFF_MAX_MS), true);
  // A cancelled pass changes nothing.
  const before = backoff.failures;
  assert.equal(backoff.record({ errors: [], cancelled: true }, now), null);
  assert.equal(backoff.failures, before);
  // A pass that gets through resets it; a new run of failures says so again.
  assert.equal(backoff.record(ok, now), null);
  assert.equal(backoff.allows(now), true);
  assert.equal(backoff.failures, 0);
  for (let index = 1; index < AUTO_LINK_FAILURES_BEFORE_BACKOFF; index += 1) {
    backoff.record(failed, now);
  }
  assert.notEqual(backoff.record(failed, now), null);
});

test("an agent with an empty name is still linked, under a fallback name", async () => {
  const nameless = pending("ghost", { displayName: "" });
  const { api, calls } = fakeApi(view([nameless]));
  const result = await runAutoLinkPass(api, CURRENT, newAutoLinkMemory());
  assert.deepEqual(calls.attest, [["buzz:ghost"]]);
  assert.equal(agentName(nameless), "Unnamed agent");
  assert.deepEqual(result.linked, [
    `Unnamed agent (${agentFingerprint(nameless.agentPublicKey)})`,
  ]);
});

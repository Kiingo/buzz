import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadInboxThreadContext } from "./inboxThreadContextLoader.ts";

// Shapes copied from the #agent-lab thread that showed the red
// "Some message context could not be loaded." banner (2026-10-05 ~22:12 PT):
// Ross's root message and Atlas's direct NIP-10 reply.
const CHANNEL_ID = "428097f7-9b83-4aa6-ac36-9daa05562af4";
const ROOT_ID =
  "8a6cd76d89d9f9acc0c81c87af338ef04c96d48cb76addd54c4dceba391daf66";
const REPLY_ID =
  "a04c01cd454967ff288f75a494cc360af03611e6d376ad07e7fdb3c82b8a7a5c";
const NESTED_ID = "c".repeat(64);
const ATLAS =
  "ca6c404c40ec901038e5c7521c7386ccc12f60166bc10a1335a3458f41f83e62";
const ROSS = "3fe270b31e696b1daef91ebbc7992600c1232ffd5b704bc5258a64e0c0b59be1";

const root = {
  content:
    "@Atlas [conc2] Ross here: reply with only the word pineapple, then tell me what color I said my canary bird was.",
  created_at: 1791263579,
  id: ROOT_ID,
  kind: 9,
  pubkey: ROSS,
  sig: "",
  tags: [
    ["h", CHANNEL_ID],
    ["p", ATLAS],
    ["mention", ATLAS, "agent-address"],
  ],
};
const reply = {
  content: "pineapple",
  created_at: 1791263593,
  id: REPLY_ID,
  kind: 9,
  pubkey: ATLAS,
  sig: "",
  tags: [
    ["h", CHANNEL_ID],
    ["e", ROOT_ID, "", "reply"],
  ],
};
const nested = {
  content: "nested",
  created_at: 1791263600,
  id: NESTED_ID,
  kind: 9,
  pubkey: ROSS,
  sig: "",
  tags: [
    ["h", CHANNEL_ID],
    ["e", ROOT_ID, "", "root"],
    ["e", REPLY_ID, "", "reply"],
  ],
};

const noSleep = async () => {};

function stubFetchers({
  remote = [],
  failures = {},
  replies,
  repliesFailures = 0,
}) {
  const calls = { byId: [], replies: 0 };
  const remaining = { ...failures };
  let remainingReplyFailures = repliesFailures;
  return {
    calls,
    fetchEventById: async (eventId) => {
      calls.byId.push(eventId);
      if ((remaining[eventId] ?? 0) > 0) {
        remaining[eventId] -= 1;
        throw new Error("relay unreachable: request timed out");
      }
      const event = remote.find((candidate) => candidate.id === eventId);
      if (!event) throw new Error("event not found");
      return event;
    },
    fetchReplies: async () => {
      calls.replies += 1;
      if (remainingReplyFailures > 0) {
        remainingReplyFailures -= 1;
        throw new Error("Timed out while loading channel history.");
      }
      return replies ?? [];
    },
  };
}

function load(target, fetchers, local = []) {
  return loadInboxThreadContext({
    channelId: CHANNEL_ID,
    fetchEventById: fetchers.fetchEventById,
    fetchReplies: fetchers.fetchReplies,
    lookupLocalEvent: (id) => local.find((event) => event.id === id),
    parentId:
      target.tags
        .filter((tag) => tag[0] === "e" && tag[3] === "reply")
        .at(-1)?.[1] ?? null,
    sleep: noSleep,
    targetEvent: target,
    threadRootId:
      target.tags.find((tag) => tag[0] === "e" && tag[3] === "root")?.[1] ??
      target.tags.find((tag) => tag[0] === "e" && tag[3] === "reply")?.[1] ??
      target.id,
  });
}

describe("loadInboxThreadContext", () => {
  it("loads the conc2 root and reply without flagging anything", async () => {
    const fetchers = stubFetchers({ remote: [root], replies: [reply] });
    const result = await load(reply, fetchers);

    assert.deepEqual(
      result.events.map((event) => event.id).sort(),
      [ROOT_ID, REPLY_ID].sort(),
    );
    assert.deepEqual(result.unavailableEventIds, []);
    assert.equal(result.repliesFailed, false);
  });

  it("uses a root already in the channel window instead of fetching it", async () => {
    // The regression: the root rendered from the cached channel window, yet a
    // failed by-id refetch of that same root raised the page-level banner.
    const fetchers = stubFetchers({ remote: [], replies: [reply] });
    const result = await load(reply, fetchers, [root]);

    assert.deepEqual(fetchers.calls.byId, []);
    assert.deepEqual(result.unavailableEventIds, []);
    assert.ok(result.events.some((event) => event.id === ROOT_ID));
  });

  it("retries a transient by-id failure once before giving up", async () => {
    const fetchers = stubFetchers({
      failures: { [ROOT_ID]: 1 },
      remote: [root],
      replies: [reply],
    });
    const result = await load(reply, fetchers);

    assert.deepEqual(fetchers.calls.byId, [ROOT_ID, ROOT_ID]);
    assert.deepEqual(result.unavailableEventIds, []);
    assert.ok(result.events.some((event) => event.id === ROOT_ID));
  });

  it("reports a deleted root as unavailable instead of failing the load", async () => {
    const fetchers = stubFetchers({ remote: [], replies: [reply] });
    const result = await load(reply, fetchers);

    assert.deepEqual(result.unavailableEventIds, [ROOT_ID]);
    assert.equal(result.repliesFailed, false);
    assert.deepEqual(
      result.events.map((event) => event.id),
      [REPLY_ID],
    );
  });

  it("walks a nested reply's ancestors and stops at an unavailable parent", async () => {
    const fetchers = stubFetchers({ remote: [root], replies: [] });
    const result = await load(nested, fetchers);

    // Root resolves; the intermediate parent is gone. Only the parent is
    // reported, once, even though the walk asked for it after the root.
    assert.deepEqual(result.unavailableEventIds, [REPLY_ID]);
    assert.ok(result.events.some((event) => event.id === ROOT_ID));
  });

  it("does not treat a mismatched by-id response as the requested event", async () => {
    const fetchers = {
      fetchEventById: async () => reply,
      fetchReplies: async () => [],
    };
    const result = await load(nested, fetchers);
    assert.ok(result.unavailableEventIds.includes(ROOT_ID));
  });

  it("flags replies only after the replies fetch fails twice", async () => {
    const once = stubFetchers({
      remote: [root],
      replies: [reply],
      repliesFailures: 1,
    });
    const recovered = await load(reply, once);
    assert.equal(recovered.repliesFailed, false);
    assert.equal(once.calls.replies, 2);

    const twice = stubFetchers({ remote: [root], repliesFailures: 2 });
    const failed = await load(reply, twice);
    assert.equal(failed.repliesFailed, true);
    assert.deepEqual(failed.unavailableEventIds, []);
    assert.ok(failed.events.some((event) => event.id === ROOT_ID));
  });

  it("skips the replies fetch when the item has no channel", async () => {
    const fetchers = stubFetchers({ remote: [root] });
    const result = await loadInboxThreadContext({
      channelId: null,
      fetchEventById: fetchers.fetchEventById,
      fetchReplies: fetchers.fetchReplies,
      lookupLocalEvent: () => undefined,
      parentId: ROOT_ID,
      sleep: noSleep,
      targetEvent: reply,
      threadRootId: ROOT_ID,
    });
    assert.equal(fetchers.calls.replies, 0);
    assert.equal(result.repliesFailed, false);
  });
});

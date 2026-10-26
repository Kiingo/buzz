import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";

import { computeChannelUnreadMarker } from "@/features/messages/lib/unreadMarker";
import { isAgentDmQuietEvent, isAgentDmQuietMessage } from "./quiet.ts";

const VIEWER = "b".repeat(64);
const AGENT = "a".repeat(64);
const DM_ID = "dm-1";
const DM = {
  id: DM_ID,
  name: "Agent",
  channelType: "dm",
  participantPubkeys: [AGENT, VIEWER],
  participants: ["Agent", "Ross"],
  memberPubkeys: [AGENT, VIEWER],
};

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
    localStorage: dom.window.localStorage,
  });
});
after(() => dom.window.close());

let sequence = 0;
function event(kind, tags, overrides = {}) {
  sequence += 1;
  return {
    id: sequence.toString(16).padStart(64, "0"),
    kind,
    pubkey: AGENT,
    content: "text",
    created_at: Math.floor(Date.now() / 1000) + 5,
    tags: [["h", DM_ID], ...tags],
    sig: "",
    ...overrides,
  };
}

const MIRROR = [
  ["buzz-mirror", "email", "msg-1", "1760000000"],
  ["buzz-mirror-author", "requester", VIEWER, ""],
];
const QUIET_TAGS = {
  mirror: MIRROR,
  divider: [["buzz-session", "new", ""]],
  listing: [["buzz-sessions", ""]],
  state: [["buzz-question-state", "ask-1", "closed"]],
};

test("quiet predicate covers the four quiet markers on kind 40002 in a DM", () => {
  for (const [name, tags] of Object.entries(QUIET_TAGS)) {
    assert.equal(isAgentDmQuietEvent(event(40002, tags), DM), true, name);
    assert.equal(
      isAgentDmQuietEvent(event(9, tags), DM),
      false,
      `${name} kind 9`,
    );
    assert.equal(
      isAgentDmQuietEvent(event(40002, tags), { ...DM, channelType: "stream" }),
      false,
      `${name} outside a DM`,
    );
    assert.equal(
      isAgentDmQuietEvent(event(40002, tags, { pubkey: "c".repeat(64) }), DM),
      false,
      `${name} from a non-member`,
    );
  }
  // Questions and actions are ordinary agent replies; they notify.
  assert.equal(
    isAgentDmQuietEvent(event(9, [["buzz-question", "ask-1"]]), DM),
    false,
  );
  assert.equal(isAgentDmQuietEvent(event(40002, []), DM), false);
});

async function mountLiveUpdates(callbacks) {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const React = await import("react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useLiveChannelUpdates } = await import(
    "@/features/channels/useLiveChannelUpdates.ts"
  );
  const { channelsQueryKey } = await import("@/features/channels/hooks");
  const originalLive = relayClient.subscribeLive;
  const subscriptions = [];
  relayClient.subscribeLive = async (filter, onEvent) => {
    subscriptions.push({ filter, onEvent });
    return async () => {};
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  queryClient.setQueryData(channelsQueryKey, [{ ...DM, lastMessageAt: null }]);
  const wrapper = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  const hook = renderHook(
    () =>
      useLiveChannelUpdates([DM], null, {
        currentPubkey: VIEWER,
        ...callbacks,
      }),
    { wrapper },
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    queryClient,
    channelsQueryKey,
    async deliver(relayEvent) {
      await act(async () => {
        subscriptions[0].onEvent(relayEvent);
      });
    },
    restore() {
      hook.unmount();
      cleanup();
      queryClient.clear();
      relayClient.subscribeLive = originalLive;
    },
  };
}

test("the live channel stream keeps quiet markers out of unread, mention and DM alerts", async () => {
  const fired = [];
  const h = await mountLiveUpdates({
    onLiveMention: () => fired.push("mention"),
    onChannelMessage: (_id, relayEvent) =>
      fired.push(`unread:${relayEvent.id}`),
    onDmMessage: (relayEvent) => fired.push(`dm:${relayEvent.id}`),
    onThreadReplyNotification: (_id, relayEvent) =>
      fired.push(`activity:${relayEvent.id}`),
  });
  try {
    for (const tags of Object.values(QUIET_TAGS)) {
      // A p tag must not turn a quiet marker into a mention either.
      await h.deliver(event(40002, [...tags, ["p", VIEWER]]));
    }
    assert.deepEqual(fired, []);
    const channel = h.queryClient.getQueryData(h.channelsQueryKey)?.[0];
    assert.ok(channel?.lastMessageAt, "quiet events still advance recency");

    const reply = event(9, [["p", VIEWER]]);
    await h.deliver(reply);
    assert.ok(fired.includes(`unread:${reply.id}`));
    assert.ok(fired.includes(`dm:${reply.id}`));
  } finally {
    h.restore();
  }
});

test("the in-channel unread marker skips honoured quiet rows", () => {
  const row = (id, extra = {}) => ({
    id,
    createdAt: 100,
    pubkey: AGENT,
    author: "Agent",
    time: "",
    body: "",
    depth: 0,
    ...extra,
  });
  const messages = [
    row("mirror", { kind: 40002, tags: MIRROR, agentDmMarkers: true }),
    row("reply", { kind: 9, tags: [] }),
  ];
  assert.equal(isAgentDmQuietMessage(messages[0]), true);
  assert.deepEqual(computeChannelUnreadMarker(messages, 50), {
    firstUnreadMessageId: "reply",
    unreadCount: 1,
  });
  // Without the formatter's honour flag the row is an ordinary message.
  assert.equal(
    computeChannelUnreadMarker(
      [row("mirror", { kind: 40002, tags: MIRROR })],
      50,
    ).firstUnreadMessageId,
    "mirror",
  );
});

test("relayed requester mirrors from every Kiingo surface never notify", async () => {
  const fired = [];
  const h = await mountLiveUpdates({
    onLiveMention: () => fired.push("mention"),
    onChannelMessage: (_id, relayEvent) =>
      fired.push(`unread:${relayEvent.id}`),
    onDmMessage: (relayEvent) => fired.push(`dm:${relayEvent.id}`),
    onThreadReplyNotification: (_id, relayEvent) =>
      fired.push(`activity:${relayEvent.id}`),
  });
  try {
    for (const surface of ["tasks", "companion", "ask", "email", "teams"]) {
      const relayed = event(40002, [
        ["buzz-mirror", surface, `src-${surface}`, "1760000000"],
        ["buzz-mirror-author", "requester", VIEWER, ""],
        // The addressed mirror's single p for the requester.
        ["p", VIEWER],
      ]);
      assert.equal(isAgentDmQuietEvent(relayed, DM), true, surface);
      await h.deliver(relayed);
    }
    // No toast, so no notification text can ever present the line as the
    // viewer's own message.
    assert.deepEqual(fired, []);
  } finally {
    h.restore();
  }
});

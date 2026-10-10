import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  invalidateChannelMembershipQueries,
  isMembershipSystemEvent,
} from "./membershipSystemEvents.ts";
import { revalidateCachedChannelRoster } from "./rosterFreshness.ts";

const CHANNEL_ID = "428097f7-9b83-4aa6-ac36-9daa05562af4";

// The relay-signed system row published when 2f6da02a… ran
// `buzz channels leave` on #agent-lab (2026-10-08 04:17:38Z).
const memberLeft = {
  content:
    '{"actor":"2f6da02a2ce36eefb98743cf86eddc2d4cdf9610ac16f943edda969d4e48cdb8","type":"member_left"}',
  kind: 40099,
  tags: [["h", CHANNEL_ID]],
};

function recordingClient(state) {
  const invalidated = [];
  return {
    invalidated,
    getQueryState: () => state,
    invalidateQueries: async ({ queryKey }) => {
      invalidated.push(queryKey);
    },
  };
}

describe("isMembershipSystemEvent", () => {
  it("recognizes every roster-changing system message", () => {
    for (const type of [
      "member_added",
      "member_joined",
      "member_left",
      "member_removed",
    ]) {
      assert.equal(
        isMembershipSystemEvent({
          content: JSON.stringify({ type }),
          kind: 40099,
        }),
        true,
        type,
      );
    }
    assert.equal(isMembershipSystemEvent(memberLeft), true);
  });

  it("ignores other system rows, other kinds, and malformed payloads", () => {
    assert.equal(
      isMembershipSystemEvent({
        content: '{"type":"channel_created"}',
        kind: 40099,
      }),
      false,
    );
    assert.equal(
      isMembershipSystemEvent({ content: memberLeft.content, kind: 9 }),
      false,
    );
    assert.equal(
      isMembershipSystemEvent({ content: "joined", kind: 40099 }),
      false,
    );
    assert.equal(
      isMembershipSystemEvent({ content: "null", kind: 40099 }),
      false,
    );
  });
});

describe("invalidateChannelMembershipQueries", () => {
  it("invalidates the roster and channel detail for the event's channel", () => {
    const client = recordingClient(undefined);
    invalidateChannelMembershipQueries(client, CHANNEL_ID);
    assert.deepEqual(client.invalidated, [
      ["channels", CHANNEL_ID, "members"],
      ["channels", CHANNEL_ID, "detail"],
    ]);
  });
});

describe("revalidateCachedChannelRoster", () => {
  it("refetches a cached roster when the members sidebar reopens", () => {
    const client = recordingClient({
      dataUpdatedAt: 1_000,
      fetchStatus: "idle",
    });
    assert.equal(revalidateCachedChannelRoster(client, CHANNEL_ID), true);
    assert.deepEqual(client.invalidated, [["channels", CHANNEL_ID, "members"]]);
  });

  it("leaves never-loaded and in-flight rosters to their own fetch", () => {
    const never = recordingClient(undefined);
    assert.equal(revalidateCachedChannelRoster(never, CHANNEL_ID), false);

    const empty = recordingClient({ dataUpdatedAt: 0, fetchStatus: "idle" });
    assert.equal(revalidateCachedChannelRoster(empty, CHANNEL_ID), false);

    const loading = recordingClient({
      dataUpdatedAt: 1_000,
      fetchStatus: "fetching",
    });
    assert.equal(revalidateCachedChannelRoster(loading, CHANNEL_ID), false);

    assert.deepEqual(
      [...never.invalidated, ...empty.invalidated, ...loading.invalidated],
      [],
    );
  });
});

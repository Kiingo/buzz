/**
 * Membership-change detection for relay-signed channel system messages
 * (kind:40099) and the cache invalidation every live path applies when one
 * arrives. Kept dependency-free (no React, no relay client) so node unit tests
 * can exercise it directly.
 */

import type { QueryClient } from "@tanstack/react-query";

import { noteChannelMembershipChange } from "@/shared/api/channelMembershipWrites";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_SYSTEM_MESSAGE } from "@/shared/constants/kinds";

/** System-message `type` values that change a channel's member roster. */
export const MEMBERSHIP_SYSTEM_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "admin_kick",
  "member_added",
  "member_joined",
  "member_left",
  "member_removed",
]);

/** True when `event` is a kind:40099 system message announcing a roster change. */
export function isMembershipSystemEvent(
  event: Pick<RelayEvent, "content" | "kind">,
): boolean {
  if (event.kind !== KIND_SYSTEM_MESSAGE) {
    return false;
  }
  try {
    const payload = JSON.parse(event.content) as { type?: unknown } | null;
    return (
      typeof payload?.type === "string" &&
      MEMBERSHIP_SYSTEM_MESSAGE_TYPES.has(payload.type)
    );
  } catch {
    return false;
  }
}

/**
 * Refresh every per-channel cache that renders the roster or its count. The
 * member list (members sidebar, header avatars/count, mention picker) goes
 * through `noteChannelMembershipChange`, which routes its re-reads to the relay
 * writer and lets the app-wide roster listener cancel and refetch it; the
 * channel detail is invalidated here. The channel list (`memberCount`) is
 * refreshed by the caller, which owns its own debounce policy.
 */
export function invalidateChannelMembershipQueries(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  channelId: string,
): void {
  noteChannelMembershipChange(channelId);
  void queryClient.invalidateQueries({
    queryKey: ["channels", channelId, "detail"],
  });
}

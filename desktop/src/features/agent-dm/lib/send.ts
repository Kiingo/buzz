import type { QueryClient } from "@tanstack/react-query";

import { resolveMessageRecipientPubkeys } from "@/extensions/messages/dmRecipientHydration";
import { channelsQueryKey } from "@/features/channels/hooks";
import { mergeTimelineCacheMessages } from "@/features/messages/lib/messageMerge";
import { channelMessagesKey } from "@/features/messages/lib/messageQueryKeys";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import type { Channel, RelayEvent } from "@/shared/api/types";

import { KIND_AGENT_DM_STREAM_MESSAGE } from "./markers";

/**
 * Send a user-signed top-level kind 9 message into a DM with agent DM marker
 * tags (`buzz-answer*`, `buzz-action-ref`). The regular composer send path
 * only carries media/emoji/mention tags, so this signs and publishes the
 * event directly while addressing every other DM member exactly like the
 * composer does.
 */
export async function sendAgentDmTaggedMessage(input: {
  queryClient: QueryClient;
  channelId: string;
  senderPubkey: string | null | undefined;
  content: string;
  markerTags: string[][];
}): Promise<RelayEvent> {
  const { queryClient, channelId, senderPubkey, content, markerTags } = input;
  const channel = queryClient
    .getQueryData<Channel[]>(channelsQueryKey)
    ?.find((candidate) => candidate.id === channelId);
  if (channel?.channelType !== "dm") {
    throw new Error("This conversation is no longer available.");
  }
  if (!senderPubkey) {
    throw new Error("Your identity is still loading. Try again.");
  }
  const recipients = await resolveMessageRecipientPubkeys({
    channel,
    senderPubkey,
    queryClient,
  });
  const event = await signRelayEvent({
    kind: KIND_AGENT_DM_STREAM_MESSAGE,
    content,
    tags: [
      ["h", channel.id],
      ...recipients.map((pubkey) => ["p", pubkey]),
      ...markerTags,
    ],
  });
  await relayClient.publishEvent(
    event,
    "Timed out sending your reply.",
    "Failed to send your reply.",
  );
  queryClient.setQueryData<RelayEvent[]>(
    channelMessagesKey(channel.id),
    (current) =>
      current ? mergeTimelineCacheMessages(current, event) : current,
  );
  return event;
}

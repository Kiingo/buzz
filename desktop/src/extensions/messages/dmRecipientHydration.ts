import type { QueryClient } from "@tanstack/react-query";

import { messageMentionPubkeys } from "@/features/messages/lib/messageMentionPubkeys";
import { getChannelMembers } from "@/shared/api/tauri";
import type { Channel, ChannelMember } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Whether a DM's locally available membership is too incomplete to address a
 * message safely. Channel snapshots deliberately paint before relay
 * revalidation, so a freshly reopened DM can temporarily have no participant
 * arrays even though `memberCount` says another participant exists.
 */
export function dmRecipientPubkeysNeedHydration(
  channel: Channel,
  senderPubkey: string,
  supplementalMemberPubkeys: readonly string[] = [],
): boolean {
  if (channel.channelType !== "dm") return false;

  const sender = normalizePubkey(senderPubkey);
  const knownRecipients = new Set(
    [
      ...channel.memberPubkeys,
      ...channel.participantPubkeys,
      ...supplementalMemberPubkeys,
    ]
      .map(normalizePubkey)
      .filter((pubkey) => pubkey.length > 0 && pubkey !== sender),
  );
  const expectedRecipientCount = Math.max(1, channel.memberCount - 1);

  return knownRecipients.size < expectedRecipientCount;
}

type ResolveMessageRecipientPubkeysInput = {
  channel: Channel;
  senderPubkey: string;
  explicitMentions?: readonly string[];
  cachedMemberPubkeys?: readonly string[];
  loadDmMemberPubkeys: () => Promise<readonly string[]>;
};

/**
 * Resolve message recipients without ever emitting an unaddressed DM.
 *
 * The normal path is entirely local. Only an incomplete DM snapshot falls
 * back to the authoritative membership query; if that query still cannot
 * identify every expected recipient, the send fails visibly instead of
 * publishing a message that no recipient or hosted agent can receive.
 */
export async function resolveHydratedMessageRecipientPubkeys({
  channel,
  senderPubkey,
  explicitMentions = [],
  cachedMemberPubkeys = [],
  loadDmMemberPubkeys,
}: ResolveMessageRecipientPubkeysInput): Promise<string[]> {
  if (channel.channelType !== "dm") {
    return messageMentionPubkeys(channel, senderPubkey, explicitMentions);
  }

  let memberPubkeys = cachedMemberPubkeys;
  if (
    dmRecipientPubkeysNeedHydration(channel, senderPubkey, cachedMemberPubkeys)
  ) {
    memberPubkeys = await loadDmMemberPubkeys();
  }

  if (dmRecipientPubkeysNeedHydration(channel, senderPubkey, memberPubkeys)) {
    throw new Error(
      "Direct message recipients are still loading. Try sending again.",
    );
  }

  return messageMentionPubkeys(channel, senderPubkey, [
    ...explicitMentions,
    ...memberPubkeys,
  ]);
}

type ResolveMessageRecipientPubkeysForSendInput = {
  channel: Channel;
  senderPubkey: string;
  explicitMentions?: readonly string[];
  queryClient: QueryClient;
};

/**
 * Stable send-path composition hook. It shares the channel-members query cache
 * used by the channel UI, then forces a relay read only when that local state
 * cannot address every expected DM recipient.
 */
export async function resolveMessageRecipientPubkeys({
  channel,
  senderPubkey,
  explicitMentions,
  queryClient,
}: ResolveMessageRecipientPubkeysForSendInput): Promise<string[]> {
  const membersKey = ["channels", channel.id, "members"] as const;
  const cachedMemberPubkeys =
    queryClient
      .getQueryData<ChannelMember[]>(membersKey)
      ?.map((member) => member.pubkey) ?? [];

  return resolveHydratedMessageRecipientPubkeys({
    channel,
    senderPubkey,
    explicitMentions,
    cachedMemberPubkeys,
    loadDmMemberPubkeys: async () =>
      (
        await queryClient.fetchQuery({
          queryKey: membersKey,
          queryFn: () => getChannelMembers(channel.id),
          // This branch runs only after local membership proved incomplete;
          // force an authoritative read even if an incomplete query was just
          // populated.
          staleTime: 0,
        })
      ).map((member) => member.pubkey),
  });
}

import * as React from "react";

import { useKnownAgentPubkeys } from "@/features/agents/useKnownAgentPubkeys";
import { useChannelMembersQuery } from "@/features/channels/hooks";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { channelAgentMembers } from "@/shared/lib/rosterDerivations";

/**
 * Which keys the "/" menu treats as agents. Wider than "mentionable here"
 * (the mention picker's rule): any agent the directory knows, a channel
 * member with an agent role, or a profile marked as an agent. The menu only
 * needs to know who to ask; the server answers with what the viewer may
 * use with that agent (nothing, for an agent they cannot command).
 */
export function useSlashAgentPredicate(
  channelId: string | null,
  isMentionableAgent: (pubkey: string) => boolean,
  profiles?: UserProfileLookup,
): (pubkey: string) => boolean {
  const knownAgents = useKnownAgentPubkeys();
  const members = useChannelMembersQuery(channelId).data;
  const memberAgents = React.useMemo(
    () =>
      new Set(
        (members ? channelAgentMembers(members) : []).map((member) =>
          normalizePubkey(member.pubkey),
        ),
      ),
    [members],
  );
  return React.useCallback(
    (pubkey: string) => {
      const key = normalizePubkey(pubkey);
      return (
        Boolean(key) &&
        (isMentionableAgent(key) ||
          knownAgents.has(key) ||
          memberAgents.has(key) ||
          profiles?.[key]?.isAgent === true)
      );
    },
    [isMentionableAgent, knownAgents, memberAgents, profiles],
  );
}

import * as React from "react";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useKnownAgentPubkeys } from "@/features/agents/useKnownAgentPubkeys";
import type { Channel } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

import {
  type DelegationBoardState,
  getDelegationBoard,
  subscribeDelegations,
} from "../lib/delegationStore";
import { delegationDmAgent } from "../lib/delegations";

const HIDDEN: DelegationBoardState = { status: "hidden" };
const noSubscription = () => () => {};
const hidden = () => HIDDEN;

/**
 * The delegation board of the agent in the reader's own 1:1 DM, shared by
 * the header and the dock. Hidden anywhere else, for an agent this device
 * runs itself (it has no host), and for anyone but the agent's owner.
 */
export function useAgentDelegations(
  channel: Channel | null,
  viewerPubkey: string | null | undefined,
): { agentPubkey: string | null; board: DelegationBoardState } {
  const knownAgents = useKnownAgentPubkeys();
  const managedAgents = useManagedAgentsQuery();
  const other = delegationDmAgent(channel, viewerPubkey);
  const agentPubkey =
    other &&
    knownAgents.has(other) &&
    !managedAgents.isPending &&
    !(managedAgents.data ?? []).some(
      (agent) => normalizePubkey(agent.pubkey) === other,
    )
      ? other
      : null;
  const subscribe = React.useCallback(
    (listener: () => void) =>
      agentPubkey ? subscribeDelegations(agentPubkey, listener) : () => {},
    [agentPubkey],
  );
  const snapshot = React.useCallback(
    () => (agentPubkey ? getDelegationBoard(agentPubkey) : HIDDEN),
    [agentPubkey],
  );
  const board = React.useSyncExternalStore(
    agentPubkey ? subscribe : noSubscription,
    agentPubkey ? snapshot : hidden,
  );
  return { agentPubkey, board };
}

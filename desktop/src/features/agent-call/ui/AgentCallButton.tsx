import { Phone } from "lucide-react";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useKnownAgentPubkeys } from "@/features/agents/useKnownAgentPubkeys";
import type { Channel } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";

import { agentCallController } from "../lib/agentCallController";
import { useAgentCall } from "./useAgentCall";

/**
 * "Call <agent>" in a 1:1 agent DM header: a proper voice call with the
 * agent (its host's voice core), not a huddle. The host checks that this is
 * the caller's own private DM with the agent before it answers.
 *
 * Only hosted agents take calls: an agent this app runs locally (a managed
 * agent on this device) has no voice host, so it gets no Call button. The
 * host stays the authority for everything else and refuses with a reason.
 */
export function AgentCallButton({
  agentName,
  agentPubkey,
  channel,
  isAgentHint,
}: {
  agentName: string;
  agentPubkey: string;
  channel: Channel;
  isAgentHint: boolean;
}) {
  const knownAgents = useKnownAgentPubkeys();
  const managedAgents = useManagedAgentsQuery();
  const call = useAgentCall();
  const key = normalizePubkey(agentPubkey);
  const isAgent = isAgentHint || knownAgents.has(key);
  // Wait for the local inventory so the button never flashes for a local
  // agent; a failed inventory read still shows it (the host decides).
  const runsOnThisDevice =
    managedAgents.isPending ||
    (managedAgents.data ?? []).some(
      (agent) => normalizePubkey(agent.pubkey) === key,
    );
  if (channel.channelType !== "dm" || !isAgent || runsOnThisDevice) {
    return null;
  }

  const busy =
    call.phase === "requesting_mic" ||
    call.phase === "connecting" ||
    call.phase === "live" ||
    call.phase === "ending";
  const withThisAgent = busy && call.agentPubkey === key;
  const label = withThisAgent
    ? `On a call with ${agentName}`
    : busy
      ? "You're already on a call"
      : `Call ${agentName}`;

  return (
    <Button
      aria-label={label}
      disabled={busy}
      onClick={() => {
        void agentCallController.start({
          agentPubkey: key,
          channelId: channel.id,
          agentName,
        });
      }}
      size="icon"
      title={label}
      type="button"
      variant={withThisAgent ? "secondary" : "outline"}
    >
      <Phone />
    </Button>
  );
}

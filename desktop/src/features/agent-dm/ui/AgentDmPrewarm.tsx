import * as React from "react";

import { useKnownAgentPubkeys } from "@/features/agents/useKnownAgentPubkeys";
import { normalizePubkey } from "@/shared/lib/pubkey";

import { prewarmAgent } from "../lib/agentPrewarm";

/**
 * Renders nothing; when a 1:1 DM with an agent opens, asks the guest route
 * to warm that agent (debounced per agent, fire and forget).
 */
export function AgentDmPrewarm({
  agentPubkey,
  isAgentHint,
}: {
  agentPubkey: string;
  isAgentHint: boolean;
}) {
  const knownAgents = useKnownAgentPubkeys();
  const key = normalizePubkey(agentPubkey);
  const isAgent = isAgentHint || knownAgents.has(key);
  React.useEffect(() => {
    if (isAgent) prewarmAgent(key);
  }, [isAgent, key]);
  return null;
}

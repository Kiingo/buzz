import type * as React from "react";

import { useKnownAgentPubkeys } from "@/features/agents/useKnownAgentPubkeys";
import { useChannelMembersQuery } from "@/features/channels/hooks";
import type { TimelineMessage } from "@/features/messages/types";
import { useIdentityQuery } from "@/shared/api/hooks";
import { normalizePubkey } from "@/shared/lib/pubkey";

import { surfaceCardAllowed } from "../lib/surfaceCardGate";
import { agentDmMessageKinds } from "../lib/timeline";
import { AgentActionButtons } from "./AgentActionButtons";
import { AgentCallCard } from "./AgentCallCard";
import { AgentMirrorMarker } from "./AgentMirrorMarker";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { AgentSessionsListing } from "./AgentSessionsListing";
import { AgentSurfaceCard } from "./AgentSurfaceCard";

/** S6: a surface card only in a 1:1 DM with the viewer's own verified agent. */
function useSurfaceCardAllowed(
  channelId: string | null,
  message: TimelineMessage,
  wanted: boolean,
) {
  const viewerPubkey = useIdentityQuery().data?.pubkey;
  const members = useChannelMembersQuery(channelId, wanted).data;
  return (
    wanted &&
    surfaceCardAllowed({
      viewerPubkey,
      signerPubkey: message.signerPubkey,
      verifiedOwnerPubkey: message.ownerPubkey,
      memberPubkeys: members?.map((member) => member.pubkey),
    })
  );
}

function useIsAgentSigned(message: TimelineMessage) {
  const knownAgents = useKnownAgentPubkeys();
  const signer = normalizePubkey(message.signerPubkey ?? "");
  return (
    signer.length > 0 &&
    normalizePubkey(message.pubkey ?? "") === signer &&
    (message.isAgent === true || knownAgents.has(signer))
  );
}

/**
 * Agent DM marker UI under a message body: the mirror badge, a question card,
 * action buttons or a surface card. Renders nothing unless the formatter honoured the
 * markers (DM channel, signer is a member).
 */
export function AgentDmMessageExtras({
  channelId,
  message,
}: {
  channelId: string | null;
  message: TimelineMessage;
}) {
  const kinds = agentDmMessageKinds(message);
  const agentSigned = useIsAgentSigned(message);
  const surfaceAllowed = useSurfaceCardAllowed(
    channelId,
    message,
    kinds.includes("surface") && agentSigned,
  );
  if (kinds.length === 0) return null;
  // A call card shows its own title and direction in the body.
  if (kinds.includes("call")) return null;
  if (kinds.includes("mirror")) return <AgentMirrorMarker message={message} />;
  if (!channelId || !agentSigned) return null;
  return (
    <>
      {kinds.includes("question") ? (
        <AgentQuestionCard channelId={channelId} message={message} />
      ) : null}
      {kinds.includes("actions") ? (
        <AgentActionButtons channelId={channelId} message={message} />
      ) : null}
      {surfaceAllowed ? (
        <AgentSurfaceCard channelId={channelId} message={message} />
      ) : null}
    </>
  );
}

/**
 * Body replacement for honoured agent DM rows (the sessions listing renders
 * as a compact list). Returns null to keep the default body.
 */
export function renderAgentDmBody(
  message: TimelineMessage,
): React.ReactNode | null {
  const kinds = agentDmMessageKinds(message);
  if (kinds.includes("call")) return <AgentCallCard message={message} />;
  return kinds.includes("listing") ? (
    <AgentSessionsListing message={message} />
  ) : null;
}

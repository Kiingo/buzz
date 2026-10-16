import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";

import { useGuestAccessSnapshot } from "../hooks";
import { alertDestination } from "../lib/alertRoute";
import {
  closeAgentAccess,
  dismissGuestAlert,
  openAgentAccess,
  type AgentAccessTarget,
  type GuestAlert,
} from "../lib/store";
import { useGuestAccessPipeline } from "../useGuestAccessPipeline";
import { AgentGuestAccessDialog } from "./access/AgentGuestAccessDialog";
import { GuestAlertBanner } from "./GuestAlertBanner";
import { GuestApprovalDialog } from "./GuestApprovalDialog";
import { LinkAccountPrompt } from "./LinkAccountPrompt";

/** One agent's Access dialog, opened from an alert rather than agent settings. */
function AlertAccessDialog({ target }: { target: AgentAccessTarget }) {
  const agents = useManagedAgentsQuery();
  const agent = agents.data?.find(
    (candidate) => candidate.pubkey.toLowerCase() === target.agentPubkey,
  );
  return (
    <AgentGuestAccessDialog
      agentName={agent?.name ?? "your agent"}
      agentPubkey={target.agentPubkey}
      initialTab={target.tab}
      key={`${target.agentPubkey}:${target.tab}`}
      onOpenChange={(open) => {
        if (!open) closeAgentAccess();
      }}
      open
      respondTo={agent?.respondTo ?? null}
    />
  );
}

/**
 * Global owner-side guest access surfaces: the approval review dialog, the
 * alert banner (whose Review opens the agent's Access dialog or the admin
 * safety card), and the link-your-account prompt. Renders nothing in builds
 * without a hosted guest route.
 */
export function GuestAccessHost() {
  const pipeline = useGuestAccessPipeline();
  const snapshot = useGuestAccessSnapshot();
  const { goSettings } = useAppNavigation();
  if (!pipeline.enabled) return null;

  const harnessReportsUnlinked = Object.values(snapshot.endpointStatus).some(
    (status) => status.status === "owner_unlinked",
  );
  const review = (alert: GuestAlert) => {
    const destination = alertDestination(alert.kind);
    if (!destination) return;
    if (destination.type === "admin") {
      void goSettings("profile");
      return;
    }
    openAgentAccess({ agentPubkey: alert.agentPubkey, tab: destination.tab });
  };

  return (
    <>
      <GuestApprovalDialog />
      <GuestAlertBanner
        alerts={snapshot.alerts}
        onDismiss={dismissGuestAlert}
        onReview={review}
      />
      {snapshot.accessTarget ? (
        <AlertAccessDialog target={snapshot.accessTarget} />
      ) : null}
      <LinkAccountPrompt
        forceUnlinked={pipeline.ownerUnlinked || harnessReportsUnlinked}
      />
    </>
  );
}

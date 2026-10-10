import { useAppNavigation } from "@/app/navigation/useAppNavigation";

import { useGuestAccessSnapshot } from "../hooks";
import { dismissGuestAlert } from "../lib/store";
import { useGuestAccessPipeline } from "../useGuestAccessPipeline";
import { GuestAlertBanner } from "./GuestAlertBanner";
import { GuestApprovalDialog } from "./GuestApprovalDialog";
import { LinkAccountPrompt } from "./LinkAccountPrompt";

/**
 * Global owner-side guest access surfaces: the approval review dialog, the
 * alert banner, and the link-your-account prompt. Renders nothing in builds
 * without a hosted guest route.
 */
export function GuestAccessHost() {
  const pipeline = useGuestAccessPipeline();
  const snapshot = useGuestAccessSnapshot();
  const { goAgents } = useAppNavigation();
  if (!pipeline.enabled) return null;

  const harnessReportsUnlinked = Object.values(snapshot.endpointStatus).some(
    (status) => status.status === "owner_unlinked",
  );

  return (
    <>
      <GuestApprovalDialog />
      <GuestAlertBanner
        alerts={snapshot.alerts}
        onDismiss={dismissGuestAlert}
        onOpenSettings={() => void goAgents()}
      />
      <LinkAccountPrompt
        forceUnlinked={pipeline.ownerUnlinked || harnessReportsUnlinked}
      />
    </>
  );
}

import { useQuery } from "@tanstack/react-query";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { useGuestAccessSnapshot } from "../hooks";
import { guestAccessApi } from "../lib/client";
import { requesterLabel } from "../lib/copy";
import { closeApprovalReview } from "../lib/store";
import { GuestApprovalReview } from "./GuestApprovalReview";

export function guestApprovalQueryKey(approvalId: string | null) {
  return ["guest-access", "approval", approvalId] as const;
}

/** Fetch one approval with its exact question and draft text. */
export function useGuestApprovalQuery(approvalId: string | null) {
  return useQuery({
    queryKey: guestApprovalQueryKey(approvalId),
    queryFn: () => guestAccessApi.approval(approvalId ?? ""),
    enabled: Boolean(approvalId),
    staleTime: 15_000,
    retry: 1,
  });
}

/**
 * Global review dialog. Opens when a trusted 46040 arrives (or from the
 * Inbox), loads the record from the decision API, and closes on a decision
 * or a 46041 for the same approval.
 */
export function GuestApprovalDialog() {
  const { openApprovalId } = useGuestAccessSnapshot();
  const query = useGuestApprovalQuery(openApprovalId);
  const approval = query.data ?? null;

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) closeApprovalReview();
      }}
      open={openApprovalId !== null}
    >
      <DialogContent
        className="max-h-[85vh] max-w-xl overflow-y-auto"
        data-testid="guest-approval-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {approval
              ? `${requesterLabel(approval.requester)} is waiting on ${approval.agent.displayName ?? "your agent"}`
              : "Approval requested"}
          </DialogTitle>
          <DialogDescription>
            Your agent drafted a reply that needs your approval before it is
            sent. Nothing is shared until you approve.
          </DialogDescription>
        </DialogHeader>
        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading request…</p>
        ) : query.error ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive" role="alert">
              {query.error instanceof Error
                ? query.error.message
                : "Could not load this request."}
            </p>
            <button
              className="text-sm underline"
              onClick={() => void query.refetch()}
              type="button"
            >
              Retry
            </button>
          </div>
        ) : approval ? (
          <GuestApprovalReview
            approval={approval}
            key={approval.approvalId}
            onDone={closeApprovalReview}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

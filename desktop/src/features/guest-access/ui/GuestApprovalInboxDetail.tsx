import { ArrowLeft, ShieldQuestion } from "lucide-react";

import type { FeedItem } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";

import { guestApprovalIdOf } from "../lib/store";
import { useGuestApprovalQuery } from "./GuestApprovalDialog";
import { GuestApprovalReview } from "./GuestApprovalReview";

/** Inbox detail pane for a pending agent guest approval (kind 46040). */
export function GuestApprovalInboxDetail({
  item,
  onBack,
}: {
  item: FeedItem;
  onBack?: () => void;
}) {
  const approvalId = guestApprovalIdOf(item);
  const query = useGuestApprovalQuery(approvalId);

  return (
    <section
      className="flex min-h-0 min-w-0 flex-col bg-background/60"
      data-testid="guest-approval-inbox-detail"
    >
      <div className="flex min-h-13 items-center gap-2 px-5 py-2">
        {onBack ? (
          <Button
            aria-label="Back to Inbox"
            onClick={onBack}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        ) : null}
        <ShieldQuestion aria-hidden className="h-4 w-4 text-amber-500" />
        <h2 className="text-sm font-medium">Approval requested</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {!approvalId ? (
          <p className="text-sm text-muted-foreground">
            This request is missing its approval id.
          </p>
        ) : query.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading request…</p>
        ) : query.error ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive" role="alert">
              {query.error instanceof Error
                ? query.error.message
                : "Could not load this request."}
            </p>
            <Button
              onClick={() => void query.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        ) : query.data ? (
          <div className="max-w-2xl">
            <GuestApprovalReview
              approval={query.data}
              key={query.data.approvalId}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

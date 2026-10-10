import { Button } from "@/shared/ui/button";

import { requesterLabel } from "../../lib/copy";
import { guestAccessApi } from "../../lib/client";
import { useOwnerBlocks, useOwnerMutation } from "../../ownerQueries";
import { MutationError, QueryState, formatDate } from "./shared";

/** People blocked from all of your agents (or just this one), with unblock. */
export function GuestBlocksTab({
  guestEndpointId,
}: {
  guestEndpointId: string | null;
}) {
  const blocks = useOwnerBlocks();
  const unblock = useOwnerMutation((blockId: string) =>
    guestAccessApi.unblock(blockId),
  );
  const rows = (blocks.data ?? []).filter(
    (row) =>
      row.guestEndpointId === null || row.guestEndpointId === guestEndpointId,
  );

  return (
    <div data-testid="guest-blocks-tab">
      <p className="text-sm text-muted-foreground">
        Blocked people get no answers from your agents. Block someone from the
        Requests tab or when you decline a request.
      </p>
      <QueryState
        empty={rows.length === 0}
        emptyText="Nobody is blocked."
        error={blocks.error}
        isLoading={blocks.isLoading}
        onRetry={() => void blocks.refetch()}
      >
        <ul className="divide-y divide-border/60">
          {rows.map((row) => (
            <li
              className="flex items-center justify-between gap-3 py-3 text-sm"
              data-testid="guest-block-row"
              key={row.blockId}
            >
              <div className="min-w-0">
                <p className="font-medium">{requesterLabel(row)}</p>
                <p className="text-xs text-muted-foreground">
                  {row.guestEndpointId ? "This agent" : "All your agents"} ·
                  since {formatDate(row.createdAt)}
                  {row.reason ? ` · ${row.reason}` : ""}
                </p>
              </div>
              <Button
                data-testid="guest-block-remove"
                disabled={unblock.isPending}
                onClick={() => unblock.mutate(row.blockId)}
                size="sm"
                type="button"
                variant="outline"
              >
                Unblock
              </Button>
            </li>
          ))}
        </ul>
      </QueryState>
      <MutationError error={unblock.error} />
    </div>
  );
}

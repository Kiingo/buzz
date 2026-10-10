import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";

import { dataSourceLabel, scopeLabel } from "../../lib/copy";
import { guestAccessApi } from "../../lib/client";
import type { GuestGrant } from "../../lib/wire";
import { useOwnerGrants, useOwnerMutation } from "../../ownerQueries";
import {
  MutationError,
  QueryState,
  formatDate,
  formatRelative,
} from "./shared";

/** Active (unexpired, unrevoked) grants for one guest endpoint. */
export function activeGrantsFor(
  grants: readonly GuestGrant[],
  guestEndpointId: string | null,
  now = Date.now(),
): GuestGrant[] {
  return grants.filter(
    (grant) =>
      grant.revokedAt === null &&
      (guestEndpointId === null || grant.guestEndpointId === guestEndpointId) &&
      (grant.expiresAt === null || Date.parse(grant.expiresAt) > now),
  );
}

export function GrantRow({
  grant,
  onRevoke,
  revoking,
}: {
  grant: GuestGrant;
  onRevoke: () => void;
  revoking: boolean;
}) {
  return (
    <li
      className="flex items-start justify-between gap-3 py-3"
      data-testid="guest-grant-row"
    >
      <div className="min-w-0 space-y-1 text-sm">
        <p className="font-medium">
          {grant.grantee.displayName ?? "Someone"} · {scopeLabel(grant.scope)}
        </p>
        <div className="flex flex-wrap gap-1">
          {grant.dataSources.map((source) => (
            <Badge key={source} variant="outline">
              {dataSourceLabel(source)}
            </Badge>
          ))}
          {grant.questionKind ? (
            <Badge variant="secondary">
              {grant.questionKind.replace(/_/g, " ")}
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {grant.expiresAt
            ? `Expires ${formatDate(grant.expiresAt)}`
            : "No expiry"}{" "}
          · used {grant.useCount} {grant.useCount === 1 ? "time" : "times"} ·
          last used {formatRelative(grant.lastUsedAt)}
        </p>
      </div>
      <Button
        data-testid="guest-grant-revoke"
        disabled={revoking}
        onClick={onRevoke}
        size="sm"
        type="button"
        variant="outline"
      >
        Revoke
      </Button>
    </li>
  );
}

export function GuestGrantsTab({
  guestEndpointId,
}: {
  guestEndpointId: string | null;
}) {
  const grants = useOwnerGrants();
  const revoke = useOwnerMutation((grantId: string) =>
    guestAccessApi.revokeGrant(grantId),
  );
  const active = activeGrantsFor(grants.data ?? [], guestEndpointId);

  return (
    <div data-testid="guest-grants-tab">
      <p className="text-sm text-muted-foreground">
        People you've allowed to get answers that use information only you can
        see. Revoking takes effect within 10 minutes.
      </p>
      <QueryState
        empty={active.length === 0}
        emptyText="No active grants. Grants are created when you approve a request."
        error={grants.error}
        isLoading={grants.isLoading}
        onRetry={() => void grants.refetch()}
      >
        <ul className="divide-y divide-border/60">
          {active.map((grant) => (
            <GrantRow
              grant={grant}
              key={grant.grantId}
              onRevoke={() => revoke.mutate(grant.grantId)}
              revoking={revoke.isPending}
            />
          ))}
        </ul>
      </QueryState>
      <MutationError error={revoke.error} />
    </div>
  );
}

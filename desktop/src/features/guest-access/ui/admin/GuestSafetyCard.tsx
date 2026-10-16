import { ShieldAlert } from "lucide-react";

import { useUserProfileQuery } from "@/features/profile/hooks";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";

import { useGuestAccessEnabled } from "../../hooks";
import { guestAccessApi } from "../../lib/client";
import { adminAlertText, suspensionReasonText } from "../../lib/adminCopy";
import type { GuestAdminAlert, GuestSuspendedRequester } from "../../lib/wire";
import {
  isAdminRequired,
  useAdminGuestSafety,
  useOwnerMutation,
} from "../../ownerQueries";
import { MutationError, QueryState, formatDate } from "../access/shared";

/** A person's Buzz display name, falling back to a short key. */
function usePersonName(pubkey: string | null): string {
  const profile = useUserProfileQuery(pubkey ?? undefined);
  if (!pubkey) return "Someone";
  return profile.data?.displayName || truncatePubkey(pubkey);
}

function AlertRow({
  alert,
  disabled,
  onAcknowledge,
}: {
  alert: GuestAdminAlert;
  disabled: boolean;
  onAcknowledge: () => void;
}) {
  const name = usePersonName(alert.requesterPubkey);
  return (
    <li
      className="flex items-start justify-between gap-3 py-3 text-sm"
      data-testid="guest-safety-alert"
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={alert.severity === "high" ? "destructive" : "secondary"}
          >
            {alert.kind === "requester_suspended"
              ? "Suspended"
              : "Unusual pattern"}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {formatDate(alert.createdAt)}
          </span>
        </div>
        <p className="break-words">{adminAlertText(alert, name)}</p>
      </div>
      <Button
        data-testid="guest-safety-alert-ack"
        disabled={disabled}
        onClick={onAcknowledge}
        size="sm"
        type="button"
        variant="outline"
      >
        Mark reviewed
      </Button>
    </li>
  );
}

function SuspendedRow({
  disabled,
  onRestore,
  person,
}: {
  disabled: boolean;
  onRestore: () => void;
  person: GuestSuspendedRequester;
}) {
  const name = usePersonName(person.pubkey);
  return (
    <li
      className="flex items-start justify-between gap-3 py-3 text-sm"
      data-testid="guest-safety-suspended"
    >
      <div className="min-w-0">
        <p className="font-medium">{name}</p>
        <p className="text-xs text-muted-foreground">
          Suspended {formatDate(person.suspendedAt)}
          {person.reason ? ` · ${suspensionReasonText(person.reason)}` : ""}
        </p>
      </div>
      <Button
        data-testid="guest-safety-restore"
        disabled={disabled}
        onClick={onRestore}
        size="sm"
        type="button"
        variant="outline"
      >
        Restore access
      </Button>
    </li>
  );
}

/**
 * Settings → Profile, for organization admins only: org-wide guest safety
 * alerts (suspensions, unusual request patterns) and people whose guest
 * access is suspended, with Mark reviewed and Restore access. Hidden for
 * everyone else and in builds without a guest route.
 */
export function GuestSafetyCard() {
  const enabled = useGuestAccessEnabled();
  const safety = useAdminGuestSafety(enabled);
  const acknowledge = useOwnerMutation((alertId: string) =>
    guestAccessApi.acknowledgeAdminAlert(alertId),
  );
  const restore = useOwnerMutation((pubkey: string) =>
    guestAccessApi.restoreRequester(pubkey),
  );
  if (!enabled || isAdminRequired(safety.error)) return null;

  const alerts = safety.data?.alerts ?? [];
  const suspended = safety.data?.suspended ?? [];
  const busy = acknowledge.isPending || restore.isPending;

  return (
    <section
      className="mt-8 min-w-0"
      data-testid="settings-guest-safety"
      id="guest-safety"
    >
      <div className="mb-3 flex items-start gap-2">
        <ShieldAlert aria-hidden className="mt-1 h-4 w-4 shrink-0" />
        <div>
          <h3 className="text-base font-semibold text-foreground">
            Agent guest safety
          </h3>
          <p className="text-sm text-muted-foreground">
            For organization admins. People who repeatedly send risky requests
            to colleagues' agents show up here. A suspended person can't ask any
            agent until you restore them.
          </p>
        </div>
      </div>
      <QueryState
        empty={alerts.length === 0 && suspended.length === 0}
        emptyText="Nothing needs review. Nobody is suspended."
        error={safety.error}
        isLoading={safety.isLoading}
        onRetry={() => void safety.refetch()}
      >
        {suspended.length > 0 ? (
          <div className="mb-4">
            <h4 className="text-sm font-medium">Suspended</h4>
            <ul className="divide-y divide-border/60">
              {suspended.map((person) => (
                <SuspendedRow
                  disabled={busy}
                  key={person.pubkey}
                  onRestore={() => restore.mutate(person.pubkey)}
                  person={person}
                />
              ))}
            </ul>
          </div>
        ) : null}
        {alerts.length > 0 ? (
          <div>
            <h4 className="text-sm font-medium">Alerts</h4>
            <ul className="divide-y divide-border/60">
              {alerts.map((alert) => (
                <AlertRow
                  alert={alert}
                  disabled={busy}
                  key={alert.alertId}
                  onAcknowledge={() => acknowledge.mutate(alert.alertId)}
                />
              ))}
            </ul>
          </div>
        ) : null}
      </QueryState>
      <MutationError error={acknowledge.error ?? restore.error} />
    </section>
  );
}

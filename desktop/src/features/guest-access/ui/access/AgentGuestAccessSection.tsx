import * as React from "react";
import { ChevronRight, ShieldCheck } from "lucide-react";

import { Button } from "@/shared/ui/button";

import { useGuestAccessEnabled, useGuestAccessSnapshot } from "../../hooks";
import {
  useGuestEndpointFor,
  useOwnerGrants,
  useOwnerSuggestions,
} from "../../ownerQueries";
import { AgentGuestAccessDialog } from "./AgentGuestAccessDialog";
import { activeGrantsFor } from "./GuestGrantsTab";
import { respondToSummary } from "./GuestPolicyTab";

/**
 * Compact Access summary under "Who can send instructions" in agent settings,
 * opening the full Access dialog. Hidden in builds without a guest route.
 */
export function AgentGuestAccessSection({
  agent,
  respondTo,
}: {
  agent: { pubkey: string; name: string };
  respondTo: string | null | undefined;
}) {
  const enabled = useGuestAccessEnabled();
  const [open, setOpen] = React.useState(false);
  const { endpoint } = useGuestEndpointFor(enabled ? agent.pubkey : null);
  const grants = useOwnerGrants();
  const suggestions = useOwnerSuggestions();
  const snapshot = useGuestAccessSnapshot();
  if (!enabled) return null;

  const guestEndpointId = endpoint?.guestEndpointId ?? null;
  const activeGrants = guestEndpointId
    ? activeGrantsFor(grants.data ?? [], guestEndpointId).length
    : 0;
  const openSuggestions = (suggestions.data ?? []).filter(
    (row) => row.guestEndpointId === guestEndpointId,
  ).length;
  const pending = snapshot.pending.filter(
    (entry) => entry.agentPubkey === agent.pubkey.toLowerCase(),
  ).length;
  const details = [
    pending > 0 ? `${pending} waiting for you` : null,
    `${activeGrants} active ${activeGrants === 1 ? "grant" : "grants"}`,
    openSuggestions > 0
      ? `${openSuggestions} ${openSuggestions === 1 ? "suggestion" : "suggestions"}`
      : null,
    endpoint && !endpoint.enabled ? "hosted answers off" : null,
  ].filter(Boolean);

  return (
    <div className="space-y-1.5" data-testid="agent-guest-access-section">
      <span className="text-sm font-medium text-foreground">Guest access</span>
      <Button
        className="flex h-auto w-full items-start justify-between gap-3 px-3 py-2 text-left"
        data-testid="agent-guest-access-open"
        onClick={() => setOpen(true)}
        type="button"
        variant="outline"
      >
        <span className="flex min-w-0 items-start gap-2">
          <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0">
            <span className="block whitespace-normal text-sm font-normal">
              {respondToSummary(respondTo)}
            </span>
            <span className="block text-xs font-normal text-muted-foreground">
              {details.join(" · ")}
            </span>
          </span>
        </span>
        <ChevronRight aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      </Button>
      <AgentGuestAccessDialog
        agentName={agent.name}
        agentPubkey={agent.pubkey}
        onOpenChange={setOpen}
        open={open}
        respondTo={respondTo}
      />
    </div>
  );
}

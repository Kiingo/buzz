import * as React from "react";
import { CheckCircle2, Clock, ShieldCheck, ShieldX } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

import {
  getGuestTurnsVersion,
  isGuestTurnResolved,
  isPendingKind,
  isRefusalKind,
  parseGuestReplyMarker,
  registerGuestReply,
  subscribeGuestTurns,
  type GuestReplyMarker as Marker,
} from "../lib/guestReply";

type MarkerView = {
  label: string;
  tone: "pending" | "resolved" | "refusal" | "guest";
  tooltip: string;
};

/** What the marker says for a given reply kind and resolution state. */
export function guestMarkerView(marker: Marker, resolved: boolean): MarkerView {
  const routeNote =
    "Answered by the hosted guest route, using only what both the agent's owner and the person asking can see.";
  if (isPendingKind(marker.kind)) {
    return resolved
      ? {
          label: "Owner responded below",
          tone: "resolved",
          tooltip: "The agent's owner has made a decision on this request.",
        }
      : {
          label: "Waiting for the owner",
          tone: "pending",
          tooltip:
            "This needs the agent owner's approval. The reply will appear in this thread once they decide.",
        };
  }
  if (marker.kind === "refusal") {
    return {
      label: "Declined",
      tone: "refusal",
      tooltip:
        "The agent can't help with this request. You can ask its owner directly.",
    };
  }
  if (isRefusalKind(marker.kind)) {
    return { label: "Notice", tone: "refusal", tooltip: routeNote };
  }
  if (marker.kind === "approved_answer") {
    return {
      label: "Guest reply · approved by owner",
      tone: "guest",
      tooltip: `${routeNote} The owner approved this exact text.`,
    };
  }
  return { label: "Guest reply", tone: "guest", tooltip: routeNote };
}

const TONE_CLASS: Record<MarkerView["tone"], string> = {
  pending:
    "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  resolved:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  refusal: "border-border bg-muted/60 text-muted-foreground",
  guest: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
};

const TONE_ICON = {
  pending: Clock,
  resolved: CheckCircle2,
  refusal: ShieldX,
  guest: ShieldCheck,
} as const;

/**
 * Marker under a message that an agent produced through the hosted guest
 * route (it carries `buzz-guest`). Renders nothing for ordinary messages.
 */
export function GuestReplyMarker({
  createdAt,
  tags,
}: {
  createdAt: number;
  tags: string[][] | undefined;
}) {
  const marker = React.useMemo(() => parseGuestReplyMarker(tags), [tags]);
  React.useEffect(() => {
    if (marker) registerGuestReply(marker, createdAt);
  }, [marker, createdAt]);
  React.useSyncExternalStore(
    subscribeGuestTurns,
    getGuestTurnsVersion,
    getGuestTurnsVersion,
  );
  if (!marker) return null;

  const view = guestMarkerView(marker, isGuestTurnResolved(marker.turnId));
  const Icon = TONE_ICON[view.tone];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium",
            TONE_CLASS[view.tone],
          )}
          data-guest-reply-kind={marker.kind}
          data-testid="guest-reply-marker"
        >
          <Icon aria-hidden className="h-3 w-3" />
          {view.label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{view.tooltip}</TooltipContent>
    </Tooltip>
  );
}

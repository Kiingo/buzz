import { Forward } from "lucide-react";
import type * as React from "react";

import { formatFullDateTime } from "@/features/messages/lib/dateFormatters";
import type { TimelineMessage } from "@/features/messages/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

import { mirrorBadgeLabel } from "../lib/markers";

/**
 * Relay line under a mirrored message, from the shared display rule
 * (`mirrorDisplay`): the "via <surface>" badge and, for a requester mirror,
 * a relay glyph and "relayed by <agent>". Always visible; a claimed name is
 * never shown as the author.
 */
export function AgentMirrorMarker({ message }: { message: TimelineMessage }) {
  const display = message.agentDmMirror;
  if (!display) return null;
  const { mirror } = display;

  const badge = mirrorBadgeLabel(mirror.surface);
  const sentAt = formatFullDateTime(mirror.originalAt);
  const details = mirror.subject
    ? `Originally sent ${sentAt}. Subject: ${mirror.subject}`
    : `Originally sent ${sentAt}.`;

  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground"
      data-relayed={display.relayed ? "true" : undefined}
      data-testid="agent-mirror-marker"
    >
      {display.relayed ? (
        <Forward
          aria-hidden="true"
          className="h-3 w-3 shrink-0"
          data-testid="agent-mirror-relay-glyph"
        />
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={`${display.relayLine}. ${details}`}
            className="inline-flex items-center rounded-full border border-border bg-muted/60 px-2 py-0.5 font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            data-mirror-surface={mirror.surface}
            type="button"
          >
            {badge}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{details}</TooltipContent>
      </Tooltip>
      {display.relayed ? (
        <span data-testid="agent-mirror-relayed-by">
          relayed by {display.relayedByName}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The distinct relayed treatment for a requester mirror's body and relay
 * line: an outlined, muted frame. A relayed line is never drawn like a
 * message its displayed author signed.
 */
export function AgentRelayedMirrorFrame({
  children,
  message,
}: {
  children: React.ReactNode;
  message: TimelineMessage;
}) {
  if (!message.agentDmMirror?.relayed) return <>{children}</>;
  return (
    <div
      className="mt-0.5 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2"
      data-testid="agent-mirror-relayed-frame"
    >
      {children}
    </div>
  );
}

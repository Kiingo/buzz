import * as React from "react";

import { formatFullDateTime } from "@/features/messages/lib/dateFormatters";
import type { TimelineMessage } from "@/features/messages/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

import { mirrorBadgeLabel, parseMirror } from "../lib/markers";

/**
 * "via email" style badge under a mirrored message. When the row could not
 * take the requester's identity it also says who relayed it; a claimed name
 * is never shown as the author.
 */
export function AgentMirrorMarker({ message }: { message: TimelineMessage }) {
  const mirror = React.useMemo(() => parseMirror(message.tags), [message.tags]);
  if (!mirror) return null;

  const badge = mirrorBadgeLabel(mirror.surface);
  const sentAt = formatFullDateTime(mirror.originalAt);
  const overridden =
    Boolean(message.signerPubkey) && message.pubkey !== message.signerPubkey;
  const relayedBy =
    mirror.role === "requester" && !overridden
      ? `Relayed by ${message.author}`
      : null;
  const details = mirror.subject
    ? `Originally sent ${sentAt}. Subject: ${mirror.subject}`
    : `Originally sent ${sentAt}.`;

  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground"
      data-testid="agent-mirror-marker"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={`${badge}. ${details}`}
            className="inline-flex items-center rounded-full border border-border bg-muted/60 px-2 py-0.5 font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            data-mirror-surface={mirror.surface}
            type="button"
          >
            {badge}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{details}</TooltipContent>
      </Tooltip>
      {relayedBy ? <span>{relayedBy}</span> : null}
    </div>
  );
}

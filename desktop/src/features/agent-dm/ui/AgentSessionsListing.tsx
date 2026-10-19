import * as React from "react";

import { formatFullDateTime } from "@/features/messages/lib/dateFormatters";
import type { TimelineMessage } from "@/features/messages/types";

import { parseSessionsListing, type AgentSessionItem } from "../lib/markers";

export function sessionItemTitle(item: AgentSessionItem) {
  return item.title || "Untitled session";
}

export function sessionItemCaption(item: AgentSessionItem) {
  const turns = item.turnCount === 1 ? "1 turn" : `${item.turnCount} turns`;
  return `${turns} · last active ${formatFullDateTime(item.lastActiveAt)}`;
}

/** Compact list rendering of an agent's sessions listing (quiet row). */
export function AgentSessionsListing({
  message,
}: {
  message: TimelineMessage;
}) {
  const listing = React.useMemo(
    () => parseSessionsListing(message.tags),
    [message.tags],
  );
  if (!listing || listing.items.length === 0) {
    return (
      <p className="whitespace-pre-wrap text-message text-foreground">
        {message.body}
      </p>
    );
  }
  return (
    <ol
      aria-label="Sessions"
      className="mt-0.5 flex max-w-xl flex-col divide-y divide-border rounded-lg border border-border bg-muted/20"
      data-testid="agent-sessions-listing"
    >
      {listing.items.map((item) => (
        <li className="flex flex-col px-3 py-1.5" key={item.sessionId}>
          <span className="flex items-center gap-1.5 text-sm text-foreground">
            <span className="truncate">{sessionItemTitle(item)}</span>
            {item.current ? (
              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary">
                Current
              </span>
            ) : null}
          </span>
          <span className="text-2xs text-muted-foreground">
            {sessionItemCaption(item)}
            {item.loadable ? "" : " · can't be loaded"}
          </span>
        </li>
      ))}
    </ol>
  );
}

import * as React from "react";

import type { TimelineMessage } from "@/features/messages/types";

import { parseSessionDivider, sessionDividerLabel } from "../lib/markers";

/**
 * Full-width divider for an agent's session change: "New session" (new,
 * switch) or "Earlier session loaded" (load), captioned by the agent's
 * acknowledgement sentence.
 */
export function AgentSessionDivider({ message }: { message: TimelineMessage }) {
  const divider = React.useMemo(
    () => parseSessionDivider(message.tags),
    [message.tags],
  );
  if (!divider) return null;
  const label = sessionDividerLabel(divider.action);
  const caption = message.body.trim();
  return (
    <div
      className="flex flex-col items-center gap-1 px-4 py-2"
      data-message-id={message.id}
      data-session-action={divider.action}
      data-testid="agent-session-divider"
    >
      <div className="flex w-full items-center gap-3">
        <span aria-hidden className="h-px flex-1 bg-border" />
        <h4 className="shrink-0 text-xs font-semibold text-muted-foreground">
          {label}
        </h4>
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
      {caption ? (
        <p className="text-center text-xs text-muted-foreground">{caption}</p>
      ) : null}
    </div>
  );
}

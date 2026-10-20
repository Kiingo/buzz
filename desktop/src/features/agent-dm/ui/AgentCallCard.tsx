import * as React from "react";
import { Phone } from "lucide-react";

import type { TimelineMessage } from "@/features/messages/types";

import { callTitle, parseCall, splitCallContent } from "../lib/markers";

/**
 * A recorded voice call in an agent DM: a collapsed card titled from the
 * `buzz-call` tag ("Call · N min") with the summary; "Show transcript"
 * expands everything after `Transcript` in the readable content.
 */
export function AgentCallCard({ message }: { message: TimelineMessage }) {
  const call = React.useMemo(() => parseCall(message.tags), [message.tags]);
  const parts = React.useMemo(
    () => splitCallContent(message.body),
    [message.body],
  );
  const [expanded, setExpanded] = React.useState(false);
  const transcriptId = React.useId();
  if (!call) return null;
  const title = callTitle(call);
  const direction =
    call.direction === "outbound" ? "Agent called you" : "You called";

  return (
    <section
      aria-label={title}
      className="mt-0.5 max-w-xl rounded-xl border border-border bg-muted/30 p-3"
      data-call-direction={call.direction}
      data-testid="agent-call-card"
    >
      <div className="flex items-baseline gap-2">
        <Phone
          aria-hidden
          className="h-3.5 w-3.5 self-center text-muted-foreground"
        />
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <span className="truncate text-xs text-muted-foreground">
          {direction}
        </span>
      </div>
      {parts.summary ? (
        <p className="mt-1.5 whitespace-pre-wrap text-message text-foreground">
          {parts.summary}
        </p>
      ) : null}
      {parts.transcript ? (
        <>
          {expanded ? (
            <p
              className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground"
              data-testid="agent-call-transcript"
              id={transcriptId}
            >
              {parts.transcript}
            </p>
          ) : null}
          <button
            aria-controls={expanded ? transcriptId : undefined}
            aria-expanded={expanded}
            className="mt-1.5 rounded text-xs font-medium text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="agent-call-transcript-toggle"
            onClick={() => setExpanded((current) => !current)}
            type="button"
          >
            {expanded ? "Hide transcript" : "Show transcript"}
          </button>
        </>
      ) : null}
    </section>
  );
}

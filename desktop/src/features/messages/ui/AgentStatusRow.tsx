import type { TimelineMessage } from "@/features/messages/types";
import { parseAgentStatus } from "@/features/messages/lib/agentStatus";

/** Operational evidence is deliberately plain text without answer, edit, or
 * deletion affordances. Identity is the event signer, never a payload actor. */
export function AgentStatusRow({ message }: { message: TimelineMessage }) {
  const status = parseAgentStatus({
    kind: message.kind,
    content: message.body,
    tags: message.tags,
  });
  if (!status || !message.parentId || message.parentId !== status.rootId)
    return null;
  return (
    <div
      className="px-4 py-1 text-sm text-muted-foreground"
      data-testid="agent-operational-status"
      data-thread-root={status.rootId}
    >
      <span className="font-medium">{message.author} · System status</span>
      <span className="ml-2 whitespace-pre-wrap break-words">
        {status.text}
      </span>
      <span className="ml-2 text-2xs">{message.time}</span>
    </div>
  );
}

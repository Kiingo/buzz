import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { TimelineMessage } from "@/features/messages/types";
import { useIdentityQuery } from "@/shared/api/hooks";
import { Button } from "@/shared/ui/button";

import { actionRefTag, parseActions, type AgentAction } from "../lib/markers";
import {
  areActionsUsed,
  getAgentDmStateVersion,
  markActionsUsed,
  subscribeAgentDmState,
} from "../lib/registry";
import { sendAgentDmTaggedMessage } from "../lib/send";

/** Primary buttons lead; otherwise the agent's order is kept. */
export function orderActions(actions: readonly AgentAction[]) {
  return [
    ...actions.filter((action) => action.primary),
    ...actions.filter((action) => !action.primary),
  ];
}

/**
 * Up to three agent action buttons (for example Retry after a visible
 * failure). A tap sends the button's text with its `buzz-action-ref`; after a
 * successful send every button on the message is disabled.
 */
export function AgentActionButtons({
  channelId,
  message,
}: {
  channelId: string;
  message: TimelineMessage;
}) {
  const actions = React.useMemo(
    () => orderActions(parseActions(message.tags)),
    [message.tags],
  );
  const queryClient = useQueryClient();
  const senderPubkey = useIdentityQuery().data?.pubkey;
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  React.useSyncExternalStore(
    subscribeAgentDmState,
    getAgentDmStateVersion,
    getAgentDmStateVersion,
  );
  if (actions.length === 0) return null;
  const used = areActionsUsed(message.id);

  const onTap = async (action: AgentAction) => {
    if (used || pendingId !== null) return;
    setPendingId(action.actionId);
    try {
      await sendAgentDmTaggedMessage({
        queryClient,
        channelId,
        senderPubkey,
        content: action.sendText,
        markerTags: [actionRefTag(action)],
      });
      markActionsUsed(message.id);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to send that action.",
      );
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div
      className="mt-2 flex flex-wrap gap-1.5"
      data-actions-used={used ? "true" : undefined}
      data-testid="agent-action-buttons"
    >
      {actions.map((action) => (
        <Button
          data-action-id={action.actionId}
          disabled={used || pendingId !== null}
          key={action.actionId}
          onClick={() => void onTap(action)}
          size="sm"
          type="button"
          variant={action.primary ? "default" : "outline"}
        >
          {pendingId === action.actionId ? "Sending…" : action.label}
        </Button>
      ))}
    </div>
  );
}

import * as React from "react";
import { Square } from "lucide-react";
import { toast } from "sonner";

import type { Channel } from "@/shared/api/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";

import { cancelAllDelegations } from "../lib/delegationStore";
import { headerText } from "../lib/delegations";
import { useAgentDelegations } from "./useAgentDelegations";

/**
 * The DM header's delegation line, "3 running · 1 needs you · $4.10 today",
 * with Stop all (§10.1). Only the agent's owner sees it, only in their 1:1
 * DM, and only while something is running.
 */
export function AgentDelegationHeader({
  channel,
  currentPubkey,
}: {
  channel: Channel | null;
  currentPubkey?: string;
}) {
  const { agentPubkey, board } = useAgentDelegations(channel, currentPubkey);
  const [confirming, setConfirming] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  if (board.status !== "ready" || !agentPubkey) return null;
  const text = headerText(board.page.summary);
  if (!text) return null;
  const needsYou = board.page.summary.needsYouCount > 0;

  const stopAll = async () => {
    setStopping(true);
    try {
      const stopped = await cancelAllDelegations(agentPubkey);
      toast.success(
        stopped === 1 ? "Stopped 1 worker." : `Stopped ${stopped} workers.`,
      );
    } catch {
      toast.error("Couldn’t stop the workers. Try again.");
    } finally {
      setStopping(false);
    }
  };

  return (
    <div
      className="flex items-center gap-1"
      data-testid="agent-delegation-header"
    >
      <span
        aria-live="polite"
        className={
          needsYou
            ? "rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
            : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
        }
        title={board.stale ? "Reconnecting…" : undefined}
      >
        {text}
      </span>
      {board.page.summary.canStopAll ? (
        <Button
          aria-label="Stop all workers"
          disabled={stopping}
          onClick={() => setConfirming(true)}
          size="sm"
          title="Stop all workers"
          type="button"
          variant="ghost"
        >
          <Square aria-hidden className="h-3.5 w-3.5" />
          Stop all
        </Button>
      ) : null}
      <AlertDialog onOpenChange={setConfirming} open={confirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop all workers?</AlertDialogTitle>
            <AlertDialogDescription>
              Every worker {board.page.agentName || "this agent"} started stops
              its current turn. Their sessions are kept, so the work can be
              picked up again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void stopAll()}>
              Stop all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

import * as React from "react";
import { Square } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";

import { delegationDmAgent } from "../lib/delegations";
import {
  getSessionSetup,
  getSessionSetupVersion,
  stopAgentDmTurn,
  subscribeSessionSetup,
} from "../lib/sessionSetup";
import {
  getSessionBuiltins,
  getSessionViewsVersion,
  interruptSession,
  sessionViewErrorSentence,
  subscribeSessionViews,
} from "../lib/sessionViews";

/**
 * Stop beside "is typing…" in the reader's 1:1 DM with a hosted agent, while
 * that agent is working. It stops the turn, not the conversation or session.
 * An agent this device runs has no host, and its own Stop is in its session
 * panel. On a session that runs in a pane, Interrupt is beside it: Esc, the
 * running step stops and the session keeps going.
 */
export function AgentDmStopButton({
  channel,
  currentPubkey,
  workingPubkeys,
}: {
  channel: Parameters<typeof delegationDmAgent>[0];
  currentPubkey: string | null | undefined;
  workingPubkeys: readonly string[];
}) {
  React.useSyncExternalStore(
    subscribeSessionSetup,
    getSessionSetupVersion,
    getSessionSetupVersion,
  );
  React.useSyncExternalStore(
    subscribeSessionViews,
    getSessionViewsVersion,
    getSessionViewsVersion,
  );
  const [stopping, setStopping] = React.useState(false);
  const [interrupting, setInterrupting] = React.useState(false);
  const agent = delegationDmAgent(channel, currentPubkey);
  const working =
    agent !== null &&
    workingPubkeys.some((pubkey) => pubkey.toLowerCase() === agent);
  if (!agent || !working || !getSessionSetup(agent)) return null;

  const stop = async () => {
    setStopping(true);
    try {
      const outcome = await stopAgentDmTurn(agent);
      if (outcome === "not_running") {
        toast.info("Nothing is running to stop.");
      } else {
        toast.success(outcome === "stopping" ? "Stopping…" : "Stopped.");
      }
    } catch {
      toast.error("Couldn't stop the agent. Try again.");
    } finally {
      setStopping(false);
    }
  };

  const interrupt = async () => {
    setInterrupting(true);
    try {
      toast.success(await interruptSession(agent));
    } catch (error) {
      toast.error(sessionViewErrorSentence(error));
    } finally {
      setInterrupting(false);
    }
  };
  const inPane = getSessionBuiltins(agent)?.lane === "tmux";

  return (
    <>
      {inPane ? (
        <Button
          aria-label="Interrupt the session"
          className="shrink-0"
          data-testid="agent-dm-interrupt"
          disabled={interrupting}
          onClick={() => void interrupt()}
          size="xs"
          title="Interrupt: stop the running step, keep the session"
          type="button"
          variant="ghost"
        >
          Interrupt
        </Button>
      ) : null}
      <Button
        aria-label="Stop the agent"
        className="shrink-0"
        data-testid="agent-dm-stop"
        disabled={stopping}
        onClick={() => void stop()}
        size="xs"
        title="Stop the agent"
        type="button"
        variant="ghost"
      >
        <Square aria-hidden className="h-3 w-3" />
        Stop
      </Button>
    </>
  );
}

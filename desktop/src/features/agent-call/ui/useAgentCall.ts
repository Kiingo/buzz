import * as React from "react";

import {
  type AgentCallState,
  agentCallController,
} from "../lib/agentCallController";

/** The app's one agent call, as React state. */
export function useAgentCall(): AgentCallState {
  return React.useSyncExternalStore(
    agentCallController.subscribe,
    agentCallController.getState,
    agentCallController.getState,
  );
}

/** Seconds since `since` (epoch ms), ticking once a second while set. */
export function useElapsedSeconds(since: number | null): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1_000));
}

export function formatCallDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

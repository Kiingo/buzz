import * as React from "react";

import { Badge } from "@/shared/ui/badge";
import type { ManagedAgent, PresenceStatus } from "@/shared/api/types";

/** Grace period after mount before treating "running + no presence" as "Starting…" */
const PRESENCE_GRACE_MS = 15_000;

export function AgentStatusBadge({
  isWorking,
  presenceLoaded,
  presenceStatus,
  providerLifecycleState,
  status,
}: {
  isWorking?: boolean;
  presenceLoaded: boolean;
  presenceStatus: PresenceStatus | undefined;
  providerLifecycleState?: ManagedAgent["providerLifecycleState"];
  status: ManagedAgent["status"];
}) {
  const [inGracePeriod, setInGracePeriod] = React.useState(true);

  React.useEffect(() => {
    const timer = setTimeout(() => setInGracePeriod(false), PRESENCE_GRACE_MS);
    return () => clearTimeout(timer);
  }, []);

  const isActive = status === "running" || status === "deployed";
  const isStarting =
    !inGracePeriod &&
    presenceLoaded &&
    status === "running" &&
    (!presenceStatus || presenceStatus === "offline");

  const providerObservedState = providerLifecycleState?.observed_state;
  const providerNeedsAttention =
    providerObservedState === "action_required" ||
    providerObservedState === "degraded";
  const variant: "default" | "warning" | "secondary" = isWorking
    ? "default"
    : providerNeedsAttention
      ? "warning"
      : isStarting
        ? "warning"
        : isActive
          ? "default"
          : "secondary";

  const label = isWorking
    ? "Working"
    : providerObservedState
      ? providerObservedState.replace(/_/g, " ")
      : isStarting
        ? "Starting\u2026"
        : status.replace(/_/g, " ");

  return (
    <Badge
      className={isWorking ? "motion-safe:animate-pulse" : undefined}
      variant={variant}
    >
      {label}
    </Badge>
  );
}

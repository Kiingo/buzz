import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { useIdentityQuery } from "@/shared/api/hooks";

import { attachChoices, currentAttachChoice } from "../lib/attach";
import { relinkQueryKeys } from "../lib/autoLink";
import { hostedOwnerRelinkApi } from "../lib/client";

/**
 * "Use an existing agent" for the hosted create form: lists the owner's
 * agents that have no Buzz identity yet, so the new identity attaches to one
 * instead of the provider creating a new agent. Shows nothing when this
 * build can't reach the hosted provider or the owner has no such agents
 * (the usual case). The default is always a new agent.
 */
export function HostedAttachAgentPicker({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean;
  onChange: (kiingoAgentId: string | null) => void;
  value: string | null | undefined;
}) {
  const identity = useIdentityQuery();
  const owner = identity.data?.pubkey?.toLowerCase() ?? null;
  const available = useQuery({
    queryKey: relinkQueryKeys.available,
    queryFn: () => hostedOwnerRelinkApi.available(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    enabled: owner !== null,
  });
  const unlinked = useQuery({
    queryKey: [...relinkQueryKeys.unlinked, owner],
    queryFn: () => hostedOwnerRelinkApi.listUnlinked(),
    enabled: owner !== null && available.data === true,
    retry: false,
    staleTime: 30_000,
  });
  const choices = React.useMemo(
    () => attachChoices(unlinked.data ?? []),
    [unlinked.data],
  );
  const selected = currentAttachChoice(value, choices);

  // A choice that is no longer on offer (attached elsewhere meanwhile, or
  // the list failed) falls back to creating a new agent.
  const clearStale = React.useEffectEvent(() => onChange(null));
  React.useEffect(() => {
    if (value && selected === null && !unlinked.isFetching) clearStale();
  }, [value, selected, unlinked.isFetching]);

  if (available.data !== true) return null;
  if (unlinked.isError) {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid="hosted-attach-unavailable"
      >
        Couldn&apos;t load your existing agents, so this creates a new one.{" "}
        <button
          className="underline underline-offset-2 disabled:opacity-60"
          disabled={disabled || unlinked.isFetching}
          onClick={() => void unlinked.refetch()}
          type="button"
        >
          Try again
        </button>
      </p>
    );
  }
  if (choices.length === 0) return null;

  return (
    <div className="space-y-1.5" data-testid="hosted-attach-picker">
      <label className="text-sm font-medium" htmlFor="hosted-attach-agent">
        Agent
      </label>
      <select
        aria-describedby="hosted-attach-agent-note"
        className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
        disabled={disabled}
        id="hosted-attach-agent"
        onChange={(event) => onChange(event.target.value || null)}
        value={selected ?? ""}
      >
        <option value="">Create a new agent</option>
        {choices.map((agent) => (
          <option key={agent.kiingoAgentId} value={agent.kiingoAgentId}>
            {agent.ownerPrincipalType === "Organization"
              ? `${agent.displayName} (organization)`
              : agent.displayName}
          </option>
        ))}
      </select>
      <p
        className="text-xs text-muted-foreground"
        id="hosted-attach-agent-note"
      >
        {selected
          ? "Brings this agent to Buzz. It keeps its own name, instructions and settings."
          : "Or bring one of your agents that isn't on Buzz yet."}
      </p>
    </div>
  );
}

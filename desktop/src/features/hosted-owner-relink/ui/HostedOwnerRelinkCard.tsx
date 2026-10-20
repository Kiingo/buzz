import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, ShieldAlert } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { hostedOwnerRelinkApi } from "../lib/client";
import {
  agentsToSend,
  currentAgents,
  describeOutcome,
  isRetryable,
  MAX_REBIND_AGENTS,
  mergeResults,
  selectableAgents,
  staleAgents,
  toRelinkRequestError,
  type HostedOwnerAgent,
  type RebindResult,
} from "../lib/relink";

const availableQueryKey = ["hosted-owner-relink", "available"] as const;
const agentsQueryKey = ["hosted-owner-relink", "agents"] as const;

/**
 * Profile settings: offers to re-link hosted agents that are still linked to
 * an earlier owner key. Nothing is signed until the owner confirms in the
 * review dialog, and only for the agents they left selected.
 */
export function HostedOwnerRelinkCard() {
  const available = useQuery({
    queryKey: availableQueryKey,
    queryFn: () => hostedOwnerRelinkApi.available(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  if (!available.data) return null;
  return <RelinkSection />;
}

function RelinkSection() {
  const [open, setOpen] = React.useState(false);
  // A new review per opening: the dialog remounts and snapshots the list.
  const [review, setReview] = React.useState(0);
  const agents = useQuery({
    queryKey: agentsQueryKey,
    queryFn: () => hostedOwnerRelinkApi.list(),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const view = agents.data;
  // A failed refresh keeps the last list (and an open review) on screen.
  if (!view && agents.isError) {
    return (
      <section className="mt-8 min-w-0" data-testid="settings-hosted-relink">
        <p className="text-sm text-muted-foreground">
          {toRelinkRequestError(agents.error).message}
        </p>
        <Button
          className="mt-2"
          onClick={() => void agents.refetch()}
          size="sm"
          type="button"
          variant="outline"
        >
          Check hosted agents again
        </Button>
      </section>
    );
  }
  if (!view) return null;
  const stale = staleAgents(view);
  if (stale.length === 0 && !open) return null;

  return (
    <section className="mt-8 min-w-0" data-testid="settings-hosted-relink">
      {stale.length > 0 ? (
        <div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="flex items-start gap-2 text-sm">
            <KeyRound aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <span className="font-medium text-foreground">
                Re-link your agents to your current key.
              </span>{" "}
              {stale.length === 1
                ? `${stale[0]?.displayName} is still linked to your old key.`
                : `${stale.length} agents are still linked to your old key.`}
            </span>
          </p>
          <Button
            data-testid="hosted-relink-open"
            onClick={() => {
              setReview((value) => value + 1);
              setOpen(true);
            }}
            size="sm"
            type="button"
          >
            Re-link agents…
          </Button>
        </div>
      ) : null}
      <RelinkDialog
        current={currentAgents(view)}
        key={review}
        onOpenChange={setOpen}
        open={open}
        stale={stale}
      />
    </section>
  );
}

function RelinkDialog({
  open,
  onOpenChange,
  stale,
  current,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stale: HostedOwnerAgent[];
  current: HostedOwnerAgent[];
}) {
  const queryClient = useQueryClient();
  // Snapshot the agents for this review so a refreshed list does not change
  // what the owner is looking at; every agent starts selected.
  const [reviewed] = React.useState(stale);
  const [alreadyLinked] = React.useState(current);
  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(stale.map((agent) => agent.providerAgentId)),
  );
  const [results, setResults] = React.useState<Record<string, RebindResult>>(
    {},
  );
  const [busy, setBusy] = React.useState(false);
  const [requestError, setRequestError] = React.useState<string | null>(null);

  const sendable = agentsToSend(reviewed, selected, results);
  const isRetry = Object.keys(results).length > 0;
  const finished = isRetry && selectableAgents(reviewed, results).length === 0;
  const tooMany = sendable.length > MAX_REBIND_AGENTS;
  const canSend = !busy && sendable.length > 0 && !tooMany;

  const toggle = (agent: HostedOwnerAgent, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(agent.providerAgentId);
      else next.delete(agent.providerAgentId);
      return next;
    });
  };

  const confirm = async () => {
    if (!canSend) return;
    setBusy(true);
    setRequestError(null);
    try {
      const next = await hostedOwnerRelinkApi.rebind(sendable);
      setResults((previous) => mergeResults(previous, next));
      void queryClient.invalidateQueries({ queryKey: agentsQueryKey });
    } catch (error) {
      setRequestError(toRelinkRequestError(error).message);
    } finally {
      setBusy(false);
    }
  };

  const count = sendable.length;
  const actionLabel = busy
    ? "Re-linking…"
    : tooMany
      ? `Choose ${MAX_REBIND_AGENTS} or fewer`
      : isRetry
        ? `Retry ${count} ${count === 1 ? "agent" : "agents"}`
        : `Re-link ${count} ${count === 1 ? "agent" : "agents"}`;

  return (
    <Dialog onOpenChange={(next) => !busy && onOpenChange(next)} open={open}>
      <DialogContent data-testid="hosted-relink-dialog">
        <DialogHeader>
          <DialogTitle>Re-link agents</DialogTitle>
          <DialogDescription>
            Buzz signs one approval with the key you use now for each agent you
            choose, so it answers to you again; nothing else changes.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="space-y-2" disabled={busy}>
          <legend className="mb-1 text-xs font-medium text-muted-foreground">
            Linked to your old key
          </legend>
          {reviewed.map((agent) => {
            const result = results[agent.providerAgentId];
            const choosable = result === undefined || isRetryable(result);
            const id = `hosted-relink-${agent.providerAgentId}`;
            const failed = result?.outcome === "rejected";
            return (
              <div
                className="flex items-start gap-2 text-sm"
                data-testid={id}
                key={agent.providerAgentId}
              >
                {choosable ? (
                  <Checkbox
                    aria-describedby={result ? `${id}-result` : undefined}
                    checked={selected.has(agent.providerAgentId)}
                    className="mt-0.5"
                    id={id}
                    onCheckedChange={(checked) =>
                      toggle(agent, checked === true)
                    }
                  />
                ) : failed ? (
                  <ShieldAlert
                    aria-hidden
                    className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
                  />
                ) : (
                  <CheckCircle2
                    aria-hidden
                    className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500"
                  />
                )}
                <div className="min-w-0">
                  <label
                    className="text-foreground"
                    htmlFor={choosable ? id : undefined}
                  >
                    {agent.displayName}
                  </label>
                  {result ? (
                    <p
                      className={
                        failed
                          ? "text-xs text-destructive"
                          : "text-xs text-muted-foreground"
                      }
                      id={`${id}-result`}
                    >
                      {describeOutcome(result)}
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </fieldset>

        {alreadyLinked.length > 0 ? (
          <div className="space-y-1 text-sm">
            <p className="text-xs font-medium text-muted-foreground">
              Already linked
            </p>
            {alreadyLinked.map((agent) => (
              <p
                className="flex items-center gap-2"
                key={agent.providerAgentId}
              >
                <CheckCircle2
                  aria-hidden
                  className="h-4 w-4 shrink-0 text-emerald-500"
                />
                <span>{agent.displayName}</span>
              </p>
            ))}
          </div>
        ) : null}

        {requestError ? (
          <p className="text-sm text-destructive" role="alert">
            {requestError}
          </p>
        ) : null}

        <DialogFooter>
          {finished ? (
            <Button onClick={() => onOpenChange(false)} type="button">
              Done
            </Button>
          ) : (
            <>
              <Button
                disabled={busy}
                onClick={() => onOpenChange(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                data-testid="hosted-relink-confirm"
                disabled={!canSend}
                onClick={() => void confirm()}
                type="button"
              >
                {actionLabel}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

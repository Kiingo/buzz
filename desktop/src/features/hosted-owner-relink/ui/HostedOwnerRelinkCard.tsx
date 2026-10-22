import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Link2, ShieldAlert } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Switch } from "@/shared/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { relinkQueryKeys, writeAutoLinkSetting } from "../lib/autoLink";
import { hostedOwnerRelinkApi } from "../lib/client";
import {
  agentsToSend,
  currentAgents,
  describeAttestOutcome,
  describeOutcome,
  isAttested,
  isRetryable,
  isRetryableAttest,
  MAX_REBIND_AGENTS,
  mergeResults,
  pendingAgents,
  selectableAgents,
  staleAgents,
  toRelinkRequestError,
  type HostedOwnerAgent,
  type HostedOwnerAgents,
  type RebindResult,
} from "../lib/relink";
import { useAutoLinkSetting } from "./HostedAutoLinkExtension";

const availableQueryKey = relinkQueryKeys.available;
const agentsQueryKey = relinkQueryKeys.agents;

/**
 * Profile settings: the "Auto-link my new agents" setting, a Link button for
 * each agent waiting for its owner and each agent still linked to an earlier
 * owner key, and the batch re-link review. A Link tap signs for that one
 * agent; the review signs only for the agents the owner left selected; the
 * setting signs in the background only while it is on.
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
  const pending = pendingAgents(view);

  return (
    <section className="mt-8 min-w-0" data-testid="settings-hosted-relink">
      <AutoLinkSetting owner={view.currentOwnerPublicKey} />
      {pending.length > 0 ? (
        <LinkList
          agents={pending}
          kind="attest"
          testId="hosted-link-pending"
          title={
            pending.length === 1
              ? `${pending[0]?.displayName} is waiting for you to link it.`
              : `${pending.length} agents are waiting for you to link them.`
          }
          view={view}
        />
      ) : null}
      {stale.length > 0 ? (
        <div className="mt-3 space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
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
          <LinkList
            agents={stale}
            kind="rebind"
            testId="hosted-link-stale"
            view={view}
          />
          {stale.length > 1 ? (
            <Button
              data-testid="hosted-relink-open"
              onClick={() => {
                setReview((value) => value + 1);
                setOpen(true);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              Review and re-link all…
            </Button>
          ) : null}
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

/** The owner's "Auto-link my new agents" switch for the signed-in key. */
function AutoLinkSetting({ owner }: { owner: string }) {
  const enabled = useAutoLinkSetting(owner);
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="hosted-auto-link-switch"
        >
          Auto-link my new agents
        </label>
        <p className="text-sm text-muted-foreground" id="hosted-auto-link-copy">
          While Buzz is open, it signs for agents you own as they are created
          and re-links agents still on an old key, then tells you which ones it
          linked.
        </p>
      </div>
      <Switch
        aria-describedby="hosted-auto-link-copy"
        checked={enabled}
        data-testid="hosted-auto-link-toggle"
        id="hosted-auto-link-switch"
        onCheckedChange={(checked) => writeAutoLinkSetting(owner, checked)}
      />
    </div>
  );
}

type LinkState = {
  busy: boolean;
  label?: string;
  failed?: boolean;
  done?: boolean;
};

/**
 * One row per agent with its own Link button. A tap signs for that agent
 * only: one new request and proof, attest-pending for a waiting agent or
 * re-link for one on an old key.
 */
function LinkList({
  agents,
  kind,
  title,
  testId,
  view,
}: {
  agents: HostedOwnerAgent[];
  kind: "attest" | "rebind";
  title?: string;
  testId: string;
  view: HostedOwnerAgents;
}) {
  const queryClient = useQueryClient();
  const [states, setStates] = React.useState<Record<string, LinkState>>({});
  const owner = view.currentOwnerPublicKey;

  const link = async (agent: HostedOwnerAgent) => {
    const id = agent.providerAgentId;
    if (states[id]?.busy || states[id]?.done) return;
    setStates((previous) => ({ ...previous, [id]: { busy: true } }));
    let next: LinkState;
    try {
      if (kind === "attest") {
        const [result] = await hostedOwnerRelinkApi.attestPending([agent]);
        const linked = isAttested(result);
        next = {
          busy: false,
          done: linked || (result !== undefined && !isRetryableAttest(result)),
          failed: !linked,
          label: result ? describeAttestOutcome(result) : undefined,
        };
      } else {
        const [result] = await hostedOwnerRelinkApi.rebind([agent]);
        const linked =
          result?.outcome === "rebound" ||
          result?.outcome === "already_current";
        next = {
          busy: false,
          done: linked || (result !== undefined && !isRetryable(result)),
          failed: !linked,
          label: result ? describeOutcome(result) : undefined,
        };
      }
    } catch (error) {
      next = {
        busy: false,
        failed: true,
        label: toRelinkRequestError(error).message,
      };
    }
    setStates((previous) => ({ ...previous, [id]: next }));
    void queryClient.invalidateQueries({ queryKey: agentsQueryKey });
  };

  return (
    <div className="mt-3 space-y-2" data-testid={testId}>
      {title ? (
        <p className="flex items-start gap-2 text-sm">
          <Link2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="font-medium text-foreground">{title}</span>
        </p>
      ) : null}
      {agents.map((agent) => {
        const state = states[agent.providerAgentId];
        const rowId = `${testId}-${agent.providerAgentId}`;
        return (
          <div
            className="flex items-start justify-between gap-3 text-sm"
            data-testid={rowId}
            key={`${owner}:${agent.providerAgentId}`}
          >
            <div className="min-w-0">
              <p className="text-foreground">{agent.displayName}</p>
              {state?.label ? (
                <p
                  className={
                    state.failed
                      ? "text-xs text-destructive"
                      : "text-xs text-muted-foreground"
                  }
                  id={`${rowId}-result`}
                  role="status"
                >
                  {state.label}
                </p>
              ) : null}
            </div>
            {state?.done && !state.failed ? (
              <CheckCircle2
                aria-hidden
                className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500"
              />
            ) : state?.done ? (
              <ShieldAlert
                aria-hidden
                className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
              />
            ) : (
              <Button
                aria-describedby={state?.label ? `${rowId}-result` : undefined}
                aria-label={`Link ${agent.displayName}`}
                data-testid={`${rowId}-link`}
                disabled={state?.busy === true}
                onClick={() => void link(agent)}
                size="sm"
                type="button"
                variant="outline"
              >
                {state?.busy ? "Linking…" : state?.failed ? "Retry" : "Link"}
              </Button>
            )}
          </div>
        );
      })}
    </div>
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

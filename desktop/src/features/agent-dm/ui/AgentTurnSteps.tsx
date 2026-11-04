import { ChevronDown, ChevronUp } from "lucide-react";
import * as React from "react";

import { useChannelsQuery } from "@/features/channels/hooks";
import type { TimelineMessage } from "@/features/messages/types";
import { useIdentityQuery } from "@/shared/api/hooks";
import { normalizePubkey } from "@/shared/lib/pubkey";

import { delegationDmAgent } from "../lib/delegations";
import {
  getSessionSetup,
  getSessionSetupVersion,
  subscribeSessionSetup,
} from "../lib/sessionSetup";
import {
  ensureReplyTurn,
  getReplyTurn,
  getTurnSteps,
  getTurnStepsVersion,
  loadTurnSteps,
  type ReplyKey,
  STEPS_READ_FAILED,
  stepsDuration,
  subscribeTurnSteps,
  type TurnStep,
} from "../lib/turnSteps";

const STATE_LABEL: Record<TurnStep["state"], string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
};

/**
 * The quiet line under the hosted agent's reply in the reader's own 1:1 DM
 * ("Used 6 tools · 41 s", else "Steps"). It opens in place to the turn's
 * steps, read only. Every step's words are the agent's or a tool's:
 * untrusted, shown as plain text.
 */
export function AgentTurnSteps({
  channelId,
  message,
  replyKey: key,
}: {
  channelId: string;
  message: TimelineMessage;
  replyKey: ReplyKey;
}) {
  const viewerPubkey = useIdentityQuery().data?.pubkey;
  const channel =
    useChannelsQuery().data?.find((candidate) => candidate.id === channelId) ??
    null;
  React.useSyncExternalStore(
    subscribeSessionSetup,
    getSessionSetupVersion,
    getSessionSetupVersion,
  );
  React.useSyncExternalStore(
    subscribeTurnSteps,
    getTurnStepsVersion,
    getTurnStepsVersion,
  );
  const agent = delegationDmAgent(channel, viewerPubkey);
  const signer = normalizePubkey(message.signerPubkey ?? "");
  // Only the reader's own hosted agent's replies: the host answers no one
  // else, and an agent this device runs has no host.
  const hosted =
    agent !== null && signer === agent && getSessionSetup(agent) !== null;
  React.useEffect(() => {
    if (hosted && agent) void ensureReplyTurn(agent, key);
  }, [agent, hosted, key]);
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const panelId = React.useId();

  const turn = hosted && agent ? getReplyTurn(agent, key) : null;
  if (!agent || !turn) return null;
  const steps = getTurnSteps(turn.turnId);

  const load = async () => {
    setLoading(true);
    setFailed(false);
    try {
      await loadTurnSteps(agent, turn.turnId);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void load();
  };

  return (
    <div className="mt-1 text-2xs text-muted-foreground">
      <button
        aria-controls={panelId}
        aria-expanded={open}
        className="inline-flex max-w-full items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        data-testid="agent-turn-steps-line"
        onClick={toggle}
        title={
          open ? "Hide how this reply was made" : "Show how this reply was made"
        }
        type="button"
      >
        <span className="truncate">{turn.line}</span>
        {open ? (
          <ChevronUp aria-hidden="true" className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0" />
        )}
      </button>
      {open ? (
        <div
          className="mt-1 flex flex-col gap-1 border-l border-border pl-2"
          data-testid="agent-turn-steps"
          id={panelId}
        >
          {failed ? (
            <div className="flex items-center gap-2" role="alert">
              <span>{STEPS_READ_FAILED}</span>
              <button
                className="underline hover:text-foreground"
                onClick={() => void load()}
                type="button"
              >
                Try again
              </button>
            </div>
          ) : null}
          {steps ? (
            <>
              {steps.omitted > 0 ? (
                <span>
                  {steps.omitted === 1
                    ? "1 earlier step not shown"
                    : `${steps.omitted} earlier steps not shown`}
                </span>
              ) : null}
              {steps.items.length === 0 ? (
                <span>No steps for this reply.</span>
              ) : (
                <ol className="flex flex-col gap-0.5">
                  {steps.items.map((step) => (
                    <TurnStepRow key={step.id} step={step} />
                  ))}
                </ol>
              )}
              {steps.durationMs !== null && steps.state !== "running" ? (
                <span>{`Took ${stepsDuration(steps.durationMs)}`}</span>
              ) : null}
            </>
          ) : loading ? (
            <span aria-live="polite">Loading steps…</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TurnStepRow({ step }: { step: TurnStep }) {
  const [open, setOpen] = React.useState(false);
  const detailId = React.useId();
  const detail = [step.text, step.args, step.result].some(Boolean);
  const label = step.action ? `${step.action} · ${step.line}` : step.line;
  return (
    <li className="flex flex-col" data-testid="agent-turn-step">
      <div className="flex items-center gap-1.5">
        <span
          className={step.state === "failed" ? "text-destructive" : undefined}
        >
          {STATE_LABEL[step.state]}
        </span>
        {detail ? (
          <button
            aria-controls={detailId}
            aria-expanded={open}
            className="min-w-0 truncate text-left hover:text-foreground"
            onClick={() => setOpen(!open)}
            type="button"
          >
            {label}
          </button>
        ) : (
          <span className="min-w-0 truncate">{label}</span>
        )}
        {step.link ? (
          <a
            className="shrink-0 underline hover:text-foreground"
            href={step.link.url}
            rel="noreferrer noopener"
            target="_blank"
          >
            {step.link.title ?? "Open"}
          </a>
        ) : null}
      </div>
      {open && detail ? (
        <div className="mt-0.5 flex flex-col gap-1" id={detailId}>
          {[
            ["Note", step.text],
            ["Input", step.args],
            ["Result", step.result],
          ].map(([name, value]) =>
            value ? (
              <div key={name}>
                <div className="font-medium">{name}</div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-muted p-1 font-mono">
                  {value}
                </pre>
              </div>
            ) : null,
          )}
        </div>
      ) : null}
    </li>
  );
}

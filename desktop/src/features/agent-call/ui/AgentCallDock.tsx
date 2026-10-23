import { openUrl } from "@tauri-apps/plugin-opener";
import { Archive, Mic, MicOff, Phone, PhoneOff, Square, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";

import {
  answerAgentCallQuestion,
  cancelAgentCallAsk,
  describeAgentCallError,
  setAgentCallAskState,
} from "../lib/agentCallApi";
import {
  type AgentCallState,
  agentCallController,
} from "../lib/agentCallController";
import {
  type AgentCallAsk,
  type AgentCallFeed,
  askKeyOf,
  askNowLine,
  askStatusLabel,
  askTitle,
  isAskTerminal,
  openHumanAsk,
  safeHttpsUrl,
  visibleAsks,
} from "../lib/agentCallFeed";
import {
  formatCallDuration,
  useAgentCall,
  useElapsedSeconds,
} from "./useAgentCall";

/**
 * The in-call screen of a 1:1 agent call, docked bottom-right over the app
 * so the call survives changing channel: who, how long, mute, stop the
 * agent's work, hang up, and the host's feed of the call's asks (working,
 * done, the open question with its options) and, after hang-up, the recap.
 */
export function AgentCallDock() {
  const call = useAgentCall();

  React.useEffect(() => {
    const onUnload = () => agentCallController.hangUpOnUnload();
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);

  if (call.phase === "idle") return null;
  return (
    <section
      aria-label={`Call with ${call.agentName ?? "agent"}`}
      className="fixed right-4 bottom-4 z-50 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl"
    >
      <CallHeader call={call} />
      {call.phase === "error" ? (
        <p className="px-3 pb-3 text-sm text-muted-foreground" role="alert">
          {call.error?.message ?? "The call couldn't start."}
        </p>
      ) : (
        <CallBody call={call} />
      )}
    </section>
  );
}

function statusLine(call: AgentCallState, elapsed: number): string {
  switch (call.phase) {
    case "requesting_mic":
      return "Waiting for the microphone…";
    case "connecting":
      return "Connecting…";
    case "live":
      return formatCallDuration(elapsed);
    case "ending":
      return "Hanging up…";
    case "ended":
      return call.endReason === "time_limit"
        ? "Call ended (time limit)"
        : call.endReason === "connection_lost"
          ? "Call ended (connection lost)"
          : "Call ended";
    case "error":
      return "Couldn't call";
    default:
      return "";
  }
}

function CallHeader({ call }: { call: AgentCallState }) {
  const elapsed = useElapsedSeconds(
    call.phase === "live" ? call.connectedAt : null,
  );
  const busy =
    call.phase === "requesting_mic" ||
    call.phase === "connecting" ||
    call.phase === "live";
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      <Phone aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">
          {call.agentName ?? "Agent"}
        </p>
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {statusLine(call, elapsed)}
        </p>
      </div>
      {busy ? (
        <>
          <Button
            aria-label={call.muted ? "Unmute" : "Mute"}
            aria-pressed={call.muted}
            disabled={call.phase !== "live"}
            onClick={agentCallController.toggleMute}
            size="icon"
            title={call.muted ? "Unmute" : "Mute"}
            type="button"
            variant={call.muted ? "secondary" : "outline"}
          >
            {call.muted ? <MicOff /> : <Mic />}
          </Button>
          <Button
            aria-label="Hang up"
            onClick={() => void agentCallController.hangUp()}
            size="icon"
            title="Hang up (the agent keeps working)"
            type="button"
            variant="destructive"
          >
            <PhoneOff />
          </Button>
        </>
      ) : call.phase === "ended" || call.phase === "error" ? (
        <Button
          aria-label="Close"
          onClick={agentCallController.dismiss}
          size="icon"
          title="Close"
          type="button"
          variant="ghost"
        >
          <X />
        </Button>
      ) : null}
    </div>
  );
}

function CallBody({ call }: { call: AgentCallState }) {
  const feed = call.feed;
  const { shown, archived } = feed
    ? visibleAsks(feed)
    : { shown: [], archived: [] };
  const question = openHumanAsk(feed);
  const live = call.phase === "live";
  return (
    <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-3 py-2">
      {live ? <StopControl call={call} /> : null}
      {question && feed ? <QuestionCard feed={feed} /> : null}
      {shown.length > 0 ? (
        <ul aria-label="Asks on this call" className="flex flex-col gap-1.5">
          {shown.map((ask) => (
            <AskRow
              ask={ask}
              callId={feed?.callId ?? ""}
              key={askKeyOf(ask)}
              live={live}
              v2={(feed?.contract ?? 1) >= 2}
            />
          ))}
        </ul>
      ) : live ? (
        <p className="text-xs text-muted-foreground">
          Talk to {call.agentName ?? "the agent"}. What you ask shows up here.
        </p>
      ) : null}
      {archived.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Archived ({archived.length})
        </p>
      ) : null}
      {call.phase === "ended" && feed ? <Recap feed={feed} /> : null}
      {feed?.destination?.label ? (
        <p className="text-xs text-muted-foreground">
          Answers go to {feed.destination.label}.
        </p>
      ) : null}
    </div>
  );
}

function StopControl({ call }: { call: AgentCallState }) {
  const stop = call.stop;
  const working = Boolean(
    call.feed?.asks.some((ask) => ask.kind === "ask" && !isAskTerminal(ask)),
  );
  const note =
    stop.status === "stopped"
      ? "Stopped."
      : stop.status === "nothing_to_stop"
        ? "Nothing to stop."
        : stop.status === "failed"
          ? stop.message
          : null;
  if (!working && !note) return null;
  return (
    <div className="flex items-center gap-2">
      {working ? (
        <Button
          disabled={stop.status === "stopping"}
          onClick={() => void agentCallController.stopAgentWork()}
          size="xs"
          type="button"
          variant="outline"
        >
          <Square />
          {stop.status === "stopping" ? "Stopping…" : "Stop the agent"}
        </Button>
      ) : null}
      {note ? (
        <span aria-live="polite" className="text-xs text-muted-foreground">
          {note}
        </span>
      ) : null}
    </div>
  );
}

function QuestionCard({ feed }: { feed: AgentCallFeed }) {
  const ask = openHumanAsk(feed);
  const [sending, setSending] = React.useState<string | null>(null);
  if (!ask) return null;
  return (
    <section
      aria-label="The agent is asking"
      className="rounded-lg border border-border bg-muted/40 p-2"
    >
      {ask.questions.map((question) => (
        <div className="flex flex-col gap-1.5" key={question.id}>
          <p className="text-sm">{question.question}</p>
          <div className="flex flex-wrap gap-1">
            {question.options.map((option) => {
              const id = `${question.id}:${option.index}`;
              return (
                <Button
                  disabled={sending !== null}
                  key={id}
                  onClick={() => {
                    setSending(id);
                    void answerAgentCallQuestion({
                      callId: feed.callId,
                      humanAskId: ask.humanAskId,
                      questionId: question.id,
                      optionIndex: option.index,
                    })
                      .catch((error: unknown) => {
                        toast.error(describeAgentCallError(error));
                      })
                      .finally(() => setSending(null));
                  }}
                  size="xs"
                  type="button"
                  variant="secondary"
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

function AskRow({
  ask,
  callId,
  live,
  v2,
}: {
  ask: AgentCallAsk;
  callId: string;
  live: boolean;
  /** Per-ask controls (cancel, archive) are feed v2 routes. */
  v2: boolean;
}) {
  const key = askKeyOf(ask);
  const nowLine = askNowLine(ask);
  const resultText = ask.result?.text?.trim() ?? "";
  const canCancel =
    v2 &&
    live &&
    !ask.cancelledAt &&
    (ask.actions?.cancel ?? !isAskTerminal(ask));
  const run = (action: () => Promise<unknown>) => {
    void action().catch((error: unknown) => {
      toast.error(describeAgentCallError(error));
    });
  };
  return (
    <li className="rounded-lg border border-border px-2 py-1.5">
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{askTitle(ask)}</p>
          <p className="text-xs text-muted-foreground">
            {askStatusLabel(ask)}
            {nowLine ? ` · ${nowLine}` : ""}
          </p>
        </div>
        {canCancel ? (
          <Button
            aria-label="Cancel this ask"
            onClick={() => run(() => cancelAgentCallAsk(callId, key))}
            size="icon-xs"
            title="Cancel this ask"
            type="button"
            variant="ghost"
          >
            <X />
          </Button>
        ) : null}
        {v2 ? (
          <Button
            aria-label="Archive"
            onClick={() =>
              run(() => setAgentCallAskState(callId, key, "archive"))
            }
            size="icon-xs"
            title="Archive (the work goes on)"
            type="button"
            variant="ghost"
          >
            <Archive />
          </Button>
        ) : null}
      </div>
      {resultText ? (
        <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-xs">
          {resultText}
        </p>
      ) : ask.status === "not_answered" || ask.status === "failed" ? (
        ask.statusReason ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {ask.statusReason}
          </p>
        ) : null
      ) : null}
      <LinkList
        links={ask.links.map((link) => ({
          label: link.title ?? link.url,
          url: link.url,
        }))}
      />
    </li>
  );
}

function Recap({ feed }: { feed: AgentCallFeed }) {
  const recap = feed.recap;
  if (feed.contract === undefined || feed.contract < 2) return null;
  if (!recap || recap.summary === null) {
    return (
      <p aria-live="polite" className="text-xs text-muted-foreground">
        Writing the recap…
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-semibold">Recap</p>
      <p className="whitespace-pre-wrap text-xs">{recap.summary}</p>
      <LinkList links={recap.links ?? []} />
    </div>
  );
}

/** The link's host, shown beside its label so a label can't disguise it. */
function linkHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function LinkList({ links }: { links: { label: string; url: string }[] }) {
  const safe = links
    .map((link) => ({ label: link.label, url: safeHttpsUrl(link.url) }))
    .filter((link): link is { label: string; url: string } => !!link.url);
  if (safe.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-col gap-0.5">
      {safe.slice(0, 10).map((link) => (
        <li key={link.url}>
          <button
            className="truncate text-left text-xs text-primary underline-offset-2 hover:underline"
            onClick={() => {
              void openUrl(link.url).catch(() => {
                toast.error("Failed to open link");
              });
            }}
            title={link.url}
            type="button"
          >
            {link.label}{" "}
            <span className="text-muted-foreground">
              ({linkHost(link.url)})
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

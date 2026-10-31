import * as React from "react";
import { toast } from "sonner";

import { getAgentCallStreamHost } from "@/features/agent-call/lib/agentCallApi";
import type { Channel } from "@/shared/api/types";

import {
  answerDelegationAsk,
  cancelDelegation,
  markDelegationsSeen,
  undoStopDelegation,
} from "../lib/delegationStore";
import {
  type DelegationCard,
  appOriginFor,
  askAsQuestion,
  delegationBoard,
  fromWorkerLabel,
  undoableCards,
} from "../lib/delegations";
import {
  DelegationCardRow,
  DoneSummaryRow,
  FoldedRunningRow,
  PendingAckRow,
  SinceChip,
  UndoStopRow,
} from "./AgentDelegationCards";
import { QuestionCardView } from "./AgentQuestionCard";
import { useAgentDelegations } from "./useAgentDelegations";

/** Running cards re-read their elapsed time this often. */
const TICK_MS = 30_000;
/** While an Undo shows, the dock re-reads its window this often. */
const UNDO_TICK_MS = 1_000;
const HIDDEN_KEY = "buzz.agentDelegations.hiddenDone.v1";
const HIDDEN_MAX = 500;

function readHidden(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
    return new Set(
      Array.isArray(raw) ? raw.filter((key) => typeof key === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function writeHidden(keys: ReadonlySet<string>) {
  try {
    localStorage.setItem(
      HIDDEN_KEY,
      JSON.stringify([...keys].slice(-HIDDEN_MAX)),
    );
  } catch {
    // A per-viewer convenience: without storage it lasts this session.
  }
}

function useAppOrigin(enabled: boolean) {
  const [origin, setOrigin] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!enabled) return;
    let current = true;
    void getAgentCallStreamHost().then((host) => {
      if (current) setOrigin(appOriginFor(host));
    });
    return () => {
      current = false;
    };
  }, [enabled]);
  return origin;
}

function useNow(intervalMs: number | null) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (intervalMs === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * The agent's delegations, docked above the composer of the owner's 1:1 DM
 * (§10.1): the pending ack while the agent's reply is on its way, then
 * "since you last looked", Undo for a just-stopped worker, then worker asks ("from worker: <title>", the same ask card the
 * agent's own questions use, answered straight to the worker), then the
 * running cards (folded at three or more), then one done summary per task.
 * Cards update in place and never become messages.
 */
export function AgentDelegationDock({
  channel,
  currentPubkey,
}: {
  channel: Channel | null;
  currentPubkey?: string;
}) {
  const { agentPubkey, board } = useAgentDelegations(channel, currentPubkey);
  const ready = board.status === "ready";
  const [expanded, setExpanded] = React.useState(false);
  const [hidden, setHidden] = React.useState(readHidden);
  const appOrigin = useAppOrigin(ready);
  const view = React.useMemo(
    () => (ready ? delegationBoard(board.page.cards, hidden) : null),
    [ready, board, hidden],
  );
  // Tick fast only while some Undo window is open; it stops when they close.
  const hasUndo =
    ready &&
    undoableCards(board.page.cards, board.page.serverNow, Date.now()).length >
      0;
  const now = useNow(
    hasUndo ? UNDO_TICK_MS : view && view.running.length > 0 ? TICK_MS : null,
  );
  if (board.status !== "ready" || !view || !agentPubkey) return null;
  const { page, asks, ack, since } = board;
  const undoable = undoableCards(page.cards, page.serverNow, now);
  if (
    !ack &&
    !since &&
    undoable.length === 0 &&
    view.needsYou.length === 0 &&
    view.running.length === 0 &&
    view.done.length === 0
  ) {
    return null;
  }

  const stop = (card: DelegationCard) => {
    void cancelDelegation(agentPubkey, card.delegationId).catch(() =>
      toast.error("Couldn’t stop that worker. Try again."),
    );
  };
  const undo = (card: DelegationCard) => {
    void undoStopDelegation(agentPubkey, card.delegationId).catch(() =>
      toast.error("Couldn’t undo that stop. It may be too late."),
    );
  };
  const seen = () => {
    void markDelegationsSeen(agentPubkey).catch(() =>
      toast.error("Couldn’t mark that as seen. Try again."),
    );
  };
  const hide = (key: string) => {
    const next = new Set(hidden).add(key);
    setHidden(next);
    writeHidden(next);
  };
  const row = (card: DelegationCard) => (
    <DelegationCardRow
      card={card}
      key={card.delegationId}
      now={now}
      onStop={stop}
      serverNow={page.serverNow}
    />
  );

  return (
    <section
      aria-label={`${page.agentName || "Agent"}’s workers`}
      className="mx-5 mb-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-card/95 px-3 py-1.5 shadow-xs"
      data-testid="agent-delegation-dock"
    >
      {ack ? (
        <PendingAckRow agentName={page.agentName} text={ack.text} />
      ) : null}
      {since ? <SinceChip onSeen={seen} text={since.text} /> : null}
      {undoable.length > 0 ? (
        <ul>
          {undoable.map((card) => (
            <UndoStopRow card={card} key={card.delegationId} onUndo={undo} />
          ))}
        </ul>
      ) : null}
      {view.needsYou.map((card) => {
        const open = asks.get(card.delegationId) ?? [];
        if (open.length === 0) {
          return <ul key={card.delegationId}>{row(card)}</ul>;
        }
        return open.map((ask) => (
          <QuestionCardView
            key={ask.id}
            onSend={(answer) =>
              answerDelegationAsk(agentPubkey, ask.id, answer.content)
            }
            question={askAsQuestion(ask)}
            status="open"
            title={fromWorkerLabel(ask, card)}
          />
        ));
      })}
      {view.running.length > 0 ? (
        view.folded ? (
          <>
            <FoldedRunningRow
              count={view.running.length}
              expanded={expanded}
              onToggle={() => setExpanded((value) => !value)}
            />
            {expanded ? (
              <ul className="divide-y divide-border/60">
                {view.running.map(row)}
              </ul>
            ) : null}
          </>
        ) : (
          <ul className="divide-y divide-border/60">{view.running.map(row)}</ul>
        )
      ) : null}
      {view.done.length > 0 ? (
        <ul className="divide-y divide-border/60">
          {view.done.map((summary) => (
            <DoneSummaryRow
              appOrigin={appOrigin}
              key={summary.key}
              onHide={hide}
              summary={summary}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

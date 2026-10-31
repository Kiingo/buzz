import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, ChevronRight, ExternalLink, X } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

import {
  type DelegationCard,
  type DelegationTaskSummary,
  HARNESS_LABELS,
  doneTitle,
  formatElapsed,
  formatUsd,
  liveElapsed,
  needsYou,
  sessionLink,
  stateLabel,
  taskLink,
} from "../lib/delegations";

const open = (url: string) => {
  void openUrl(url).catch(() => toast.error("Couldn’t open that link."));
};

function StateChip({ card }: { card: DelegationCard }) {
  const label = stateLabel(card);
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-medium",
        needsYou(card)
          ? "bg-primary/10 text-primary"
          : card.stalled || card.state === "failed" || card.state === "blocked"
            ? "bg-destructive/10 text-destructive"
            : card.state === "done"
              ? "bg-muted text-foreground"
              : "bg-muted text-muted-foreground",
      )}
      data-testid="agent-delegation-state"
    >
      {label}
    </span>
  );
}

/**
 * One compact delegation card: title, harness, state, elapsed, cost and
 * the latest progress line. It updates in place as the board changes.
 */
export function DelegationCardRow({
  card,
  serverNow,
  now,
  onStop,
}: {
  card: DelegationCard;
  serverNow: string;
  now: number;
  onStop?: (card: DelegationCard) => void;
}) {
  const elapsed = formatElapsed(liveElapsed(card, serverNow, now));
  const cost = formatUsd(card.costUsd);
  const meta = [
    card.harness ? HARNESS_LABELS[card.harness] : null,
    elapsed,
    cost,
  ].filter(Boolean);
  return (
    <li
      className="flex min-w-0 items-start gap-2 py-1.5"
      data-delegation-state={card.state}
      data-testid="agent-delegation-card"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="truncate text-sm font-medium text-foreground"
            title={card.doneWhen ? `Done when: ${card.doneWhen}` : card.title}
          >
            {card.title}
          </span>
          <StateChip card={card} />
          {meta.length > 0 ? (
            <span className="shrink-0 text-2xs text-muted-foreground">
              {meta.join(" · ")}
            </span>
          ) : null}
        </div>
        {card.lastProgressLine ? (
          <p className="truncate text-xs text-muted-foreground">
            {card.lastProgressLine}
          </p>
        ) : null}
      </div>
      {onStop ? (
        <Button
          aria-label={`Stop ${card.title}`}
          className="h-6 w-6 shrink-0"
          onClick={() => onStop(card)}
          size="icon"
          title="Stop this worker"
          type="button"
          variant="ghost"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </li>
  );
}

/** "3 workers running ▸": the folded running cards (§10.1). */
export function FoldedRunningRow({
  count,
  expanded,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      aria-expanded={expanded}
      className="flex w-full items-center gap-1 py-1 text-left text-sm font-medium text-foreground hover:text-primary"
      data-testid="agent-delegation-fold"
      onClick={onToggle}
      type="button"
    >
      {count} workers running
      <Icon aria-hidden className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * One finished task's summary: every worker's result, with links into the
 * task (Kiingo Tasks) and each worker's session (the web app). Worker
 * transcripts never show here.
 */
export function DoneSummaryRow({
  summary,
  appOrigin,
  onHide,
}: {
  summary: DelegationTaskSummary;
  appOrigin: string | null;
  onHide: (key: string) => void;
}) {
  return (
    <li className="py-1.5" data-testid="agent-delegation-done">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {doneTitle(summary)}
        </span>
        {summary.taskId ? (
          <Button
            className="h-6 px-1.5 text-xs"
            onClick={() => open(taskLink(summary.taskId ?? ""))}
            size="sm"
            type="button"
            variant="ghost"
          >
            Open task
            <ExternalLink aria-hidden className="h-3 w-3" />
          </Button>
        ) : null}
        <Button
          aria-label={`Hide ${doneTitle(summary)}`}
          className="h-6 w-6"
          onClick={() => onHide(summary.key)}
          size="icon"
          title="Hide"
          type="button"
          variant="ghost"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ul className="mt-0.5 flex flex-col gap-0.5">
        {summary.workers.map((card) => (
          <li
            className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground"
            key={card.delegationId}
          >
            <span className="shrink-0 font-medium text-foreground">
              {card.title}
            </span>
            <span className="min-w-0 flex-1 line-clamp-2">
              {card.result?.summary ??
                (card.state === "cancelled" ? "Stopped." : stateLabel(card))}
            </span>
            {appOrigin && card.workerSessionId ? (
              <button
                aria-label={`Open the session for ${card.title}`}
                className="shrink-0 underline-offset-2 hover:text-foreground hover:underline"
                onClick={() =>
                  open(sessionLink(appOrigin, card.workerSessionId ?? ""))
                }
                type="button"
              >
                Session
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </li>
  );
}

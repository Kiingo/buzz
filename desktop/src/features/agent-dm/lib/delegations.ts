/**
 * The owner's delegation board in a 1:1 agent DM (delegation-driven agents
 * §10.1, Kiingo `delegation-views.interface.ts`): an agent hands work to
 * worker sessions, and the DM shows them as quiet cards that update in
 * place, never as new messages.
 *
 * Wire: `GET /api/buzz-voice/<client>/agents/-/delegations?agentPubkey=`
 * (IDelegationCardsPage, long-polled with `rev` + `wait`; the host resolves
 * the Buzz agent key as its settings read does), owner-only (D5): anyone
 * else gets 404 and sees only the agent's ordinary messages. The owner's
 * chat page (`GET …/agents/<agentId>/chat`) adds the pending ack. Every
 * parser here fails closed: a malformed card is dropped, a malformed page is
 * no page.
 */

import type { AgentQuestion } from "./markers";

export const DELEGATION_STATES = [
  "queued",
  "running",
  "needs_input",
  "blocked",
  "done",
  "failed",
  "cancelled",
] as const;
export type DelegationState = (typeof DELEGATION_STATES)[number];

const ACTIVE: ReadonlySet<DelegationState> = new Set([
  "queued",
  "running",
  "needs_input",
  "blocked",
]);

/** The long-poll ceiling the host allows (DELEGATION_CARDS_MAX_WAIT_SEC). */
export const DELEGATION_WAIT_SEC = 20;
/** Three or more running cards fold into one row (§10.1). */
export const DELEGATION_FOLD_AT = 3;

export type DelegationHarness = "claude_code" | "codex";

export type DelegationCardResult = {
  summary: string;
  at: string;
  outcome: "done" | "failed" | "cancelled";
};

export type DelegationCard = {
  delegationId: string;
  revision: number;
  title: string;
  harness: DelegationHarness | null;
  state: DelegationState;
  stalled: boolean;
  taskId: string | null;
  taskTitle: string | null;
  workerSessionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedSeconds: number | null;
  costUsd: number | null;
  doneWhen: string | null;
  /** Interim only; never shown as a result (§16.4). */
  lastProgressLine: string | null;
  result: DelegationCardResult | null;
  pendingAsksCount: number;
  ownerActive: boolean;
};

export type DelegationSummary = {
  runningCount: number;
  needsYouCount: number;
  stalledCount: number;
  costTodayUsd: number | null;
  canStopAll: boolean;
};

export type DelegationPage = {
  rev: string;
  serverNow: string;
  /** The Kiingo agent behind the key: the id the per-delegation routes use. */
  agentId: string | null;
  agentName: string;
  summary: DelegationSummary;
  cards: DelegationCard[];
};

export type DelegationPoll =
  | { kind: "page"; page: DelegationPage }
  | { kind: "unchanged"; rev: string };

/** A worker's question to its orchestrator, answered here by the owner. */
export type DelegationAsk = {
  id: string;
  delegationId: string;
  workerTitle: string;
  question: string;
  options: string[];
  recommendation: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isDelegationUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_RE.test(value);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const count = (value: unknown): number => {
  const n = num(value);
  return n !== null && n > 0 ? Math.floor(n) : 0;
};

const uuidOrNull = (value: unknown): string | null =>
  isDelegationUuid(value) ? value.toLowerCase() : null;

function parseResult(value: unknown): DelegationCardResult | null {
  const record = asRecord(value);
  const summary = str(record?.summary);
  const outcome = record?.outcome;
  if (
    !record ||
    !summary ||
    (outcome !== "done" && outcome !== "failed" && outcome !== "cancelled")
  ) {
    return null;
  }
  return { summary, at: str(record.at) ?? "", outcome };
}

export function parseDelegationCard(value: unknown): DelegationCard | null {
  const record = asRecord(value);
  if (!record) return null;
  const delegationId = uuidOrNull(record.delegationId);
  const title = str(record.title);
  const state = record.state as DelegationState;
  if (!delegationId || !title || !DELEGATION_STATES.includes(state)) {
    return null;
  }
  const harness =
    record.harness === "claude_code" || record.harness === "codex"
      ? record.harness
      : null;
  return {
    delegationId,
    revision: count(record.revision),
    title: title.trim(),
    harness,
    state,
    stalled: record.stalled === true && state === "running",
    taskId: uuidOrNull(record.taskId),
    taskTitle: str(record.taskTitle)?.trim() ?? null,
    workerSessionId: uuidOrNull(record.workerSessionId),
    startedAt: str(record.startedAt),
    finishedAt: str(record.finishedAt),
    elapsedSeconds: num(record.elapsedSeconds),
    costUsd: num(asRecord(record.cost)?.costUsd),
    doneWhen: str(record.doneWhen)?.trim() ?? null,
    lastProgressLine: str(record.lastProgressLine)?.trim() ?? null,
    // A result belongs to a finished card only.
    result: ACTIVE.has(state) ? null : parseResult(record.result),
    pendingAsksCount: count(record.pendingAsksCount),
    ownerActive: record.ownerActive === true,
  };
}

function parseSummary(value: unknown): DelegationSummary | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    runningCount: count(record.runningCount),
    needsYouCount: count(record.needsYouCount),
    stalledCount: count(record.stalledCount),
    costTodayUsd: num(record.costTodayUsd),
    canStopAll: record.canStopAll === true,
  };
}

/** One long-poll answer: a page, `unchanged`, or null when malformed. */
export function parseDelegationPoll(value: unknown): DelegationPoll | null {
  const record = asRecord(value);
  const rev = str(record?.rev);
  if (!record || !rev) return null;
  if (record.unchanged === true) return { kind: "unchanged", rev };
  const summary = parseSummary(record.summary);
  if (!summary || !Array.isArray(record.cards)) return null;
  const seen = new Set<string>();
  const cards: DelegationCard[] = [];
  for (const raw of record.cards) {
    const card = parseDelegationCard(raw);
    if (!card || seen.has(card.delegationId)) continue;
    seen.add(card.delegationId);
    cards.push(card);
  }
  return {
    kind: "page",
    page: {
      rev,
      serverNow: str(record.serverNow) ?? "",
      agentId: uuidOrNull(asRecord(record.agent)?.id),
      agentName: str(asRecord(record.agent)?.name)?.trim() ?? "",
      summary,
      cards,
    },
  };
}

/** The open asks of `GET …/delegations/<id>` (IDelegationDetailResponse). */
export function parseDelegationAsks(value: unknown): DelegationAsk[] {
  const delegation = asRecord(asRecord(value)?.delegation);
  const raw = delegation?.pendingAsks;
  if (!Array.isArray(raw)) return [];
  const asks: DelegationAsk[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const id = uuidOrNull(record?.id);
    const delegationId = uuidOrNull(record?.delegationId);
    const question = str(record?.question);
    if (!record || !id || !delegationId || !question) continue;
    if (record.state !== undefined && record.state !== "open") continue;
    const options = Array.isArray(record.options)
      ? [
          ...new Set(
            record.options
              .map((option) => str(option)?.trim())
              .filter((option): option is string => Boolean(option)),
          ),
        ]
      : [];
    asks.push({
      id,
      delegationId,
      workerTitle: str(record.workerTitle)?.trim() ?? "",
      question: question.trim(),
      options,
      recommendation: str(record.recommendation)?.trim() ?? null,
    });
  }
  return asks;
}

export const isActiveDelegation = (card: DelegationCard) =>
  ACTIVE.has(card.state);

/** Waiting on the owner: an open ask, or `needs_input`. */
export const needsYou = (card: DelegationCard) =>
  isActiveDelegation(card) &&
  (card.state === "needs_input" || card.pendingAsksCount > 0);

/** "from worker: <title>" (§10.1). */
export const fromWorkerLabel = (ask: DelegationAsk, card?: DelegationCard) =>
  `from worker: ${ask.workerTitle || card?.title || "worker"}`;

/**
 * A worker ask in the existing question card's shape: one question, its
 * options (the recommended one described as such) and free text, so the
 * owner answers with the same card the agent's own questions use.
 */
export function askAsQuestion(ask: DelegationAsk): AgentQuestion {
  return {
    askId: ask.id,
    items: [
      {
        qid: "q",
        question: ask.question,
        header: null,
        multi: false,
        allowOther: true,
        options: ask.options.map((label) => ({
          label,
          description: label === ask.recommendation ? "Recommended" : null,
        })),
      },
    ],
  };
}

export const STATE_LABELS: Record<DelegationState, string> = {
  queued: "queued",
  running: "running",
  needs_input: "needs you",
  blocked: "blocked",
  done: "done",
  failed: "failed",
  cancelled: "stopped",
};

export function stateLabel(card: DelegationCard): string {
  if (card.stalled) return "stalled";
  return needsYou(card) ? "needs you" : STATE_LABELS[card.state];
}

export const HARNESS_LABELS: Record<DelegationHarness, string> = {
  claude_code: "Claude",
  codex: "Codex",
};

/** `$4.10`, or null when there is no cost to show. */
export function formatUsd(value: number | null): string | null {
  if (value === null || value <= 0) return null;
  return value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
}

/** `45s`, `12m`, `1h 05m`. */
export function formatElapsed(seconds: number | null): string | null {
  if (seconds === null || seconds < 0) return null;
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * A running card's elapsed time now: the server's figure at `serverNow`,
 * plus the time since. Finished cards keep the server's figure.
 */
export function liveElapsed(
  card: DelegationCard,
  serverNow: string,
  now: number,
): number | null {
  if (card.elapsedSeconds === null) return null;
  if (!isActiveDelegation(card) || card.state === "queued") {
    return card.elapsedSeconds;
  }
  const at = Date.parse(serverNow);
  return Number.isFinite(at)
    ? card.elapsedSeconds + Math.max(0, (now - at) / 1000)
    : card.elapsedSeconds;
}

/**
 * The thread header: "3 running · 1 needs you · $4.10 today". Null when
 * there is nothing to say.
 */
export function headerText(summary: DelegationSummary): string | null {
  const parts: string[] = [];
  if (summary.runningCount > 0) parts.push(`${summary.runningCount} running`);
  if (summary.needsYouCount > 0) {
    parts.push(`${summary.needsYouCount} needs you`);
  }
  if (summary.stalledCount > 0) parts.push(`${summary.stalledCount} stalled`);
  const cost = formatUsd(summary.costTodayUsd);
  if (parts.length === 0) return null;
  if (cost) parts.push(`${cost} today`);
  return parts.join(" · ");
}

/** One finished task: every worker that finished on it, in one summary. */
export type DelegationTaskSummary = {
  key: string;
  taskId: string | null;
  title: string;
  outcome: "done" | "failed" | "mixed";
  workers: DelegationCard[];
  finishedAt: string;
};

export type DelegationBoard = {
  /** Cards waiting on the owner, newest first. */
  needsYou: DelegationCard[];
  /** Every other active card. */
  running: DelegationCard[];
  /** `running` folds into one row. */
  folded: boolean;
  /** Finished work, one summary per task, newest first. */
  done: DelegationTaskSummary[];
};

const byNewest = (a: string | null, b: string | null) =>
  (b ?? "").localeCompare(a ?? "");

/**
 * The board from a page. A task shows its done summary only once none of
 * its workers is still active; `hidden` holds the summaries the owner put
 * away (by key).
 */
export function delegationBoard(
  cards: readonly DelegationCard[],
  hidden: ReadonlySet<string> = new Set(),
): DelegationBoard {
  const active = cards.filter(isActiveDelegation);
  const asking = active
    .filter(needsYou)
    .sort((a, b) => byNewest(a.startedAt, b.startedAt));
  const running = active
    .filter((card) => !needsYou(card))
    .sort((a, b) => byNewest(a.startedAt, b.startedAt));
  const activeTasks = new Set(
    active.map((card) => card.taskId).filter(Boolean),
  );
  const groups = new Map<string, DelegationCard[]>();
  for (const card of cards) {
    if (isActiveDelegation(card)) continue;
    if (card.taskId && activeTasks.has(card.taskId)) continue;
    const key = card.taskId ?? card.delegationId;
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  const done: DelegationTaskSummary[] = [];
  for (const [key, workers] of groups) {
    if (hidden.has(key)) continue;
    const ordered = [...workers].sort((a, b) =>
      byNewest(a.finishedAt, b.finishedAt),
    );
    const outcomes = new Set(
      ordered.map((card) => (card.state === "done" ? "done" : "failed")),
    );
    done.push({
      key,
      taskId: ordered[0]?.taskId ?? null,
      title: ordered[0]?.taskTitle ?? ordered[0]?.title ?? "",
      outcome:
        outcomes.size > 1 ? "mixed" : outcomes.has("done") ? "done" : "failed",
      workers: ordered,
      finishedAt: ordered[0]?.finishedAt ?? "",
    });
  }
  done.sort((a, b) => byNewest(a.finishedAt, b.finishedAt));
  return {
    needsYou: asking,
    running,
    folded: running.length >= DELEGATION_FOLD_AT,
    done,
  };
}

export function doneTitle(summary: DelegationTaskSummary): string {
  const label =
    summary.outcome === "done"
      ? "Done"
      : summary.outcome === "failed"
        ? "Didn’t finish"
        : "Finished";
  return summary.title ? `${label} · ${summary.title}` : label;
}

/** `kiingotasks://task/<id>` (Kiingo Tasks opens the task). */
export const taskLink = (taskId: string) =>
  `kiingotasks://task/${taskId.toLowerCase()}`;

/**
 * The web app beside the agent host (`api.kiingo.com` → `app.kiingo.com`),
 * where a worker's session opens. Null for any other host.
 */
export function appOriginFor(apiHost: string | null): string | null {
  const host = apiHost?.trim().toLowerCase() ?? "";
  if (!/^api\.[a-z0-9.-]+$/u.test(host) || host.includes("..")) return null;
  return `https://app.${host.slice("api.".length)}`;
}

export const sessionLink = (appOrigin: string, sessionId: string) =>
  `${appOrigin}/team/harness-sessions/${sessionId.toLowerCase()}/feed`;

/**
 * The cards list path for a Buzz agent key (the host resolves it), long-
 * polled on `rev` after the first read.
 */
export function delegationsPath(
  agentPubkey: string,
  rev: string | null,
): string {
  const base = `agents/-/delegations?agentPubkey=${agentPubkey.toLowerCase()}`;
  return rev
    ? `${base}&rev=${encodeRev(rev)}&wait=${DELEGATION_WAIT_SEC}`
    : base;
}

/** The newest page of the owner's chat: it carries the pending ack. */
export const delegationChatPath = (agentId: string) =>
  `agents/${agentId.toLowerCase()}/chat?limit=1`;

/**
 * The server's instant acknowledgement (IDelegationPendingAck): workers the
 * agent started this turn, shown until its own reply lands. Transient: a
 * page without it, or with another id, drops it.
 */
export type DelegationPendingAck = {
  id: string;
  /** "Starting 2 workers: Fix the login bug, Draft the launch email". */
  text: string;
  /** Epoch ms after which the row goes even without a fresh page. */
  expiresAtMs: number;
};

/** The pending ack on an owner chat page, or null (absent, bad or past). */
export function parsePendingAck(
  chatPage: unknown,
  nowMs: number,
): DelegationPendingAck | null {
  const ack = asRecord(asRecord(asRecord(chatPage)?.delegations)?.pendingAck);
  const id = str(ack?.id);
  const text = str(ack?.text)?.trim();
  const expiresAtMs = Date.parse(str(ack?.expiresAt) ?? "");
  if (!id || !text || !Number.isFinite(expiresAtMs)) return null;
  return expiresAtMs > nowMs
    ? { id, text: text.slice(0, 500), expiresAtMs }
    : null;
}

/**
 * `rev` percent-encoded down to letters, digits and `-_.`: the native
 * route check refuses the `!'()*~` that encodeURIComponent leaves bare.
 */
function encodeRev(rev: string): string {
  return encodeURIComponent(rev).replace(
    /[!'()*~]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The agent of the reader's own 1:1 DM, or null. The board shows only
 * there: never in a group DM or channel, where members see the agent's
 * summaries alone (D5).
 */
export function delegationDmAgent(
  channel: {
    channelType?: string | null;
    participantPubkeys?: readonly string[] | null;
  } | null,
  viewerPubkey: string | null | undefined,
): string | null {
  if (channel?.channelType !== "dm" || !viewerPubkey) return null;
  const viewer = viewerPubkey.toLowerCase();
  const people = [
    ...new Set((channel.participantPubkeys ?? []).map((p) => p.toLowerCase())),
  ];
  if (people.length !== 2 || !people.includes(viewer)) return null;
  const other = people.find((pubkey) => pubkey !== viewer) ?? null;
  return other && /^[0-9a-f]{64}$/u.test(other) ? other : null;
}

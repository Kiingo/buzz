/**
 * The agent host's call screen feed (contract v1 plus the additive v2
 * fields): the whole current state of the caller's own call, keyed by ask.
 * Status is the host's ledger, never inferred here. Every v2 field is
 * optional; a snapshot without `contract: 2` shows only v1 content.
 */

export type AgentCallAskStatus =
  | "open"
  | "submitted"
  | "still_working"
  | "answered"
  | "not_answered"
  | "failed";

export type AgentCallLink = { url: string; title: string | null };

export type AgentCallResultCard = {
  id: string;
  kind: "email" | "event" | "file" | "link" | "draft" | "task";
  title: string;
  subtitle: string | null;
  url: string | null;
};

export type AgentCallStep = {
  id: string;
  at: string;
  line: string;
  state: "running" | "done" | "failed";
};

export type AgentCallAsk = {
  askId: string | null;
  utteranceId: string;
  askKey?: string;
  kind: "ask" | "answer";
  text: string;
  status: AgentCallAskStatus;
  statusReason: string | null;
  createdAt: string;
  closedAt: string | null;
  progress: { text: string; at: string } | null;
  result: {
    text: string | null;
    format: "text" | "markdown";
    sentTo?: { label: string; state: "pending" | "delivered" } | null;
  } | null;
  links: AgentCallLink[];
  answersHumanAsk?: string | null;
  request?: { text: string; at: string; source: string } | null;
  title?: { text: string; source: string } | null;
  humanAskId?: string | null;
  nowLine?: { text: string; at: string } | null;
  steps?: AgentCallStep[];
  results?: AgentCallResultCard[];
  archivedAt?: string | null;
  pinnedAt?: string | null;
  cancelledAt?: string | null;
  actions?: { cancel?: boolean; tellMore?: boolean; openChat?: boolean };
};

export type AgentCallQuestion = {
  id: string;
  question: string;
  options: { index: number; label: string }[];
  allowsText: boolean;
};

export type AgentCallHumanAsk = {
  humanAskId: string;
  state: "open" | "answered" | "closed";
  askingAskId?: string | null;
  answeredBy: "voice" | "tap" | null;
  answerText: string | null;
  questions: AgentCallQuestion[];
};

export type AgentCallFeed = {
  callId: string;
  rev: string;
  state: "live" | "ended";
  agent: { id: string; name: string } | null;
  working?: { since: string; open: number } | null;
  destination: {
    kind: "buzz_dm" | "sidebar" | "none";
    label: string | null;
  } | null;
  asks: AgentCallAsk[];
  humanAsk: AgentCallHumanAsk | null;
  endedAt: string | null;
  contract?: number;
  counts?: { open: number; needsYou: number; archived: number; total: number };
  recap?: AgentCallRecap | null;
};

export type AgentCallRecapItem = {
  askKey: string;
  title: string;
  status: AgentCallAskStatus;
  archived?: boolean;
  reason?: string | null;
};

/** Set once the call has ended (`summary` is null while it is written). */
export type AgentCallRecap = {
  summary: string | null;
  done?: AgentCallRecapItem[];
  stillOpen?: AgentCallRecapItem[];
  notDone?: AgentCallRecapItem[];
  links?: { label: string; url: string }[];
};

const TERMINAL: ReadonlySet<AgentCallAskStatus> = new Set([
  "answered",
  "not_answered",
  "failed",
]);

export function isAskTerminal(ask: AgentCallAsk): boolean {
  return TERMINAL.has(ask.status);
}

/** The ask's key for the per-ask routes (v2 `askKey`, else v1 utteranceId). */
export function askKeyOf(ask: AgentCallAsk): string {
  return ask.askKey ?? ask.utteranceId;
}

/** A short title: the host's title, else the caller's first words. */
export function askTitle(ask: AgentCallAsk): string {
  const title = ask.title?.text?.trim();
  if (title) return title;
  const words = ask.text.trim().split(/\s+/).slice(0, 8).join(" ");
  return words.length < ask.text.trim().length ? `${words}…` : words;
}

/** One live line: the host's now line or last progress, while working. */
export function askNowLine(ask: AgentCallAsk): string | null {
  if (isAskTerminal(ask)) return null;
  return ask.nowLine?.text ?? ask.progress?.text ?? null;
}

export function askStatusLabel(ask: AgentCallAsk): string {
  if (ask.cancelledAt) return "Cancelled";
  switch (ask.status) {
    case "open":
    case "submitted":
    case "still_working":
      return "Working";
    case "answered":
      return "Done";
    case "not_answered":
      return "Not done";
    case "failed":
      return "Failed";
  }
}

/**
 * The visible list: answers fold under the question card, archived asks are
 * listed apart, pinned asks first (newest pin first), then oldest first.
 */
export function visibleAsks(feed: AgentCallFeed): {
  shown: AgentCallAsk[];
  archived: AgentCallAsk[];
} {
  const asks = feed.asks.filter((ask) => ask.kind === "ask");
  const shown = asks.filter((ask) => !ask.archivedAt);
  const pinned = shown
    .filter((ask) => ask.pinnedAt)
    .sort((a, b) => String(b.pinnedAt).localeCompare(String(a.pinnedAt)));
  const rest = shown.filter((ask) => !ask.pinnedAt);
  return {
    shown: [...pinned, ...rest],
    archived: asks.filter((ask) => ask.archivedAt),
  };
}

/** Only https links are opened from the call screen. */
export function safeHttpsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Whether a long-poll answer is a full snapshot (not `unchanged`). */
export function isFeedSnapshot(value: unknown): value is AgentCallFeed {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !(value as { unchanged?: unknown }).unchanged &&
    typeof (value as { callId?: unknown }).callId === "string" &&
    Array.isArray((value as { asks?: unknown }).asks)
  );
}

/** Whether the call screen should wait for more: live, or ended without a
 * recap summary yet (it is written a few seconds after hang-up). */
export function feedWantsMore(feed: AgentCallFeed | null): boolean {
  if (!feed) return true;
  if (feed.state === "live") return true;
  if (feed.contract !== undefined && feed.contract >= 2) {
    return !feed.recap || feed.recap.summary === null;
  }
  return false;
}

/** The one open question, if it is still open. */
export function openHumanAsk(
  feed: AgentCallFeed | null,
): AgentCallHumanAsk | null {
  const ask = feed?.humanAsk ?? null;
  return ask && ask.state === "open" && ask.questions.length > 0 ? ask : null;
}

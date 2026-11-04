import { request } from "@/features/agent-call/lib/agentCallApi";
import { readReplyDetails } from "@/features/messages/lib/replyDetails";

import { cachedAgentSummary, ensureAgentSummary } from "./agentSummary";
import { parseMirror } from "./markers";

/**
 * How a reply was made, under an agent's reply in the reader's own 1:1 DM
 * with their hosted agent: a quiet line ("Used 6 tools · 41 s", else
 * "Steps") that opens the turn's steps. The same line and the same read as
 * the agent's chat in the other apps (CHATUI-E).
 *
 * A Buzz reply names its Run (`kiingo-mission`), or, mirrored, its chat entry
 * (`buzz-mirror` source id). The reader's own chat page
 * (`GET agents/<id>/chat?contract=2`) ties that to the reply's entry and its
 * turn; `GET agents/<id>/chat/turns/<turn>/activity` reads the steps. The
 * host answers only the reader's own conversation and Runs. A reply the
 * newest page doesn't hold shows no line: nothing is guessed. Read only.
 *
 * Community-scoped: `resetTurnStepsCache()` runs in resetCommunityState().
 */

/** The page read: the newest entries, where the replies' turns are named. */
export const TURN_PAGE_LIMIT = 50;
/** How long a page answer is reused before a reply asks again. */
export const TURN_PAGE_TTL_MS = 30_000;
/** The line when the page has no counts for the reply. */
export const STEPS_LINE_UNKNOWN = "Steps";
export const STEPS_READ_FAILED = "Couldn't load the steps. Try again.";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HEX64_RE = /^[0-9a-f]{64}$/u;

/** What a Buzz reply says about where it came from. */
export type ReplyKey = {
  /** The Run behind the reply (`kiingo-mission`). */
  runId: string | null;
  /** The chat entry a mirrored reply copies (`buzz-mirror` source id). */
  entryId: string | null;
  /** The reply's own time, epoch ms. */
  atMs: number;
};

/** One agent reply on the chat page, as far as its line needs. */
export type ChatReply = {
  id: string;
  runId: string | null;
  atMs: number;
  /** The id `…/turns/<id>/activity` takes for this reply. */
  turnId: string;
  line: string;
  running: boolean;
};

export type StepState = "running" | "done" | "failed";

export type TurnStep = {
  id: string;
  type: "tool" | "reasoning" | "note";
  line: string;
  /** What the call ran ("Bash", "memory.recall"); tools only. */
  action: string | null;
  state: StepState;
  /** Untrusted, shown as plain text. */
  text: string | null;
  args: string | null;
  result: string | null;
  link: { url: string; title: string | null } | null;
};

export type TurnSteps = {
  turnId: string;
  state: "running" | "done" | "failed" | "stopped";
  durationMs: number | null;
  items: TurnStep[];
  /** Older steps the read left out. */
  omitted: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function uuid(value: unknown): string | null {
  const text = str(value)?.toLowerCase() ?? null;
  return text && UUID_RE.test(text) ? text : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function ms(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : null;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The reply's Run or mirrored entry, or null when it names neither. */
export function replyKey(
  tags: readonly (readonly string[])[] | undefined,
  createdAtSeconds: number,
): ReplyKey | null {
  const mirror = parseMirror(tags);
  const entryId =
    mirror?.role === "agent" ? uuid(mirror.sourceId.split("#")[0]) : null;
  const runId = mirror ? null : readReplyDetails(tags).missionId;
  if (!entryId && !runId) return null;
  return { runId, entryId, atMs: createdAtSeconds * 1000 };
}

/** "41 s", "3 min 5 s", "1 h 2 min": the other apps' words. */
export function stepsDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return seconds % 60 === 0
      ? `${minutes} min`
      : `${minutes} min ${seconds % 60} s`;
  }
  return minutes % 60 === 0
    ? `${Math.floor(minutes / 60)} h`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The activity summary's line: the server's label, else built the same way. */
export function activityLine(summary: unknown): string | null {
  const value = asRecord(summary);
  if (!value) return null;
  const label = str(value.label);
  if (label) return oneLine(label, 120);
  const tools = count(value.tools);
  if (tools + count(value.reasoning) === 0) return null;
  const used = tools === 1 ? "Used 1 tool" : `Used ${tools} tools`;
  const duration = ms(value.durationMs);
  return duration === null ? used : `${used} · ${stepsDuration(duration)}`;
}

/** The memory label, then the tools and time; "Steps" without either. */
export function replyLine(activity: unknown, memory: unknown): string {
  const parts: string[] = [];
  const memoryLabel = str(asRecord(memory)?.label);
  if (memoryLabel) parts.push(oneLine(memoryLabel, 160));
  const tools = activityLine(activity);
  if (tools) parts.push(tools);
  return parts.length > 0 ? parts.join(" · ") : STEPS_LINE_UNKNOWN;
}

/** The agent replies on a contract-2 chat page, oldest first as sent. */
export function parseChatReplies(page: unknown): ChatReply[] {
  const entries = asRecord(page)?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((raw) => {
    const entry = asRecord(raw);
    const id = uuid(entry?.id);
    const atMs = Date.parse(str(entry?.at) ?? "");
    if (!entry || !id || entry.role !== "agent" || !Number.isFinite(atMs)) {
      return [];
    }
    const activity = asRecord(entry.activity);
    const memory = asRecord(entry.memory);
    // The same turn the other apps open: the counts' turn, else the turn
    // the reply settled or opened, else the reply itself (a Run's own).
    const turnId =
      uuid(memory?.turnId) ??
      uuid(activity?.turnId) ??
      uuid(entry.turnId) ??
      uuid(entry.chainTurnId) ??
      id;
    return [
      {
        id,
        runId: uuid(entry.runId),
        atMs,
        turnId,
        line: replyLine(activity, memory),
        running: activity?.state === "running",
      },
    ];
  });
}

/**
 * The page reply a Buzz reply is: the mirrored entry itself, else the Run's
 * reply nearest the Buzz reply's time. Null when the page holds neither.
 */
export function findReply(
  replies: readonly ChatReply[],
  key: ReplyKey,
): ChatReply | null {
  if (key.entryId) {
    return replies.find((reply) => reply.id === key.entryId) ?? null;
  }
  let best: ChatReply | null = null;
  for (const reply of replies) {
    if (reply.runId !== key.runId) continue;
    if (
      !best ||
      Math.abs(reply.atMs - key.atMs) < Math.abs(best.atMs - key.atMs)
    ) {
      best = reply;
    }
  }
  return best;
}

function stepState(value: unknown): StepState {
  return value === "running" || value === "failed" ? value : "done";
}

function httpsLink(value: unknown): TurnStep["link"] {
  const link = asRecord(value);
  const raw = str(link?.url);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const title = str(link?.title);
    return { url: url.toString(), title: title ? oneLine(title, 200) : null };
  } catch {
    return null;
  }
}

function parseStep(raw: unknown): TurnStep | null {
  const value = asRecord(raw);
  const id = str(value?.id);
  if (!value || !id) return null;
  const type =
    value.type === "reasoning" || value.type === "note" ? value.type : "tool";
  const text = str(value.text);
  // A reasoning or note step may carry its text without a line.
  const line = str(value.line) ?? text;
  if (!line) return null;
  const action =
    type === "tool" ? (str(value.action) ?? str(value.name)) : null;
  return {
    id,
    type,
    line: oneLine(line, 140),
    action: action ? oneLine(action, 160) : null,
    state: stepState(value.state),
    text,
    args: str(value.args),
    result: str(value.result),
    link: httpsLink(value.link),
  };
}

/** `GET …/chat/turns/<id>/activity`, or null when it isn't one. */
export function parseTurnSteps(body: unknown): TurnSteps | null {
  const value = asRecord(body);
  const turnId = uuid(value?.turnId);
  if (!value || !turnId) return null;
  const state =
    value.state === "running" ||
    value.state === "failed" ||
    value.state === "stopped"
      ? value.state
      : "done";
  const items = Array.isArray(value.items)
    ? value.items.flatMap((item) => {
        const step = parseStep(item);
        return step ? [step] : [];
      })
    : [];
  return {
    turnId,
    state,
    durationMs: ms(value.durationMs),
    items,
    omitted: count(value.omitted),
  };
}

export const turnPagePath = (agentId: string) =>
  `agents/${agentId}/chat?contract=2&limit=${TURN_PAGE_LIMIT}`;

export const turnStepsPath = (agentId: string, turnId: string) =>
  `agents/${agentId}/chat/turns/${turnId}/activity`;

// ── The per-agent page and per-turn steps, shared by every reply row ──────

type PageEntry = { replies: ChatReply[] | null; fetchedAt: number };

let pages = new Map<string, PageEntry>();
let pageReads = new Map<string, Promise<void>>();
let steps = new Map<string, TurnSteps>();
let generation = 0;
let version = 0;
let now: () => number = () => Date.now();
const listeners = new Set<() => void>();

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeTurnSteps(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTurnStepsVersion() {
  return version;
}

/** Test seam: replace the clock. Returns a restore function. */
export function setTurnStepsClockForTests(next: () => number) {
  const previous = now;
  now = next;
  return () => {
    now = previous;
  };
}

function normalize(agentPublicKey: string): string | null {
  const key = agentPublicKey.trim().toLowerCase();
  return HEX64_RE.test(key) ? key : null;
}

async function hostedAgentId(key: string): Promise<string | null> {
  await ensureAgentSummary(key);
  return uuid(cachedAgentSummary(key)?.agentId ?? null);
}

/** The page reply for a Buzz reply, from the last page read; null if none. */
export function getReplyTurn(
  agentPublicKey: string,
  key: ReplyKey,
): ChatReply | null {
  const agent = normalize(agentPublicKey);
  const replies = agent ? pages.get(agent)?.replies : null;
  return replies ? findReply(replies, key) : null;
}

/**
 * Read the page unless a fresh one (or one in flight) can answer this
 * reply. A reply that landed after the last read, or a running turn's
 * line, asks again after the TTL. A failed read means no line.
 */
export function ensureReplyTurn(
  agentPublicKey: string,
  key: ReplyKey,
): Promise<void> {
  const agent = normalize(agentPublicKey);
  if (!agent) return Promise.resolve();
  const cached = pages.get(agent);
  if (cached) {
    const found = cached.replies ? findReply(cached.replies, key) : null;
    // A finished reply's line doesn't change.
    if (found && !found.running) return Promise.resolve();
    const fresh = now() - cached.fetchedAt < TURN_PAGE_TTL_MS;
    const landedSince = found === null && key.atMs > cached.fetchedAt;
    if (fresh && !landedSince) return Promise.resolve();
  }
  const pending = pageReads.get(agent);
  if (pending) return pending;
  const owner = generation;
  const read = (async () => {
    let replies: ChatReply[] | null = null;
    try {
      const agentId = await hostedAgentId(agent);
      replies = agentId
        ? parseChatReplies(await request<unknown>("GET", turnPagePath(agentId)))
        : null;
    } catch {
      replies = null;
    }
    if (owner !== generation) return;
    pageReads.delete(agent);
    pages.set(agent, { replies, fetchedAt: now() });
    notify();
  })();
  pageReads.set(agent, read);
  return read;
}

/** A turn's steps from the last read, or null. */
export function getTurnSteps(turnId: string): TurnSteps | null {
  return steps.get(turnId) ?? null;
}

/**
 * Read a turn's steps: once when finished, again while it runs. Throws on
 * a failed read; what showed stays.
 */
export async function loadTurnSteps(
  agentPublicKey: string,
  turnId: string,
): Promise<TurnSteps> {
  const cached = steps.get(turnId);
  if (cached && cached.state !== "running") return cached;
  const agent = normalize(agentPublicKey);
  const agentId = agent ? await hostedAgentId(agent) : null;
  const turn = uuid(turnId);
  if (!agentId || !turn) throw new Error("agent_not_hosted");
  const owner = generation;
  const read = parseTurnSteps(
    await request<unknown>("GET", turnStepsPath(agentId, turn)),
  );
  if (!read) throw new Error("response_invalid");
  if (owner === generation) {
    steps.set(turnId, read);
    notify();
  }
  return read;
}

/** Clears every page and step read and retires reads in flight. */
export function resetTurnStepsCache() {
  generation += 1;
  pages = new Map();
  pageReads = new Map();
  steps = new Map();
  notify();
}

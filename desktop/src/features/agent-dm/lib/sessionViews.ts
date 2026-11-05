import {
  AgentCallApiError,
  newIdempotencyKey,
  request,
} from "@/features/agent-call/lib/agentCallApi";

import { cachedAgentSummary, ensureAgentSummary } from "./agentSummary";

/**
 * The reader's own session with a hosted agent, read from their 1:1 DM: its
 * screens (/agents, /mcp, /permissions, /config, /hooks, /memory, /help,
 * /doctor, /skills), the files it changed (/diff), their own queued messages,
 * Interrupt, Stop on one background task, and the pages /export saves. From the host's `agents/<id>/session/...` routes on the Buzz
 * mount, which pick the session themselves: the signer's own conversation's
 * session, or 404.
 *
 * Everything here reads, except Withdraw and Edit (the reader's own queued
 * message), Interrupt (Esc; the session keeps going) and Stop on a task. Nothing
 * writes a setting or runs a passkey command; the host strips every write action
 * from a screen, and all but `stop_task` on `agents`. Stop sends only the
 * host's own line. Every word shown is the session's or a tool's: untrusted,
 * plain text.
 *
 * Community-scoped: `resetSessionViewsCache()` runs in resetCommunityState().
 */

/** How long the "/" built-ins are reused before the next "/" asks again. */
export const SESSION_BUILTINS_TTL_MS = 60_000;

const HEX64_RE = /^[0-9a-f]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The screens the host serves (`HARNESS_NATIVE_SCREENS`). */
export const SESSION_SCREENS = [
  "config",
  "permissions",
  "mcp",
  "agents",
  "hooks",
  "memory",
  "resume",
  "login",
  "approvals",
  "help",
  "doctor",
  "skills",
] as const;
export type SessionScreenName = (typeof SESSION_SCREENS)[number];

export type SessionView =
  | { kind: "screen"; screen: SessionScreenName }
  | { kind: "files" }
  | { kind: "queued" }
  | { kind: "export" };

// ---- Wire shapes ----

export type ScreenRow = {
  label: string;
  value: string | null;
  detail: string | null;
  body: string | null;
  mono: boolean;
  /** The background task Stop names, on the `agents` screen only. */
  stopTaskId: string | null;
  /** Why Stop is off for this row; it shows disabled. */
  stopUnavailable: string | null;
};

export type ScreenSection = {
  id: string;
  title: string;
  /** `unavailable`: this source couldn't be read; never show it as empty. */
  unavailable: boolean;
  note: string | null;
  empty: string | null;
  rows: ScreenRow[];
};

export type SessionScreen = {
  title: string;
  description: string;
  sections: ScreenSection[];
};

export type FileChange = {
  id: string;
  path: string;
  kind: "edit" | "create" | "delete" | "move";
  movedTo: string | null;
  failed: boolean;
  added: number;
  removed: number;
  lines: { sign: " " | "+" | "-"; text: string }[];
};

export type QueuedMessage = {
  messageId: string;
  body: string;
  createdAt: string;
  /** Held for the session's next idle moment rather than its next turn. */
  idle: boolean;
};

/** A "/" row this client opens as a view. */
export type SessionBuiltin = {
  name: string;
  description: string;
  view: SessionView;
};

/**
 * A "/" row sent as typed (/review, /init): the host starts the chat's own
 * server-fixed turn for it in the reader's own DM (BZ-REVIEW, 79 2026-11-05
 * D2). `takesWords`: the person's own words may follow (/review).
 */
export type SessionPromptRow = {
  name: string;
  description: string;
  takesWords: boolean;
};

export type SessionBuiltins = {
  /** `tmux`: the session runs in a pane, so Interrupt applies. */
  lane: "tmux" | "managed";
  rows: SessionBuiltin[];
  prompts: SessionPromptRow[];
  /** `/clear`'s words, when this session lists it; it sends `/new`. */
  clear: string | null;
  /** `/branch` or `/fork`, when this session has it; it goes as typed. */
  branch: { name: string; description: string } | null;
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The host's `isHarnessTaskId` shape. */
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/u;

const stopControl = (
  value: unknown,
): { stopTaskId: string | null; stopUnavailable: string | null } => {
  const control = record(value);
  const taskId = text(control?.task_id);
  return control?.kind === "stop_task" && taskId && TASK_ID_RE.test(taskId)
    ? { stopTaskId: taskId, stopUnavailable: text(control.unavailable_reason) }
    : { stopTaskId: null, stopUnavailable: null };
};

const isScreenName = (value: unknown): value is SessionScreenName =>
  (SESSION_SCREENS as readonly unknown[]).includes(value);

/**
 * A screen, read only: rows keep their words and nothing they could do, except
 * a Stop the host left on an `agents` row.
 */
export function parseSessionScreen(body: unknown): SessionScreen | null {
  const value = record(record(body)?.data);
  if (!value || !Array.isArray(value.sections)) return null;
  const sections: ScreenSection[] = [];
  for (const raw of value.sections) {
    const section = record(raw);
    if (!section || !Array.isArray(section.rows)) continue;
    const rows: ScreenRow[] = [];
    for (const rawRow of section.rows) {
      const row = record(rawRow);
      const label = text(row?.label);
      if (!row || !label) continue;
      rows.push({
        label,
        value: text(row.value),
        detail: text(row.detail),
        body: text(row.body),
        mono: row.mono === true,
        ...stopControl(row.control),
      });
    }
    sections.push({
      id: text(section.id) ?? String(sections.length),
      title: text(section.title) ?? "",
      unavailable: section.state === "unavailable",
      note: text(section.note),
      empty: text(section.empty),
      rows,
    });
  }
  return {
    title: text(value.title) ?? "",
    description: text(value.description) ?? "",
    sections,
  };
}

const CHANGE_KINDS: ReadonlySet<unknown> = new Set([
  "edit",
  "create",
  "delete",
  "move",
]);
const SIGNS: ReadonlySet<unknown> = new Set([" ", "+", "-"]);

export function parseFileChanges(body: unknown): FileChange[] | null {
  const list = record(body)?.data;
  if (!Array.isArray(list)) return null;
  const changes: FileChange[] = [];
  for (const raw of list) {
    const change = record(raw);
    const id = text(change?.id);
    const path = text(change?.path);
    if (!change || !id || !path || !CHANGE_KINDS.has(change.kind)) continue;
    const lines: FileChange["lines"] = [];
    for (const rawLine of Array.isArray(change.lines) ? change.lines : []) {
      const line = record(rawLine);
      if (line && SIGNS.has(line.sign) && typeof line.text === "string") {
        lines.push({ sign: line.sign as " " | "+" | "-", text: line.text });
      }
    }
    changes.push({
      id,
      path,
      kind: change.kind as FileChange["kind"],
      movedTo: text(change.moved_to),
      failed: change.failed === true,
      added: count(change.added),
      removed: count(change.removed),
      lines,
    });
  }
  return changes;
}

export function parseQueuedMessages(body: unknown): QueuedMessage[] | null {
  const list = record(body)?.data;
  if (!Array.isArray(list)) return null;
  const messages: QueuedMessage[] = [];
  for (const raw of list) {
    const message = record(raw);
    const messageId = text(message?.message_id);
    if (!message || !messageId || !UUID_RE.test(messageId)) continue;
    messages.push({
      messageId: messageId.toLowerCase(),
      body: typeof message.body === "string" ? message.body : "",
      createdAt: text(message.created_at) ?? "",
      idle: message.send_when === "idle",
    });
  }
  return messages;
}

/**
 * The "/" rows this client opens as views (a screen, or the files changed),
 * and the prompt rows it sends as typed (/review, /init). Rows the panel
 * already has (/model, /usage …), rows that go as text (/new) and rows this
 * session can't run are left to their own paths. The host lists no passkey
 * row to the Buzz app.
 */
export function parseSessionBuiltins(body: unknown): SessionBuiltins | null {
  const value = record(body);
  const session = record(value?.session);
  if (!value || !session || !Array.isArray(value.commands)) return null;
  const rows: SessionBuiltin[] = [];
  const prompts: SessionPromptRow[] = [];
  let clear: string | null = null;
  let branch: SessionBuiltins["branch"] = null;
  const seen = new Set<string>();
  for (const raw of value.commands) {
    const entry = record(raw);
    const action = record(entry?.action);
    const name = text(entry?.name);
    if (entry?.kind !== "session" || !action || !name) continue;
    if (!/^[a-z][a-z0-9-]{0,31}$/u.test(name) || seen.has(name)) continue;
    if (action.kind === "prompt") {
      seen.add(name);
      prompts.push({
        name,
        description: text(entry.description)?.slice(0, 300) ?? "",
        takesWords: action.takes_words === true,
      });
      continue;
    }
    if (name === "clear" && action.kind === "control") {
      seen.add(name);
      clear = text(entry.description)?.slice(0, 300) ?? "";
      continue;
    }
    if ((name === "branch" || name === "fork") && action.kind === "control") {
      seen.add(name);
      branch = {
        name,
        description: text(entry.description)?.slice(0, 300) ?? "",
      };
      continue;
    }
    const view: SessionView | null =
      action.kind === "screen" && isScreenName(action.screen)
        ? { kind: "screen", screen: action.screen }
        : action.kind === "panel" && action.panel === "diff"
          ? { kind: "files" }
          : action.kind === "panel" &&
              action.panel === "export" &&
              action.pending !== true
            ? { kind: "export" }
            : null;
    if (!view) continue;
    seen.add(name);
    rows.push({
      name,
      description: text(entry.description)?.slice(0, 300) ?? "",
      view,
    });
  }
  return {
    lane: session.lane === "tmux" ? "tmux" : "managed",
    rows,
    prompts,
    clear,
    branch,
  };
}

/** A whole message that names a listed view row, exactly `/name`. */
export function sessionBuiltinForText(
  builtins: SessionBuiltins | null,
  message: string,
): SessionBuiltin | null {
  const match = /^\/([a-z][a-z0-9-]{0,31})$/u.exec(message.trim());
  return (match && builtins?.rows.find((row) => row.name === match[1])) ?? null;
}

// ---- Paths (the Buzz mount; the desktop proxy allows exactly these) ----

export const sessionBuiltinsPath = (agentId: string) =>
  `agents/${agentId}/commands`;
export const sessionScreenPath = (agentId: string, screen: SessionScreenName) =>
  `agents/${agentId}/session/screens/${screen}`;
export const fileChangesPath = (agentId: string) =>
  `agents/${agentId}/session/file-changes`;
export const queuedPath = (agentId: string) =>
  `agents/${agentId}/session/queued`;
export const withdrawPath = (agentId: string, messageId: string) =>
  `agents/${agentId}/session/queued/${messageId}/withdraw`;
export const editPath = (agentId: string, messageId: string) =>
  `agents/${agentId}/session/queued/${messageId}/edit`;
export const interruptPath = (agentId: string) =>
  `agents/${agentId}/session/interrupt`;
export const stopTaskPath = (agentId: string, taskId: string) =>
  `agents/${agentId}/session/tasks/${taskId}/stop`;
export const activityPagePath = (agentId: string, before: string | null) =>
  `agents/${agentId}/session/activity${
    before ? `?before=${encodeURIComponent(before)}` : ""
  }`;

// ---- The store ----

type BuiltinsEntry = { builtins: SessionBuiltins | null; fetchedAt: number };

let builtins = new Map<string, BuiltinsEntry>();
let builtinReads = new Map<string, Promise<void>>();
let viewRequests = new Map<string, SessionView>();
let generation = 0;
let version = 0;
let now: () => number = () => Date.now();
const listeners = new Set<() => void>();

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeSessionViews(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSessionViewsVersion() {
  return version;
}

/** Test seam: replace the clock. Returns a restore function. */
export function setSessionViewsClockForTests(next: () => number) {
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

async function hostedAgentId(key: string): Promise<string> {
  await ensureAgentSummary(key);
  const id = cachedAgentSummary(key)?.agentId ?? null;
  if (!id || !UUID_RE.test(id)) {
    throw new AgentCallApiError(null, "agent_not_hosted");
  }
  return id.toLowerCase();
}

/** The session's "/" view rows and lane from the last read, or null. */
export function getSessionBuiltins(
  agentPublicKey: string,
): SessionBuiltins | null {
  const key = normalize(agentPublicKey);
  return key ? (builtins.get(key)?.builtins ?? null) : null;
}

/**
 * Read the session's built-ins unless a fresh answer (or failure) is cached
 * or in flight. A failure means no view rows, and no Interrupt.
 */
export function ensureSessionBuiltins(agentPublicKey: string): Promise<void> {
  const key = normalize(agentPublicKey);
  if (!key) return Promise.resolve();
  const cached = builtins.get(key);
  if (cached && now() - cached.fetchedAt < SESSION_BUILTINS_TTL_MS) {
    return Promise.resolve();
  }
  const pending = builtinReads.get(key);
  if (pending) return pending;
  const owner = generation;
  const read = (async () => {
    let next: SessionBuiltins | null = null;
    try {
      next = parseSessionBuiltins(
        await request<unknown>(
          "GET",
          sessionBuiltinsPath(await hostedAgentId(key)),
        ),
      );
    } catch {
      next = null;
    }
    if (owner !== generation) return;
    builtinReads.delete(key);
    builtins.set(key, { builtins: next, fetchedAt: now() });
    notify();
  })();
  builtinReads.set(key, read);
  return read;
}

/** Ask the DM header to open a view (from "/" or the panel). */
export function requestSessionView(agentPublicKey: string, view: SessionView) {
  const key = normalize(agentPublicKey);
  if (!key) return;
  viewRequests.set(key, view);
  notify();
}

/** The view asked for this agent, once. */
export function takeSessionViewRequest(
  agentPublicKey: string,
): SessionView | null {
  const key = normalize(agentPublicKey);
  const view = key ? (viewRequests.get(key) ?? null) : null;
  if (key) viewRequests.delete(key);
  return view;
}

/** Throws on a failed read; the caller keeps what showed and says so. */
export async function loadSessionScreen(
  agentPublicKey: string,
  screen: SessionScreenName,
): Promise<SessionScreen> {
  const key = normalize(agentPublicKey);
  if (!key) throw new AgentCallApiError(null, "agent_not_hosted");
  const read = parseSessionScreen(
    await request<unknown>(
      "GET",
      sessionScreenPath(await hostedAgentId(key), screen),
    ),
  );
  if (!read) throw new AgentCallApiError(null, "response_malformed");
  return read;
}

export async function loadFileChanges(
  agentPublicKey: string,
): Promise<FileChange[]> {
  const key = normalize(agentPublicKey);
  if (!key) throw new AgentCallApiError(null, "agent_not_hosted");
  const read = parseFileChanges(
    await request<unknown>("GET", fileChangesPath(await hostedAgentId(key))),
  );
  if (!read) throw new AgentCallApiError(null, "response_malformed");
  return read;
}

export async function loadQueuedMessages(
  agentPublicKey: string,
): Promise<QueuedMessage[]> {
  const key = normalize(agentPublicKey);
  if (!key) throw new AgentCallApiError(null, "agent_not_hosted");
  const read = parseQueuedMessages(
    await request<unknown>("GET", queuedPath(await hostedAgentId(key))),
  );
  if (!read) throw new AgentCallApiError(null, "response_malformed");
  return read;
}

/** Withdraw the reader's own queued message; it won't reach the session. */
export async function withdrawQueuedMessage(
  agentPublicKey: string,
  messageId: string,
): Promise<void> {
  const key = normalize(agentPublicKey);
  if (!key || !UUID_RE.test(messageId)) {
    throw new AgentCallApiError(null, "harness_session_message_not_found");
  }
  await request<unknown>(
    "POST",
    withdrawPath(await hostedAgentId(key), messageId.toLowerCase()),
    {},
  );
}

/**
 * Edit the reader's own queued message (BZ-QEDIT, 79 2026-11-05 D3): it is
 * replaced by `body`, as an edit in the apps. One key per Save, so a retry
 * of the same Save never sends twice. Throws when it was taken meanwhile.
 */
export async function editQueuedMessage(
  agentPublicKey: string,
  messageId: string,
  body: string,
  idempotencyKey: string,
): Promise<void> {
  const key = normalize(agentPublicKey);
  if (!key || !UUID_RE.test(messageId)) {
    throw new AgentCallApiError(null, "harness_session_message_not_found");
  }
  await request<unknown>(
    "POST",
    editPath(await hostedAgentId(key), messageId.toLowerCase()),
    { body, idempotency_key: idempotencyKey },
  );
}

/** Esc in the session's pane: the running step stops, the session stays. */
export async function interruptSession(agentPublicKey: string): Promise<void> {
  const key = normalize(agentPublicKey);
  if (!key) throw new AgentCallApiError(null, "agent_not_hosted");
  await request<unknown>("POST", interruptPath(await hostedAgentId(key)), {
    idempotency_key: newIdempotencyKey(),
  });
}

/** Ask the session to stop one background task. A request: it may take a turn. */
export async function stopSessionTask(
  agentPublicKey: string,
  taskId: string,
): Promise<void> {
  const key = normalize(agentPublicKey);
  if (!key) throw new AgentCallApiError(null, "agent_not_hosted");
  if (!TASK_ID_RE.test(taskId)) {
    throw new AgentCallApiError(null, "harness_session_task_id_invalid");
  }
  await request<unknown>(
    "POST",
    stopTaskPath(await hostedAgentId(key), taskId),
    {
      idempotency_key: newIdempotencyKey(),
    },
  );
}

/** One page of the conversation for /export, as the host sent it. */
export async function loadActivityPage(
  agentPublicKey: string,
  before: string | null,
): Promise<unknown> {
  const key = normalize(agentPublicKey);
  if (!key) throw new AgentCallApiError(null, "agent_not_hosted");
  return request<unknown>(
    "GET",
    activityPagePath(await hostedAgentId(key), before),
  );
}

/** A refused Stop in plain words. */
export function stopTaskErrorSentence(error: unknown): string {
  const code = error instanceof AgentCallApiError ? error.code : null;
  if (code === "session_taken_over") {
    return "This session is taken over at its machine, so stop it there.";
  }
  if (
    code === "harness_session_task_not_found" ||
    code === "harness_session_task_not_running"
  ) {
    return "That task isn't running any more.";
  }
  if (code === "harness_session_task_stop_unsupported") {
    return "This session can't stop one task on its own.";
  }
  return sessionViewErrorSentence(error);
}

/** A refusal in plain words. */
export function sessionViewErrorSentence(error: unknown): string {
  const code = error instanceof AgentCallApiError ? error.code : null;
  if (code === "session_not_found") {
    return "This conversation has no session to show right now.";
  }
  if (code === "session_taken_over") {
    return "This session is taken over at its machine, so Interrupt is there.";
  }
  if (
    code === "harness_session_message_not_found" ||
    code === "harness_session_message_not_editable"
  ) {
    return "That message isn't waiting any more.";
  }
  if (code === "harness_session_message_invalid") {
    return "A message can't be empty.";
  }
  if (
    code === "session_export_incomplete" ||
    code === "session_export_page_too_large"
  ) {
    return "Couldn't read the whole conversation, so nothing was exported.";
  }
  return "Couldn't reach the session. Try again.";
}

/** Clears every cached read and request, and retires reads in flight. */
export function resetSessionViewsCache() {
  generation += 1;
  builtins = new Map();
  builtinReads = new Map();
  viewRequests = new Map();
  notify();
}

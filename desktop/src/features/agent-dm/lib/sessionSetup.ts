import {
  AgentCallApiError,
  newIdempotencyKey,
  request,
} from "@/features/agent-call/lib/agentCallApi";

import { cachedAgentSummary, ensureAgentSummary } from "./agentSummary";

/**
 * The reader's session with a hosted agent, for a 1:1 DM: what runs it, what
 * they may change, and how full it is. From the host's
 * `GET /agents/<id>/session-setup` on the Buzz mount, the same panel and the
 * same picks as the agent's chat in the other apps. Vitals come only for the
 * session's owner. A change applies from the next turn.
 *
 * An agent this device runs itself has no host, so its panel stays null and
 * none of this shows. Community-scoped: `resetSessionSetupCache()` runs in
 * resetCommunityState().
 */

/** How long an answer is reused; the DM header re-asks on a slower beat. */
export const SESSION_SETUP_TTL_MS = 30_000;

const HEX64_RE = /^[0-9a-f]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionSetupModel = {
  id: string;
  label: string;
  efforts: string[];
};

export type UsageWindow = {
  label: string;
  remainingPercent: number;
  resetsAt: string | null;
};

export type SessionVitals = {
  accountAlias: string | null;
  usageStale: boolean;
  usage: UsageWindow[];
  context: {
    tokens: number;
    window: number | null;
    percent: number | null;
  } | null;
  todos: {
    total: number;
    completed: number;
    current: string | null;
  } | null;
  costUsd: number | null;
  branch: string | null;
  folder: string | null;
  /** The worktree's name, when the session's folder is in a worktree home. */
  worktree: string | null;
};

/**
 * One speed the session's model offers (the host's `options`), Standard first.
 * `available` false: a fresh check says it isn't on the reader's plan. The
 * cost words are the host's.
 */
export type SessionSpeedOption = {
  id: string;
  label: string | null;
  available: boolean | null;
  unavailableReason: string | null;
  costHint: string | null;
};

/**
 * One way the session may work (the host's `options.modes`, widest first):
 * Full, Accept edits, Ask or Plan, in the host's words. Only the host decides
 * which can run; this client offers just the ones it marks available.
 */
export type SessionModeOption = {
  id: string;
  label: string;
  description: string;
  available: boolean;
  /** `use_terminal_mode`: a terminal session keeps its own mode. */
  unavailableReason: string | null;
};

export type SessionSetupPanel = {
  revision: number;
  model: string;
  effort: string;
  /** The session's mode now (`ceiling`, Full, when none is picked). */
  mode: string | null;
  /** In Plan: the mode an approved plan returns to. */
  modeBeforePlan: string | null;
  /** Server-rendered: "Claude Code · Opus 5.5 · High". */
  label: string;
  models: SessionSetupModel[];
  effortLabels: Record<string, string>;
  canChangeModel: boolean;
  canChangeEffort: boolean;
  /** What it runs at now; `standard` from a host that has no speeds. */
  speed: string;
  /** The current model's speeds, else the harness's. */
  speeds: SessionSpeedOption[];
  speedLabels: Record<string, string>;
  canChangeSpeed: boolean;
  /** The pick is kept but doesn't run as chosen. */
  speedNote: { chosen: string; runsAt: string; reason: string | null } | null;
  /** Empty from a host that has no modes. */
  modes: SessionModeOption[];
  canChangeMode: boolean;
  vitals: SessionVitals | null;
};

const STANDARD_SPEED = "standard";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseUsage(usage: Record<string, unknown> | null): UsageWindow[] {
  if (!usage) return [];
  return (
    [
      ["5h", usage.five_hour],
      ["7d", usage.seven_day],
      ["Opus 7d", usage.seven_day_opus],
      ["Sonnet 7d", usage.seven_day_sonnet],
    ] as const
  ).flatMap(([label, raw]) => {
    const window = record(raw);
    const remainingPercent = finite(window?.remaining_percent);
    return remainingPercent === null
      ? []
      : [{ label, remainingPercent, resetsAt: text(window?.resets_at) }];
  });
}

function parseVitals(body: unknown): SessionVitals | null {
  const root = record(body);
  if (!root) return null;
  const usage = record(root.account_usage);
  const context = record(root.context);
  const todos = record(root.todos);
  const location = record(root.location);
  const cost = record(root.cost);
  const tokens = finite(context?.tokens);
  const total = finite(todos?.total);
  const items = Array.isArray(todos?.items) ? todos.items.map(record) : [];
  const current =
    items.find((item) => item?.status === "in_progress") ??
    items.find((item) => item?.status === "pending") ??
    null;
  const cwd = text(location?.cwd);
  return {
    accountAlias: text(usage?.account_alias),
    usageStale: usage !== null && usage.freshness !== "fresh",
    usage: parseUsage(usage),
    context:
      tokens !== null && tokens > 0
        ? {
            tokens,
            window: finite(context?.window),
            percent: finite(context?.percent),
          }
        : null,
    todos:
      total !== null && total > 0
        ? {
            total,
            completed: finite(todos?.completed) ?? 0,
            current: text(current?.text),
          }
        : null,
    costUsd: finite(cost?.usd),
    branch: text(location?.branch),
    folder: cwd ? (cwd.replace(/\/+$/u, "").split("/").pop() ?? null) : null,
    worktree: text(location?.worktree),
  };
}

/** A list of speeds, or null when absent; an unreadable one is left out. */
function parseSpeeds(value: unknown): SessionSpeedOption[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((raw): SessionSpeedOption[] => {
    const option = record(raw);
    const id = text(raw) ?? text(option?.id);
    if (!id) return [];
    return [
      {
        id,
        label: text(option?.label),
        available:
          typeof option?.available === "boolean" ? option.available : null,
        unavailableReason: text(option?.unavailableReason),
        costHint: text(option?.costHint),
      },
    ];
  });
}

function parseSpeedNote(value: unknown): SessionSetupPanel["speedNote"] {
  const note = record(value);
  const chosen = text(note?.chosen);
  const runsAt = text(note?.runsAt);
  return chosen && runsAt && chosen !== runsAt
    ? { chosen, runsAt, reason: text(note?.reason) }
    : null;
}

/** The panel, or null when the body is not that contract. */
export function parseSessionSetupPanel(
  body: unknown,
): SessionSetupPanel | null {
  const root = record(body);
  const current = record(root?.current);
  const options = record(root?.options);
  const canChange = record(root?.canChange);
  const harness = text(current?.harness);
  const model = text(current?.model);
  const effort = text(current?.effort);
  const label = text(current?.label);
  const revision = finite(current?.revision);
  if (!harness || !model || !effort || !label || revision === null) return null;
  const harnesses = Array.isArray(options?.harnesses) ? options.harnesses : [];
  const entry = harnesses
    .map(record)
    .find((candidate) => candidate?.id === harness);
  const models = (Array.isArray(entry?.models) ? entry.models : []).flatMap(
    (raw) => {
      const option = record(raw);
      const id = text(option?.id);
      if (!id) return [];
      return [
        {
          id,
          label: text(option?.label) ?? id,
          efforts: Array.isArray(option?.efforts)
            ? option.efforts.flatMap((value) => {
                const name = text(value);
                return name ? [name] : [];
              })
            : [],
        },
      ];
    },
  );
  const rawLabels = record(options?.effortLabels) ?? {};
  const effortLabels: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawLabels)) {
    const name = text(value);
    if (name) effortLabels[key] = name;
  }
  const currentModel = (Array.isArray(entry?.models) ? entry.models : [])
    .map(record)
    .find((candidate) => candidate?.id === model);
  const speedLabels: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    record(options?.speedLabels) ?? {},
  )) {
    const name = text(value);
    if (name) speedLabels[key] = name;
  }
  const modes = (Array.isArray(options?.modes) ? options.modes : []).flatMap(
    (raw): SessionModeOption[] => {
      const option = record(raw);
      const id = text(option?.id);
      if (!id) return [];
      return [
        {
          id,
          label: text(option?.label) ?? id,
          description: text(option?.description) ?? "",
          available: option?.available === true,
          unavailableReason: text(option?.unavailableReason),
        },
      ];
    },
  );
  return {
    revision,
    model,
    effort,
    mode: text(current?.mode),
    modeBeforePlan: text(current?.modeBeforePlan),
    label,
    models,
    effortLabels,
    canChangeModel: canChange?.model === true,
    canChangeEffort: canChange?.effort === true,
    speed: text(current?.speed) ?? STANDARD_SPEED,
    speeds:
      parseSpeeds(currentModel?.speeds) ?? parseSpeeds(entry?.speeds) ?? [],
    speedLabels,
    canChangeSpeed: canChange?.speed === true,
    speedNote: parseSpeedNote(current?.speedNote),
    modes,
    canChangeMode: canChange?.mode === true && modes.length > 0,
    vitals: parseVitals(root?.vitals),
  };
}

function tokenCount(count: number): string {
  if (count >= 1_000_000) {
    const value = count / 1_000_000;
    return value >= 10 ? `${Math.round(value)}M` : `${value.toFixed(1)}M`;
  }
  return count >= 1_000 ? `${Math.round(count / 1_000)}k` : String(count);
}

function usageLine(window: UsageWindow, now: Date): string {
  const left = `${window.label} ${Math.round(window.remainingPercent)}% left`;
  const resets = window.resetsAt ? new Date(window.resetsAt) : null;
  if (!resets || Number.isNaN(resets.getTime()) || resets <= now) return left;
  const time = resets.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const when =
    resets.toDateString() === now.toDateString()
      ? time
      : `${resets.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${left} · resets ${when}`;
}

/** The context line: "Context 25% · 50k of 200k". */
export function contextLine(context: NonNullable<SessionVitals["context"]>) {
  return context.window && context.percent !== null
    ? `Context ${Math.round(context.percent)}% · ${tokenCount(context.tokens)} of ${tokenCount(context.window)}`
    : `Context ${tokenCount(context.tokens)}`;
}

/** The vitals in words, the same lines as the agent's chat in the other apps. */
export function vitalsLines(
  vitals: SessionVitals,
  now: Date = new Date(),
): string[] {
  const lines: string[] = [];
  if (vitals.accountAlias) {
    lines.push(
      vitals.usageStale
        ? `${vitals.accountAlias} (may be out of date)`
        : vitals.accountAlias,
    );
  }
  for (const window of vitals.usage) lines.push(usageLine(window, now));
  if (vitals.context) lines.push(contextLine(vitals.context));
  if (vitals.todos) {
    lines.push(`Todos ${vitals.todos.completed} of ${vitals.todos.total}`);
    if (vitals.todos.current) lines.push(vitals.todos.current);
  }
  if (vitals.costUsd !== null) {
    lines.push(
      vitals.costUsd < 0.01
        ? "Est. under $0.01"
        : `Est. $${vitals.costUsd.toFixed(2)}`,
    );
  }
  const place = [
    vitals.worktree === vitals.folder ? null : vitals.folder,
    vitals.branch,
    vitals.worktree ? `worktree ${vitals.worktree}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (place) lines.push(place);
  return lines;
}

/** The short line for the DM header: the label, and how full the context is. */
export function setupChipText(panel: SessionSetupPanel): string {
  const percent = panel.vitals?.context?.percent;
  return typeof percent === "number"
    ? `${panel.label} · ${Math.round(percent)}%`
    : panel.label;
}

export function effortLabel(panel: SessionSetupPanel, effort: string): string {
  return panel.effortLabels[effort] ?? effort;
}

/** The modes the host says this session can run: the only ones offered. */
export function availableModes(panel: SessionSetupPanel): SessionModeOption[] {
  return panel.modes.filter((mode) => mode.available);
}

/**
 * The words under the mode picks, from the host's own list: what the current
 * mode does, where an approved plan returns, and what this harness lacks. A
 * terminal session keeps its own mode, so it says where to change it.
 */
export function modeNote(panel: SessionSetupPanel): string | null {
  if (
    panel.modes.some((mode) => mode.unavailableReason === "use_terminal_mode")
  ) {
    return "This terminal session keeps its own mode. Change it in the terminal.";
  }
  const current = panel.modes.find((mode) => mode.id === panel.mode);
  if (!current) return null;
  const returnsTo = panel.modes.find(
    (mode) => mode.id === panel.modeBeforePlan,
  )?.label;
  const missing = panel.modes.filter((mode) => !mode.available);
  return [
    current.description ? `${current.label}: ${current.description}.` : null,
    returnsTo ? `An approved plan returns to ${returnsTo}.` : null,
    missing.length > 0
      ? `${missing.map((mode) => mode.label).join(", ")} isn't available on this harness.`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

/** The levels the current model allows, low to high. */
export function currentModelEfforts(panel: SessionSetupPanel): string[] {
  return panel.models.find((model) => model.id === panel.model)?.efforts ?? [];
}

// ---- Speed ----

export function speedLabel(panel: SessionSetupPanel, id: string): string {
  const named =
    panel.speedLabels[id] ??
    panel.speeds.find((option) => option.id === id)?.label;
  return named ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

export type SpeedRow = {
  id: string;
  label: string;
  selected: boolean;
  /** Why it can't be picked. */
  note: string | null;
};

/** The speeds to offer; none unless the host lists a choice of them. */
export function speedRows(panel: SessionSetupPanel): SpeedRow[] {
  if (panel.speeds.length < 2) return [];
  return panel.speeds.map((option) => ({
    id: option.id,
    label: speedLabel(panel, option.id),
    selected: option.id === panel.speed,
    note:
      option.available === false && option.id !== panel.speed
        ? option.unavailableReason === "not_on_your_plan"
          ? "Not on your plan"
          : "Not available"
        : null,
  }));
}

function speedNoteLine(panel: SessionSetupPanel): string | null {
  const note = panel.speedNote;
  if (!note) return null;
  const chosen = speedLabel(panel, note.chosen);
  const why =
    note.reason === "not_on_your_plan"
      ? `${chosen} isn't on your plan.`
      : note.reason === "model"
        ? `this model doesn't offer ${chosen}.`
        : note.reason === "payer"
          ? `${chosen} isn't allowed on this session's plan.`
          : `${chosen} isn't available.`;
  return `Runs at ${speedLabel(panel, note.runsAt)}: ${why}`;
}

/** Under the speeds: why the pick runs slower, and what the speed costs. */
export function speedFooter(panel: SessionSetupPanel): string | null {
  if (speedRows(panel).length === 0) return null;
  const selected = panel.speeds.find((option) => option.id === panel.speed);
  const dearer = panel.speeds.find((option) => option.costHint)?.costHint;
  const hint =
    selected?.costHint ??
    (panel.speed !== STANDARD_SPEED
      ? `${speedLabel(panel, panel.speed)} uses more of your plan than Standard.`
      : dearer
        ? `Faster speeds answer sooner. ${dearer}`
        : "Faster speeds answer sooner and use more of your plan.");
  return [speedNoteLine(panel), hint].filter(Boolean).join(" ");
}

/** A pick that can be made: `null` is Standard, the host's own default. */
function speedPick(panel: SessionSetupPanel, id: string): SetupArg {
  const row = speedRows(panel).find((candidate) => candidate.id === id);
  if (!row || row.note) return "ask";
  return { pick: id === STANDARD_SPEED ? null : id };
}

/** What `/speed <arg>` names; several, none or a refused one opens the panel. */
export function resolveSpeedArg(
  panel: SessionSetupPanel,
  arg: string,
): SetupArg {
  const named = matchArg(
    arg,
    speedRows(panel).map(({ id, label }) => ({ id, label })),
  );
  return named === "ask" || named.pick === null
    ? named
    : speedPick(panel, named.pick);
}

/** `/fast`: Standard to Fast, anything else back to Standard. */
export function fastToggleArg(panel: SessionSetupPanel): SetupArg {
  return speedPick(
    panel,
    panel.speed === STANDARD_SPEED ? "fast" : STANDARD_SPEED,
  );
}

/** The words for a speed pick; a null pick is Standard. */
export function speedPickLabel(panel: SessionSetupPanel, pick: string | null) {
  return speedLabel(panel, pick ?? STANDARD_SPEED);
}

/**
 * Whether a typed session command is this session's: `/speed` and `/fast` only
 * where the host lists a choice of speeds, so elsewhere they stay ordinary
 * messages (a skill of that name still runs).
 */
export function setupCommandApplies(
  panel: SessionSetupPanel,
  command: SetupCommand,
): boolean {
  return (
    (command.name !== "speed" && command.name !== "fast") ||
    speedRows(panel).length > 0
  );
}

// ---- Typed commands ----

export const SETUP_VIEW_COMMANDS = [
  "status",
  "usage",
  "context",
  "cost",
] as const;

export type SetupCommand =
  | { name: "model" | "effort" | "speed"; arg: string | null }
  | { name: "fast"; arg: null }
  | { name: (typeof SETUP_VIEW_COMMANDS)[number]; arg: null };

/**
 * A whole message that is a session command: `/model`, `/model <name>`,
 * `/effort`, `/effort <level>`, `/speed`, `/speed <speed>`, `/fast`,
 * `/status`, `/usage`, `/context` or `/cost`.
 * Anything else is an ordinary message, like the session commands the server
 * reads.
 */
export function parseSetupCommand(message: string): SetupCommand | null {
  const match = /^\/([a-z]+)(?:\s+(\S.*))?$/u.exec(message.trim());
  const name = match?.[1];
  const arg = match?.[2]?.trim() ?? null;
  if (name === "model" || name === "effort" || name === "speed") {
    return { name, arg };
  }
  if (name === "fast") return arg ? null : { name, arg: null };
  if ((SETUP_VIEW_COMMANDS as readonly string[]).includes(name ?? "")) {
    return arg
      ? null
      : { name: name as (typeof SETUP_VIEW_COMMANDS)[number], arg: null };
  }
  return null;
}

/** A pick: an id, or null for the default. */
export type SetupArg = { pick: string | null } | "ask";

function matchArg(
  arg: string,
  options: readonly { id: string; label: string }[],
): SetupArg {
  const needle = arg.trim().toLowerCase();
  if (needle === "default") return { pick: null };
  const exact = options.find(
    (option) =>
      option.id.toLowerCase() === needle ||
      option.label.toLowerCase() === needle,
  );
  if (exact) return { pick: exact.id };
  const partial = options.filter(
    (option) =>
      option.id.toLowerCase().includes(needle) ||
      option.label.toLowerCase().includes(needle),
  );
  const [only] = partial;
  return partial.length === 1 && only ? { pick: only.id } : "ask";
}

/** What `/model <arg>` names; several or none opens the picker instead. */
export function resolveModelArg(
  panel: SessionSetupPanel,
  arg: string,
): SetupArg {
  return matchArg(arg, panel.models);
}

/** What `/effort <arg>` names among the current model's levels. */
export function resolveEffortArg(
  panel: SessionSetupPanel,
  arg: string,
): SetupArg {
  return matchArg(
    arg,
    currentModelEfforts(panel).map((id) => ({
      id,
      label: effortLabel(panel, id),
    })),
  );
}

// ---- The list "/" shows ----

const SETUP_COMMAND_DESCRIPTIONS: Record<SetupCommand["name"], string> = {
  model: "Choose the model for this session.",
  effort: "Choose the reasoning level for this session.",
  speed: "Choose the speed for this session.",
  fast: "Switch this session between Standard and Fast.",
  status: "Show this session's model, limits and context.",
  usage: "Show this account's limits.",
  context: "Show how full this session's context is.",
  cost: "Show what this session has used so far.",
};

/** The session commands a panel offers, in menu order. */
export function setupCommandEntries(
  panel: SessionSetupPanel,
): { name: SetupCommand["name"]; description: string }[] {
  const names: SetupCommand["name"][] = [
    ...(panel.canChangeModel ? (["model"] as const) : []),
    ...(panel.canChangeEffort ? (["effort"] as const) : []),
    ...(panel.canChangeSpeed && speedRows(panel).length > 0
      ? (["speed", "fast"] as const)
      : []),
    ...SETUP_VIEW_COMMANDS,
  ];
  return names.map((name) => ({
    name,
    description: SETUP_COMMAND_DESCRIPTIONS[name],
  }));
}

// ---- The store ----

type Entry = { panel: SessionSetupPanel | null; fetchedAt: number };

let entries = new Map<string, Entry>();
let inflight = new Map<string, Promise<void>>();
/** Bumped by a committed change, so a read begun before it can't undo it. */
let changeEpochs = new Map<string, number>();
let pickerRequests = new Set<string>();
let generation = 0;
let version = 0;
let now: () => number = () => Date.now();
const listeners = new Set<() => void>();

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

function normalize(agentPublicKey: string): string | null {
  const key = agentPublicKey.trim().toLowerCase();
  return HEX64_RE.test(key) ? key : null;
}

/** Test seam: replace the clock. Returns a restore function. */
export function setSessionSetupClockForTests(next: () => number) {
  const previous = now;
  now = next;
  return () => {
    now = previous;
  };
}

/** The agent's id on its host, from its summary; null when it has no host. */
async function hostedAgentId(key: string): Promise<string | null> {
  await ensureAgentSummary(key);
  const id = cachedAgentSummary(key)?.agentId ?? null;
  return id && UUID_RE.test(id) ? id.toLowerCase() : null;
}

export function getSessionSetup(
  agentPublicKey: string,
): SessionSetupPanel | null {
  const key = normalize(agentPublicKey);
  return key ? (entries.get(key)?.panel ?? null) : null;
}

/**
 * Read the panel unless a fresh answer (or failure) is cached or in flight.
 * Any failure means no panel; the next ask after the TTL tries again.
 */
export function ensureSessionSetup(agentPublicKey: string): Promise<void> {
  const key = normalize(agentPublicKey);
  if (!key) return Promise.resolve();
  const cached = entries.get(key);
  if (cached && now() - cached.fetchedAt < SESSION_SETUP_TTL_MS) {
    return Promise.resolve();
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const owner = generation;
  const epoch = changeEpochs.get(key) ?? 0;
  const read = (async () => {
    let panel: SessionSetupPanel | null = null;
    try {
      const agentId = await hostedAgentId(key);
      panel = agentId
        ? parseSessionSetupPanel(
            await request<unknown>("GET", `agents/${agentId}/session-setup`),
          )
        : null;
    } catch {
      panel = null;
    }
    // A community switch while the read was in flight retires its answer.
    if (owner !== generation) return;
    inflight.delete(key);
    if ((changeEpochs.get(key) ?? 0) !== epoch) return;
    entries.set(key, { panel, fetchedAt: now() });
    notify();
  })();
  inflight.set(key, read);
  return read;
}

export function subscribeSessionSetup(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSessionSetupVersion() {
  return version;
}

/** Ask the DM header to open its panel (from `/model` and friends). */
export function requestSetupPicker(agentPublicKey: string) {
  const key = normalize(agentPublicKey);
  if (!key) return;
  pickerRequests.add(key);
  notify();
}

/** Whether a panel open was asked for this agent; it counts once. */
export function takeSetupPickerRequest(agentPublicKey: string): boolean {
  const key = normalize(agentPublicKey);
  return key ? pickerRequests.delete(key) : false;
}

export type SetupChoice = {
  model?: string | null;
  effort?: string | null;
  /** Null is Standard. */
  speed?: string | null;
  /** Sent only on an explicit pick; the host refuses a mode it won't run. */
  mode?: string;
};

const CHANGE_ERROR_SENTENCES: Record<string, string> = {
  session_setup_revision_conflict:
    "This session's setup just changed. Look at it again and choose.",
  session_setup_model_not_allowed: "That model isn't available here.",
  session_setup_effort_not_allowed:
    "That level isn't available for this model.",
  session_setup_forbidden: "You can't change this session's setup.",
  session_setup_off: "Choosing a model isn't available for this agent.",
  session_setup_not_supported:
    "Choosing a model isn't available for this agent.",
  session_setup_mode_not_supported: "This session can't run that mode.",
  session_setup_speed_not_allowed: "That speed isn't available for this model.",
  session_setup_speed_unavailable: "That speed isn't on your plan.",
};

/** The plain sentence for a failed change. */
export function setupChangeErrorSentence(error: unknown): string {
  const code = error instanceof AgentCallApiError ? error.code : null;
  return (
    (code && CHANGE_ERROR_SENTENCES[code]) ??
    "Couldn't change this session's setup. Try again."
  );
}

/**
 * Change the model, effort or mode; it applies from the next turn. Throws
 * when the host refuses (`setupChangeErrorSentence`); a revision conflict
 * re-reads the panel first, so what shows is current.
 */
export async function changeSessionSetup(
  agentPublicKey: string,
  choice: SetupChoice,
): Promise<SessionSetupPanel> {
  const key = normalize(agentPublicKey);
  const agentId = key ? await hostedAgentId(key) : null;
  const before = key ? getSessionSetup(key) : null;
  if (!key || !agentId) {
    throw new AgentCallApiError(null, "session_setup_not_supported");
  }
  const owner = generation;
  try {
    const answer = await request<{ setup?: unknown }>(
      "PUT",
      `agents/${agentId}/session-setup`,
      {
        choice,
        ...(before ? { expectedRevision: before.revision } : {}),
        idempotencyKey: newIdempotencyKey(),
      },
    );
    const panel = parseSessionSetupPanel(answer?.setup);
    if (!panel) throw new AgentCallApiError(null, "response_malformed");
    if (owner === generation) {
      changeEpochs.set(key, (changeEpochs.get(key) ?? 0) + 1);
      entries.set(key, { panel, fetchedAt: now() });
      notify();
    }
    return panel;
  } catch (error) {
    if (
      owner === generation &&
      error instanceof AgentCallApiError &&
      error.code === "session_setup_revision_conflict"
    ) {
      entries.delete(key);
      void ensureSessionSetup(key);
    }
    throw error;
  }
}

export type StopOutcome = "stopping" | "stopped" | "not_running";

/**
 * Stop the agent's running turn in the reader's own conversation: the
 * requester's stop, the same route as the Stop in the other apps. The session
 * stays.
 */
export async function stopAgentDmTurn(
  agentPublicKey: string,
): Promise<StopOutcome> {
  const key = normalize(agentPublicKey);
  const agentId = key ? await hostedAgentId(key) : null;
  if (!agentId) throw new AgentCallApiError(null, "agent_not_hosted");
  const answer = await request<{ state?: unknown }>(
    "POST",
    `agents/${agentId}/chat/stop`,
    { idempotencyKey: newIdempotencyKey() },
  );
  return answer?.state === "stopping" || answer?.state === "stopped"
    ? answer.state
    : "not_running";
}

/** Clears every cached panel and retires in-flight reads. */
export function resetSessionSetupCache() {
  generation += 1;
  entries = new Map();
  inflight = new Map();
  changeEpochs = new Map();
  pickerRequests = new Set();
  notify();
}

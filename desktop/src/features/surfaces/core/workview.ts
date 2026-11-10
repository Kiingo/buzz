// Generated from the Kiingo surface renderer packages at 1055d96f74fb6ac27bf0ebcd3c7fa12aee50be9c; do not edit here.
import { asNumber, asString, isObject } from "./json";
import type { Tone } from "./model";
import type { TreeNode } from "./outline";
import { plainText } from "./text";

// WorkView (GENUI-WORKVIEW, 2026-11-05): the shared reading of a worker
// tree for every renderer. The card names a task or an orchestration chat;
// the host reads the tree through the viewer's own session with the
// existing owner-only delegation reads (404 to anyone but the agent's
// owner) and hands the raw JSON here. Nothing here loads anything. The
// Swift kit mirrors it (`UiWorkView` in KiingoMobileCore).
//
// Reads:
// - task:   GET /api/voice/tasks/:taskId/sessions/tree  (ITaskSessionsTree)
// - thread: GET /api/voice/agents/:agentId/delegations?threadId=&includeFinished=true
//           (IDelegationCardsPage)

/**
 * Re-read while any worker is queued, running or waiting: the iPhone task
 * tree model's interval (AgentTaskSessionsTreeModel and the web's tree: 10 s).
 */
export const WORK_VIEW_POLL_MS = 10_000;

/**
 * A chat's cards re-read with the last `rev` waits this long for a change
 * (the cards long-poll's `wait`, within DELEGATION_CARDS_MAX_WAIT_SEC): one
 * poll interval, so the cadence stays WORK_VIEW_POLL_MS and an unchanged
 * page comes back as `unchanged`, with no card or Run work on the server.
 */
export const WORK_VIEW_WAIT_SEC = WORK_VIEW_POLL_MS / 1000;

export type WorkViewSource =
  | { kind: "task"; taskId: string }
  | { kind: "thread"; threadId: string; agentId: string };

export type WorkStatus =
  | "queued"
  | "running"
  | "waiting"
  | "idle"
  | "done"
  | "failed"
  | "stopped";

export type WorkNode = {
  /** Stable row key: the delegation id, else the session id. */
  id: string;
  title: string;
  role?: "orchestrator" | "worker" | "reviewer" | "attached";
  agentId?: string;
  agentName?: string;
  harness?: string;
  harnessLabel?: string;
  status: WorkStatus;
  /** Running but the stall sweep flagged it. */
  stalled: boolean;
  /** The latest progress line, plain text. */
  lastLine?: string;
  /** Seconds run as the server counted them when read. */
  elapsedSeconds?: number;
  /** The worker's session: tapping opens it. None yet: not tappable. */
  sessionId?: string;
  /**
   * The Run this worker's harness run belongs to: the server sends it only
   * where the viewer's own Run read (`/api/agents/:agentId/sessions/:runId`)
   * would open it. Absent says nothing about whether a Run exists.
   */
  run?: WorkRunRef;
  children: WorkNode[];
};

export type WorkRunRef = {
  runId: string;
  agentId: string;
};

export type WorkViewModel = {
  title?: string;
  /** A chat's cards page `rev`: the next read sends it back (thread only). */
  rev?: string;
  nodes: WorkNode[];
  /** Any node queued, running or waiting: keep re-reading. */
  active: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuidOf = (value: unknown): string | undefined =>
  typeof value === "string" && UUID.test(value)
    ? value.toLowerCase()
    : undefined;

/**
 * What the card asks to read; undefined when the props name nothing
 * readable (the renderer shows the fallback row). `surfaceAgentId` is the
 * surface's own agent, the default for a thread.
 */
export const workViewSource = (
  props: Record<string, unknown>,
  surfaceAgentId: string | undefined,
): WorkViewSource | undefined => {
  const taskId = uuidOf(props.taskId);
  const threadId = uuidOf(props.threadId);
  if (taskId && !threadId) {
    return { kind: "task", taskId };
  }
  const agentId = uuidOf(props.agentId) ?? uuidOf(surfaceAgentId);
  if (threadId && !taskId && agentId) {
    return { kind: "thread", threadId, agentId };
  }
  return undefined;
};

/** The API path for a source, under the API origin's `/api`. */
export const workViewPath = (source: WorkViewSource): string =>
  source.kind === "task"
    ? `/api/voice/tasks/${encodeURIComponent(source.taskId)}/sessions/tree`
    : `/api/voice/agents/${encodeURIComponent(source.agentId)}/delegations?threadId=${encodeURIComponent(source.threadId)}&includeFinished=true`;

const HARNESS_LABELS: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  antigravity: "Antigravity",
};

export const workHarnessLabel = (
  harness: string | undefined,
): string | undefined =>
  harness ? (HARNESS_LABELS[harness] ?? undefined) : undefined;

export const WORK_STATUS_LABELS: Record<WorkStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting on you",
  idle: "Idle",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

export const workStatusTone = (
  node: Pick<WorkNode, "status" | "stalled">,
): Tone => {
  switch (node.status) {
    case "waiting":
      return "warning";
    case "running":
      return node.stalled ? "warning" : "default";
    case "done":
      return "success";
    case "failed":
      return "danger";
    default:
      return "muted";
  }
};

export const workStatusLabel = (
  node: Pick<WorkNode, "status" | "stalled">,
): string =>
  node.status === "running" && node.stalled
    ? "Running · stalled"
    : WORK_STATUS_LABELS[node.status];

const ACTIVE = new Set<WorkStatus>(["queued", "running", "waiting"]);

export const isWorkActive = (status: WorkStatus): boolean => ACTIVE.has(status);

/** A delegation card's status (IDelegationCard). */
const cardStatus = (card: Record<string, unknown>): WorkStatus => {
  const state = asString(card.state);
  const asks = asNumber(card.pendingAsksCount) ?? 0;
  switch (state) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    case "needs_input":
      return "waiting";
    case "queued":
      return asks > 0 ? "waiting" : "queued";
    default:
      // running and blocked: the worker still holds the work.
      return asks > 0 ? "waiting" : "running";
  }
};

/** A catalog session's status when no delegation backs the node. */
const sessionStatus = (status: string | undefined): WorkStatus => {
  switch (status) {
    case "active":
      return "running";
    case "idle":
      return "idle";
    default:
      return "done";
  }
};

const ROLES = new Set(["orchestrator", "worker", "reviewer", "attached"]);

const textOf = (value: unknown, max: number): string | undefined => {
  const text = plainText(value, max);
  return text && text.trim() ? text.trim() : undefined;
};

const secondsOf = (value: unknown): number | undefined => {
  const n = asNumber(value);
  return n !== undefined && Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : undefined;
};

/** A node's or card's `run` (ITaskSessionTreeRun), when it names one. */
const runRef = (raw: unknown): WorkRunRef | undefined => {
  if (!isObject(raw)) {
    return undefined;
  }
  const runId = uuidOf(raw.runId);
  const agentId = uuidOf(raw.agentId);
  return runId && agentId ? { runId, agentId } : undefined;
};

const cardNode = (
  card: Record<string, unknown>,
  extra: Partial<WorkNode>,
): WorkNode => {
  const harness = asString(card.harness) ?? extra.harness;
  const run = extra.run ?? runRef(card.run);
  return {
    ...(run ? { run } : {}),
    id: uuidOf(card.delegationId) ?? extra.id ?? "",
    title: textOf(card.title, 200) ?? extra.title ?? "Worker",
    role: extra.role,
    agentId: extra.agentId,
    agentName: extra.agentName,
    harness,
    harnessLabel: workHarnessLabel(harness),
    status: cardStatus(card),
    stalled: card.stalled === true,
    lastLine: textOf(card.lastProgressLine, 280),
    elapsedSeconds: secondsOf(card.elapsedSeconds),
    sessionId: uuidOf(card.workerSessionId) ?? extra.sessionId,
    children: [],
  };
};

const treeNode = (raw: unknown, depth: number): WorkNode | undefined => {
  if (!isObject(raw) || depth > 32) {
    return undefined;
  }
  const link = isObject(raw.link) ? raw.link : {};
  const session = isObject(raw.session) ? raw.session : undefined;
  const sessionId = uuidOf(session?.id) ?? uuidOf(link.sessionId);
  const role = asString(raw.role);
  const harness = asString(session?.harness);
  const run = runRef(raw.run);
  const base: Partial<WorkNode> = {
    ...(run ? { run } : {}),
    id: sessionId,
    title:
      textOf(session?.title, 200) ??
      (sessionId ? `Session ${sessionId.slice(0, 8)}` : undefined),
    role: role && ROLES.has(role) ? (role as WorkNode["role"]) : undefined,
    agentId: uuidOf(link.agentId),
    harness,
    sessionId: session ? sessionId : undefined,
  };
  const node: WorkNode = isObject(raw.delegation)
    ? cardNode(raw.delegation, base)
    : {
        id: base.id ?? "",
        title: base.title ?? "Session",
        role: base.role,
        agentId: base.agentId,
        harness,
        harnessLabel: workHarnessLabel(harness),
        status:
          asString(link.state) === "ended" ||
          asString(link.state) === "detached"
            ? "done"
            : sessionStatus(asString(session?.status)),
        stalled: false,
        sessionId: base.sessionId,
        ...(run ? { run } : {}),
        children: [],
      };
  node.children = (Array.isArray(raw.children) ? raw.children : [])
    .map((child) => treeNode(child, depth + 1))
    .filter((child): child is WorkNode => Boolean(child && child.id));
  return node.id ? node : undefined;
};

const anyActive = (nodes: readonly WorkNode[]): boolean =>
  nodes.some((node) => isWorkActive(node.status) || anyActive(node.children));

/** Drops repeated ids (a session linked twice), keeping the first. */
const dedupe = (nodes: WorkNode[], seen = new Set<string>()): WorkNode[] =>
  nodes.filter((node) => {
    if (seen.has(node.id)) {
      return false;
    }
    seen.add(node.id);
    node.children = dedupe(node.children, seen);
    return true;
  });

/** A task's Sessions tree (ITaskSessionsTree) as the model. */
export const workViewFromTaskTree = (
  raw: unknown,
): WorkViewModel | undefined => {
  if (!isObject(raw) || !Array.isArray(raw.roots)) {
    return undefined;
  }
  const nodes = dedupe(
    raw.roots
      .map((root) => treeNode(root, 0))
      .filter((node): node is WorkNode => Boolean(node)),
  );
  return { title: textOf(raw.taskTitle, 200), nodes, active: anyActive(nodes) };
};

/** One chat's delegation cards (IDelegationCardsPage), each a worker. */
export const workViewFromCardsPage = (
  raw: unknown,
): WorkViewModel | undefined => {
  if (!isObject(raw) || !Array.isArray(raw.cards)) {
    return undefined;
  }
  const agent = isObject(raw.agent) ? raw.agent : {};
  const agentId = uuidOf(agent.id);
  const agentName = textOf(agent.name, 120);
  const nodes = dedupe(
    raw.cards
      .filter(isObject)
      .map((card) => cardNode(card, { agentId, agentName, role: "worker" }))
      .filter((node) => node.id),
  );
  const rev = asString(raw.rev);
  return { ...(rev ? { rev } : {}), nodes, active: anyActive(nodes) };
};

export const workViewModel = (
  source: WorkViewSource,
  raw: unknown,
): WorkViewModel | undefined =>
  source.kind === "task"
    ? workViewFromTaskTree(raw)
    : workViewFromCardsPage(raw);

/**
 * Seconds run now: the server's count plus the time since the read while
 * the worker is still going (never the device clock against serverNow).
 */
export const workElapsedNow = (
  node: Pick<WorkNode, "elapsedSeconds" | "status">,
  readAtMs: number,
  nowMs: number,
): number | undefined =>
  node.elapsedSeconds === undefined
    ? undefined
    : node.status === "running" || node.status === "waiting"
      ? node.elapsedSeconds + Math.max(0, Math.floor((nowMs - readAtMs) / 1000))
      : node.elapsedSeconds;

/** "45s", "12m", "1h 5m", "2d 3h". */
export const formatWorkElapsed = (
  seconds: number | undefined,
): string | undefined => {
  if (seconds === undefined) {
    return undefined;
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
};

/** "Agent · Harness", either part when known. */
export const workMetaLine = (
  node: Pick<WorkNode, "agentName" | "harnessLabel">,
): string | undefined =>
  [node.agentName, node.harnessLabel].filter(Boolean).join(" · ") || undefined;

/** One spoken line per worker for screen readers. */
export const workSpoken = (
  node: WorkNode,
  elapsed: string | undefined,
): string =>
  [
    node.title,
    node.agentName,
    node.harnessLabel,
    workStatusLabel(node),
    elapsed,
    node.lastLine,
  ]
    .filter(Boolean)
    .join(", ");

/** Agent ids still without a name, for the renderer to resolve (agent refs). */
export const workAgentIds = (
  nodes: readonly WorkNode[],
  into = new Set<string>(),
): Set<string> => {
  for (const node of nodes) {
    if (node.agentId && !node.agentName) {
      into.add(node.agentId);
    }
    workAgentIds(node.children, into);
  }
  return into;
};

/** What selecting a worker's tree row opens. */
export type WorkTreeAction =
  | { kind: "session"; sessionId: string; agentId?: string }
  | { kind: "run"; run: WorkRunRef };

/** The id of a worker's "Open Run" row (beside its session row). */
const runRowId = (node: WorkNode): string => `${node.id}#run`;

/**
 * The workers as Tree rows (GENUI-TREE's `TreeRows` / `UiTreeRows`), so
 * WorkView folds, reads and keys like every other tree: the title, "Agent
 * · Harness · last line", the status as a badge and the running time
 * trailing. A row opens the worker's session, else its Run; a worker with
 * both gets an "Open Run" row first among its children. `actions` says
 * what each selectable row opens; any other row only folds.
 */
export const workTreeNodes = (
  nodes: readonly WorkNode[],
  options: {
    names: ReadonlyMap<string, string>;
    readAtMs: number;
    nowMs: number;
    canOpenSession: boolean;
    canOpenRun: boolean;
  },
  actions: Map<string, WorkTreeAction> = new Map(),
): { nodes: TreeNode[]; actions: Map<string, WorkTreeAction> } => {
  const build = (node: WorkNode): TreeNode => {
    const agentName =
      node.agentName ??
      (node.agentId ? options.names.get(node.agentId) : undefined);
    const detail = [
      workMetaLine({ agentName, harnessLabel: node.harnessLabel }),
      node.lastLine,
    ]
      .filter(Boolean)
      .join(" · ");
    const session =
      options.canOpenSession && node.sessionId
        ? ({
            kind: "session",
            sessionId: node.sessionId,
            ...(node.agentId ? { agentId: node.agentId } : {}),
          } as const)
        : undefined;
    const run = options.canOpenRun && node.run ? node.run : undefined;
    const own: WorkTreeAction | undefined =
      session ?? (run ? { kind: "run", run } : undefined);
    if (own) {
      actions.set(node.id, own);
    }
    const children = node.children.map(build);
    if (session && run) {
      const id = runRowId(node);
      actions.set(id, { kind: "run", run });
      children.unshift({
        id,
        label: "Open Run",
        detail: "The agent session this worker runs in",
        icon: "play",
        done: false,
        selectable: true,
        children: [],
      });
    }
    const elapsed = formatWorkElapsed(
      workElapsedNow(node, options.readAtMs, options.nowMs),
    );
    return {
      id: node.id,
      label: node.title,
      ...(detail ? { detail } : {}),
      badge: { text: workStatusLabel(node), tone: workStatusTone(node) },
      ...(elapsed ? { trailing: elapsed } : {}),
      done: false,
      selectable: own !== undefined,
      children,
    };
  };
  return { nodes: nodes.map(build), actions };
};

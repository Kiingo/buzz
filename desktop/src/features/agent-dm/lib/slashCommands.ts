import { invokeTauri } from "@/shared/api/tauri";

/**
 * An agent's "/" commands for the composer menu, from the guest route's
 * `GET /agents/<agent>/commands?audience=private|group` (NIP-98 as the
 * signed-in user, signed natively): the session commands the user may run,
 * the skills it installs, and the other registry skills the user may use with
 * it (run for that turn). A 1:1 DM asks for the private list, a channel or
 * thread for the group one. Looked up lazily the first time the menu opens
 * for an agent and cached per agent key and audience with the server's ETag; later opens revalidate with
 * `If-None-Match` at most once a minute. Any error, or a body that fails
 * validation, leaves the agent with no commands, so no menu shows.
 *
 * The list holds every registry skill the user may use up to the server's
 * cap. When the server says it cut the list (`truncated`), typing searches
 * the full set with `?q=` (`refreshAgentCommandSearch`).
 */

export type AgentSessionCommand = {
  kind: "session";
  name: "new" | "sessions";
  description: string;
  usage: string | null;
};

export type AgentSkillCommand = {
  kind: "skill";
  name: string;
  skillId: string;
  description: string | null;
  argumentHint: string | null;
  /** Installed for this agent, or another registry skill. */
  source: "installed" | "registry";
  /** The registry's human name, when it differs from `name`. */
  displayName: string | null;
};

export type AgentSlashCommand = AgentSessionCommand | AgentSkillCommand;

/** Which conversation a list is for: a 1:1 DM, or a channel or thread. */
export type SlashAudience = "private" | "group";

export const MAX_AGENT_COMMANDS = 1_200;
/** Searches kept per session (agent, audience, query). */
const MAX_SEARCH_ENTRIES = 64;
const MAX_QUERY_CHARS = 64;
export const COMMANDS_REVALIDATE_MS = 60_000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : null;
}

/**
 * Validate a commands body for `agentPublicKey`. Returns null when the body
 * as a whole is unusable; malformed or duplicate entries are dropped. A
 * skill whose name collides with a session command is dropped so that a
 * chosen `/new` or `/sessions` always means the session command.
 */
export function parseAgentCommandsBody(
  body: unknown,
  agentPublicKey: string,
): AgentSlashCommand[] | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (record.contract_version !== 1) return null;
  if (
    typeof record.agent_public_key !== "string" ||
    record.agent_public_key.toLowerCase() !== agentPublicKey.toLowerCase()
  ) {
    return null;
  }
  if (!Array.isArray(record.commands)) return null;
  const sessions: AgentSessionCommand[] = [];
  const skills: AgentSkillCommand[] = [];
  const seen = new Set<string>();
  for (const raw of record.commands.slice(0, MAX_AGENT_COMMANDS)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (entry.kind === "session") {
      if (entry.name !== "new" && entry.name !== "sessions") continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      sessions.push({
        kind: "session",
        name: entry.name,
        description: optionalText(entry.description, 300) ?? "",
        usage: optionalText(entry.usage, 200),
      });
    } else if (entry.kind === "skill") {
      const name = typeof entry.name === "string" ? entry.name : "";
      const skillId = optionalText(entry.skill_id, 256);
      if (!NAME_RE.test(name) || !skillId) continue;
      skills.push({
        kind: "skill",
        name,
        skillId,
        description: optionalText(entry.description, 300),
        argumentHint: optionalText(entry.argument_hint, 200),
        // Older servers list only installed skills.
        source: entry.source === "registry" ? "registry" : "installed",
        displayName: optionalText(entry.display_name, 200),
      });
    }
  }
  const sessionNames = new Set<string>(sessions.map((command) => command.name));
  const uniqueSkills = skills.filter((skill) => {
    const key = skill.name.toLowerCase();
    if (sessionNames.has(key) || seen.has(`skill:${key}`)) return false;
    seen.add(`skill:${key}`);
    return true;
  });
  return [...sessions, ...uniqueSkills];
}

/** Whether the server cut the list short (more registry skills match). */
export function agentCommandsBodyTruncated(body: unknown): boolean {
  return (
    Boolean(body) &&
    typeof body === "object" &&
    (body as Record<string, unknown>).truncated === true
  );
}

type FetchResult = {
  notModified: boolean;
  etag: string | null;
  body: unknown;
};

type Transport = (input: {
  agentPublicKey: string;
  etag: string | null;
  audience: SlashAudience;
  /** What follows "/", for a server-side search. */
  query?: string | null;
}) => Promise<FetchResult>;

const tauriTransport: Transport = ({ agentPublicKey, etag, audience, query }) =>
  invokeTauri<FetchResult>("agent_commands_fetch", {
    agentPublicKey,
    etag,
    audience,
    query: query ?? null,
  });

let transport: Transport = tauriTransport;
let now: () => number = () => Date.now();

/** Test seam: replace the native transport and clock. Returns a restore function. */
export function setAgentCommandsTransportForTests(next: {
  transport?: Transport;
  now?: () => number;
}) {
  const previous = { transport, now };
  transport = next.transport ?? transport;
  now = next.now ?? now;
  return () => {
    transport = previous.transport;
    now = previous.now;
  };
}

type Entry = {
  etag: string | null;
  commands: AgentSlashCommand[];
  /** The server cut the list: a typed query searches it with `?q=`. */
  truncated: boolean;
  checkedAt: number;
};

const EMPTY: AgentSlashCommand[] = [];
let entries = new Map<string, Entry>();
let inflight = new Map<string, Promise<void>>();
let searches = new Map<string, Entry>();
let searchInflight = new Map<string, Promise<void>>();
let generation = 0;
let version = 0;
const listeners = new Set<() => void>();

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

function normalize(agentPublicKey: string): string | null {
  const key = agentPublicKey.trim().toLowerCase();
  return HEX64_RE.test(key) ? key : null;
}

function cacheKey(agent: string, audience: SlashAudience) {
  return `${agent}:${audience}`;
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().slice(0, MAX_QUERY_CHARS);
}

function searchKey(agent: string, audience: SlashAudience, query: string) {
  return `${agent}:${audience}:${query}`;
}

/** The agent's cached commands; empty when unknown or after an error. */
export function getAgentCommands(
  agentPublicKey: string,
  audience: SlashAudience = "private",
): AgentSlashCommand[] {
  const agent = normalize(agentPublicKey);
  return (agent && entries.get(cacheKey(agent, audience))?.commands) || EMPTY;
}

/**
 * Whether the agent's list is known: fetched, even if it came back empty
 * (an agent the user cannot command). Unknown while the first lookup runs.
 */
export function hasAgentCommands(
  agentPublicKey: string,
  audience: SlashAudience = "private",
): boolean {
  const agent = normalize(agentPublicKey);
  return Boolean(agent && entries.has(cacheKey(agent, audience)));
}

/** Whether the server cut the agent's list (see `refreshAgentCommandSearch`). */
export function isAgentCommandsTruncated(
  agentPublicKey: string,
  audience: SlashAudience = "private",
): boolean {
  const agent = normalize(agentPublicKey);
  return Boolean(agent && entries.get(cacheKey(agent, audience))?.truncated);
}

/** The server's answer for `query` (best match first), or null before it
 * arrives. */
export function getAgentCommandSearch(
  agentPublicKey: string,
  audience: SlashAudience,
  query: string,
): AgentSlashCommand[] | null {
  const agent = normalize(agentPublicKey);
  const q = normalizeQuery(query);
  if (!agent || !q) return null;
  return searches.get(searchKey(agent, audience, q))?.commands ?? null;
}

/**
 * Search the agent's full list on the server (`?q=`) when its cached list
 * was cut short. Cached per query for a minute; errors count as no matches.
 */
export function refreshAgentCommandSearch(
  agentPublicKey: string,
  audience: SlashAudience,
  query: string,
): Promise<void> {
  const agent = normalize(agentPublicKey);
  const q = normalizeQuery(query);
  if (!agent || !q || !isAgentCommandsTruncated(agent, audience)) {
    return Promise.resolve();
  }
  const key = searchKey(agent, audience, q);
  const cached = searches.get(key);
  if (cached && now() - cached.checkedAt < COMMANDS_REVALIDATE_MS) {
    return Promise.resolve();
  }
  const pending = searchInflight.get(key);
  if (pending) return pending;
  const owner = generation;
  const request = (async () => {
    let commands: AgentSlashCommand[] = EMPTY;
    try {
      const result = await transport({
        agentPublicKey: agent,
        etag: null,
        audience,
        query: q,
      });
      commands =
        (!result.notModified && parseAgentCommandsBody(result.body, agent)) ||
        EMPTY;
    } catch {
      commands = EMPTY;
    }
    if (owner !== generation) return;
    searchInflight.delete(key);
    searches.delete(key);
    searches.set(key, {
      etag: null,
      commands,
      truncated: false,
      checkedAt: now(),
    });
    while (searches.size > MAX_SEARCH_ENTRIES) {
      const oldest = searches.keys().next().value;
      if (oldest === undefined) break;
      searches.delete(oldest);
    }
    notify();
  })();
  searchInflight.set(key, request);
  return request;
}

/**
 * Fetch (or revalidate) the agent's commands unless a lookup is in flight
 * or the cached answer was checked within the last minute. Errors clear the
 * agent's commands and are not retried until that minute has passed.
 */
export function refreshAgentCommands(
  agentPublicKey: string,
  audience: SlashAudience = "private",
): Promise<void> {
  const agent = normalize(agentPublicKey);
  if (!agent) return Promise.resolve();
  const key = cacheKey(agent, audience);
  const cached = entries.get(key);
  if (cached && now() - cached.checkedAt < COMMANDS_REVALIDATE_MS) {
    return Promise.resolve();
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const owner = generation;
  const request = (async () => {
    let next: Entry;
    try {
      const result = await transport({
        agentPublicKey: agent,
        etag: cached?.etag ?? null,
        audience,
      });
      if (result.notModified && cached?.etag) {
        next = { ...cached, checkedAt: now() };
      } else {
        const commands = result.notModified
          ? null
          : parseAgentCommandsBody(result.body, agent);
        next = commands
          ? {
              etag: result.etag ?? null,
              commands,
              truncated: agentCommandsBodyTruncated(result.body),
              checkedAt: now(),
            }
          : { etag: null, commands: EMPTY, truncated: false, checkedAt: now() };
      }
    } catch {
      next = {
        etag: null,
        commands: EMPTY,
        truncated: false,
        checkedAt: now(),
      };
    }
    // A community switch while the lookup was in flight retires its answer.
    if (owner !== generation) return;
    inflight.delete(key);
    entries.set(key, next);
    notify();
  })();
  inflight.set(key, request);
  return request;
}

export function subscribeAgentCommands(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAgentCommandsVersion() {
  return version;
}

/** Clears every cached list and retires in-flight lookups. */
export function resetAgentCommandsCache() {
  generation += 1;
  entries = new Map();
  inflight = new Map();
  searches = new Map();
  searchInflight = new Map();
  notify();
}

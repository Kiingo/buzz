import { invokeTauri } from "@/shared/api/tauri";

/**
 * An agent's "/" commands for the DM composer menu, from the guest route's
 * `GET /agents/<agent>/commands` (NIP-98 as the signed-in user, signed
 * natively). Looked up lazily the first time the menu opens for an agent and
 * cached per agent key with the server's ETag; later opens revalidate with
 * `If-None-Match` at most once a minute. Any error, or a body that fails
 * validation, leaves the agent with no commands, so no menu shows.
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
};

export type AgentSlashCommand = AgentSessionCommand | AgentSkillCommand;

export const MAX_AGENT_COMMANDS = 200;
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

type FetchResult = {
  notModified: boolean;
  etag: string | null;
  body: unknown;
};

type Transport = (input: {
  agentPublicKey: string;
  etag: string | null;
}) => Promise<FetchResult>;

const tauriTransport: Transport = ({ agentPublicKey, etag }) =>
  invokeTauri<FetchResult>("agent_commands_fetch", { agentPublicKey, etag });

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
  checkedAt: number;
};

const EMPTY: AgentSlashCommand[] = [];
let entries = new Map<string, Entry>();
let inflight = new Map<string, Promise<void>>();
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

/** The agent's cached commands; empty when unknown or after an error. */
export function getAgentCommands(agentPublicKey: string): AgentSlashCommand[] {
  const key = normalize(agentPublicKey);
  return (key && entries.get(key)?.commands) || EMPTY;
}

/**
 * Fetch (or revalidate) the agent's commands unless a lookup is in flight
 * or the cached answer was checked within the last minute. Errors clear the
 * agent's commands and are not retried until that minute has passed.
 */
export function refreshAgentCommands(agentPublicKey: string): Promise<void> {
  const key = normalize(agentPublicKey);
  if (!key) return Promise.resolve();
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
        agentPublicKey: key,
        etag: cached?.etag ?? null,
      });
      if (result.notModified && cached?.etag) {
        next = { ...cached, checkedAt: now() };
      } else {
        const commands = result.notModified
          ? null
          : parseAgentCommandsBody(result.body, key);
        next = commands
          ? { etag: result.etag ?? null, commands, checkedAt: now() }
          : { etag: null, commands: EMPTY, checkedAt: now() };
      }
    } catch {
      next = { etag: null, commands: EMPTY, checkedAt: now() };
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
  notify();
}

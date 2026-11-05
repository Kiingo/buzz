import {
  AgentCallApiError,
  request,
} from "@/features/agent-call/lib/agentCallApi";

import { cachedAgentSummary, ensureAgentSummary } from "./agentSummary";
import type { AgentSlashCommand } from "./slashCommands";

/**
 * Task and project references in a 1:1 agent DM (BUZZPARITY B5). "/task" and
 * "/project" open a search of what the reader can read (the host's
 * `agents/<id>/chat/refs` on the Buzz mount, the signer's own read access).
 * A pick puts its label in the draft and the send carries one
 * `["buzz-ref", type, id]` tag for each label still in the text. The tag is
 * only a request: Kiingo checks each again, for the author's own message in
 * a private DM, and the agent gets the ones that resolve. No count limit.
 *
 * Community-scoped: `resetAgentRefs()` runs in resetCommunityState().
 */

export type AgentRefType = "task" | "project";

export type AgentRef = {
  type: AgentRefType;
  id: string;
  title: string;
  /** "In your queue with Scout" for a task in the agent's queue. */
  subtitle: string | null;
};

export type PickedAgentRef = AgentRef & { label: string };

const HEX64_RE = /^[0-9a-f]{64}$/u;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The "/" rows; offered anywhere in the message, not only at its start. */
export const AGENT_REF_COMMANDS: readonly AgentSlashCommand[] = [
  {
    kind: "session",
    name: "task",
    description: "Reference a task",
    usage: "/task",
  },
  {
    kind: "session",
    name: "project",
    description: "Reference a project",
    usage: "/project",
  },
];

/**
 * The reference type a "/" row opens, or null for any other row. Only these
 * very rows count, so a session command or skill of the same name never
 * opens the picker.
 */
export function agentRefTypeFor(command: unknown): AgentRefType | null {
  if (command === AGENT_REF_COMMANDS[0]) return "task";
  if (command === AGENT_REF_COMMANDS[1]) return "project";
  return null;
}

/** What a pick puts in the draft. */
export function agentRefLabel(ref: Pick<AgentRef, "type" | "title">): string {
  const title = ref.title.replace(/\s+/gu, " ").trim();
  return `${ref.type}: ${title || "untitled"}`;
}

/** The host's `{ results }`: each well-formed task or project row, in order. */
export function parseAgentRefs(body: unknown): AgentRef[] | null {
  const results =
    body && typeof body === "object"
      ? (body as { results?: unknown }).results
      : null;
  if (!Array.isArray(results)) return null;
  const out: AgentRef[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (
      (row.type !== "task" && row.type !== "project") ||
      typeof row.id !== "string" ||
      !UUID_RE.test(row.id) ||
      typeof row.title !== "string"
    ) {
      continue;
    }
    out.push({
      type: row.type,
      id: row.id.toLowerCase(),
      title: row.title,
      subtitle: typeof row.subtitle === "string" ? row.subtitle : null,
    });
  }
  return out;
}

export const agentRefsPath = (
  agentId: string,
  type: AgentRefType,
  query: string,
) => {
  const q = query.trim();
  return `agents/${agentId}/chat/refs?types=${type}${q ? `&q=${encodeURIComponent(q)}` : ""}&limit=20`;
};

/**
 * The tags for the picks whose label is still in the text: each pick once,
 * in the order picked. A label the person deleted sends nothing.
 */
export function agentRefTags(
  picks: readonly PickedAgentRef[],
  text: string,
): string[][] {
  const seen = new Set<string>();
  const tags: string[][] = [];
  for (const pick of picks) {
    const key = `${pick.type}:${pick.id}`;
    if (seen.has(key) || !text.includes(pick.label)) continue;
    seen.add(key);
    tags.push(["buzz-ref", pick.type, pick.id]);
  }
  return tags;
}

// ---- The store: picks per agent, and the picker the "/" row opens ----

export type AgentRefPickerRequest = {
  type: AgentRefType;
  onPick: (ref: AgentRef) => void;
};

let picks = new Map<string, PickedAgentRef[]>();
let pickerRequests = new Map<string, AgentRefPickerRequest>();
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

export function subscribeAgentRefs(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAgentRefsVersion() {
  return version;
}

/** Ask the DM header to open the picker; `onPick` puts the label in. */
export function requestAgentRefPicker(
  agentPublicKey: string,
  pickerRequest: AgentRefPickerRequest,
) {
  const key = normalize(agentPublicKey);
  if (!key) return;
  pickerRequests.set(key, pickerRequest);
  notify();
}

/** The picker asked for this agent, once. */
export function takeAgentRefPickerRequest(
  agentPublicKey: string,
): AgentRefPickerRequest | null {
  const key = normalize(agentPublicKey);
  const asked = key ? (pickerRequests.get(key) ?? null) : null;
  if (key) pickerRequests.delete(key);
  return asked;
}

export function addPickedAgentRef(agentPublicKey: string, ref: AgentRef) {
  const key = normalize(agentPublicKey);
  if (!key) return;
  picks.set(key, [
    ...(picks.get(key) ?? []),
    { ...ref, label: agentRefLabel(ref) },
  ]);
}

export function getPickedAgentRefs(
  agentPublicKey: string,
): readonly PickedAgentRef[] {
  const key = normalize(agentPublicKey);
  return (key && picks.get(key)) || [];
}

/** After a send, or when the draft is emptied. */
export function clearPickedAgentRefs(agentPublicKey: string) {
  const key = normalize(agentPublicKey);
  if (key) picks.delete(key);
}

/** Throws on a failed read; the picker says so and offers Try again. */
export async function searchAgentRefs(
  agentPublicKey: string,
  type: AgentRefType,
  query: string,
): Promise<AgentRef[]> {
  const key = normalize(agentPublicKey);
  if (!key) throw new AgentCallApiError(null, "agent_not_hosted");
  await ensureAgentSummary(key);
  const id = cachedAgentSummary(key)?.agentId ?? null;
  if (!id || !UUID_RE.test(id)) {
    throw new AgentCallApiError(null, "agent_not_hosted");
  }
  const read = parseAgentRefs(
    await request<unknown>("GET", agentRefsPath(id.toLowerCase(), type, query)),
  );
  if (!read) throw new AgentCallApiError(null, "response_malformed");
  return read;
}

/** A failed search in plain words. */
export function agentRefsErrorSentence(error: unknown): string {
  const code = error instanceof AgentCallApiError ? error.code : null;
  return code === "agent_not_hosted"
    ? "This agent has no host, so there is nothing to reference here."
    : "Couldn't search right now. Try again.";
}

export function resetAgentRefs() {
  picks = new Map();
  pickerRequests = new Map();
  notify();
}

import * as React from "react";

import { invokeTauri } from "@/shared/api/tauri";
import type { Channel } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * An agent's details for the profile panel's "Agent" section, from the guest
 * route's `GET /agents/<agent>/summary` (NIP-98 as the signed-in user,
 * signed natively). Cached for two minutes per agent, failures included, so
 * reopening the panel never re-asks in a loop. Any failure or unusable body
 * means no section.
 */

export const AGENT_SUMMARY_TTL_MS = 2 * 60_000;
const HEX64_RE = /^[0-9a-f]{64}$/;

export type AgentSummaryExecution = {
  harness: string;
  model: string;
  effort: string;
  pinned: boolean;
  resolvedModel: string | null;
  resolvedEffort: string | null;
  unavailableReason: string | null;
};

export type AgentSummarySession = {
  sessionId: string;
  harness: string;
  title: string | null;
  turnCount: number;
};

export type AgentSummary = {
  name: string;
  description: string | null;
  status: string;
  ownerName: string | null;
  ownerIsOrganization: boolean;
  execution: AgentSummaryExecution | null;
  runsOnMachine: boolean;
  machineName: string | null;
  session: AgentSummarySession | null;
  sessionControls: boolean;
  /** Skill names the agent can use. */
  skills: string[];
  /** `standard` or `full`, or null when tool access is unknown. */
  toolTrust: string | null;
  /** Where an owner or admin edits the agent (https only), if the reader may. */
  editUrl: string | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function httpsUrl(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    return new URL(candidate).protocol === "https:" ? candidate : null;
  } catch {
    return null;
  }
}

/** The summary for `agentPublicKey`, or null when the body is not that contract. */
export function parseAgentSummary(
  body: unknown,
  agentPublicKey: string,
): AgentSummary | null {
  const root = record(body);
  if (
    root?.contract_version !== 1 ||
    typeof root.agent_public_key !== "string" ||
    root.agent_public_key.toLowerCase() !== agentPublicKey.toLowerCase()
  ) {
    return null;
  }
  const agent = record(root.agent);
  const name = text(agent?.name);
  if (!agent || !name) return null;
  const owner = record(root.owner) ?? {};
  const execution = record(root.execution);
  const location = record(root.location) ?? {};
  const session = record(root.viewer_session);
  const tools = record(root.tools);
  const harness = text(execution?.harness);
  const sessionId = text(session?.session_id);
  return {
    name,
    description: text(agent.description),
    status: text(agent.status) ?? "enabled",
    ownerName: text(owner.display_name),
    ownerIsOrganization: owner.principal_type === "Organization",
    execution:
      execution && harness
        ? {
            harness,
            model: text(execution.model) ?? "default",
            effort: text(execution.effort) ?? "auto",
            pinned: execution.pinned === true,
            resolvedModel: text(execution.resolved_model),
            resolvedEffort: text(execution.resolved_effort),
            unavailableReason: text(execution.unavailable_reason),
          }
        : null,
    runsOnMachine: location.kind === "machine",
    machineName: text(location.machine_name),
    session:
      session && sessionId
        ? {
            sessionId,
            harness: text(session.harness) ?? "",
            title: text(session.title),
            turnCount:
              typeof session.turn_count === "number" &&
              Number.isInteger(session.turn_count) &&
              session.turn_count >= 0
                ? session.turn_count
                : 0,
          }
        : null,
    sessionControls: root.session_controls === true,
    skills: Array.isArray(root.skills)
      ? root.skills.flatMap((skill) => {
          const skillName = text(record(skill)?.name);
          return skillName ? [skillName] : [];
        })
      : [],
    toolTrust: tools ? text(tools.execution_trust) : null,
    editUrl: httpsUrl(root.edit_url),
  };
}

function harnessLabel(harness: string) {
  switch (harness) {
    case "codex":
      return "Codex";
    case "claude-code":
      return "Claude Code";
    case "antigravity":
      return "Antigravity";
    default:
      return harness;
  }
}

/** "Runs on": harness · model · effort, with "(pinned)". */
export function agentSummaryRunsOnLabel(execution: AgentSummaryExecution) {
  return `${harnessLabel(execution.harness)} · ${execution.model} · ${execution.effort}${execution.pinned ? " (pinned)" : ""}`;
}

/** "For you": the model this reader's turns resolve to, or why none. */
export function agentSummaryForYouLabel(execution: AgentSummaryExecution) {
  if (execution.resolvedModel) {
    return execution.resolvedEffort
      ? `${execution.resolvedModel} · ${execution.resolvedEffort}`
      : execution.resolvedModel;
  }
  if (execution.unavailableReason?.includes("subscription")) {
    return `Connect your ${harnessLabel(execution.harness)} subscription to talk to this agent.`;
  }
  return "Not available with your connected accounts. Check your harness connections.";
}

/** The section's rows, in order, with the mobile card's labels. */
export function agentSummaryRows(
  summary: AgentSummary,
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (summary.description) {
    rows.push({ label: "About", value: summary.description });
  }
  if (summary.execution) {
    rows.push({
      label: "Runs on",
      value: agentSummaryRunsOnLabel(summary.execution),
    });
    rows.push({
      label: "For you",
      value: agentSummaryForYouLabel(summary.execution),
    });
  }
  rows.push({
    label: "Where",
    value: summary.runsOnMachine
      ? (summary.machineName ?? "A connected machine")
      : "Hosted compute",
  });
  if (summary.session) {
    const turns = summary.session.turnCount;
    rows.push({
      label: "Your session",
      value: `${summary.session.title ?? "Current session"} · ${turns} ${turns === 1 ? "turn" : "turns"}`,
    });
  }
  rows.push({
    label: "Owner",
    value:
      summary.ownerName ??
      (summary.ownerIsOrganization ? "Your organization" : "Unknown"),
  });
  if (summary.skills.length > 0) {
    rows.push({
      label: `${summary.skills.length} ${summary.skills.length === 1 ? "skill" : "skills"}`,
      value: summary.skills.join(", "),
    });
  }
  if (summary.toolTrust) {
    rows.push({
      label: "Tools",
      value:
        summary.toolTrust === "full"
          ? "MCP tools, full trust"
          : "MCP tools, standard trust",
    });
  }
  return rows;
}

type Lookup = (agentPublicKey: string) => Promise<unknown>;

const tauriLookup: Lookup = (agentPublicKey) =>
  invokeTauri<unknown>("agent_summary_fetch", { agentPublicKey });

let lookup: Lookup = tauriLookup;
let now: () => number = () => Date.now();

/** Test seam: replace the native lookup and clock. Returns a restore function. */
export function setAgentSummaryLookupForTests(next: {
  lookup?: Lookup;
  now?: () => number;
}) {
  const previous = { lookup, now };
  lookup = next.lookup ?? lookup;
  now = next.now ?? now;
  return () => {
    lookup = previous.lookup;
    now = previous.now;
  };
}

type Entry = { summary: AgentSummary | null; fetchedAt: number };

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

/** The cached summary, or null while unknown and after any failure. */
export function cachedAgentSummary(
  agentPublicKey: string,
): AgentSummary | null {
  const key = normalize(agentPublicKey);
  return key ? (entries.get(key)?.summary ?? null) : null;
}

/** Fetch the summary unless a fresh answer (or failure) is cached or in flight. */
export function ensureAgentSummary(agentPublicKey: string): Promise<void> {
  const key = normalize(agentPublicKey);
  if (!key) return Promise.resolve();
  const cached = entries.get(key);
  if (cached && now() - cached.fetchedAt < AGENT_SUMMARY_TTL_MS) {
    return Promise.resolve();
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const owner = generation;
  const request = (async () => {
    let summary: AgentSummary | null = null;
    try {
      summary = parseAgentSummary(await lookup(key), key);
    } catch {
      summary = null;
    }
    // A community switch while the lookup was in flight retires its answer.
    if (owner !== generation) return;
    inflight.delete(key);
    entries.set(key, { summary, fetchedAt: now() });
    notify();
  })();
  inflight.set(key, request);
  return request;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getVersion() {
  return version;
}

/** Clears every cached summary and retires in-flight lookups. */
export function resetAgentSummaryCache() {
  generation += 1;
  entries = new Map();
  inflight = new Map();
  notify();
}

/** The agent's summary for this panel, looked up when the panel opens. */
export function useAgentSummary(agentPublicKey: string | null) {
  React.useSyncExternalStore(subscribe, getVersion, getVersion);
  React.useEffect(() => {
    if (agentPublicKey) void ensureAgentSummary(agentPublicKey);
  }, [agentPublicKey]);
  return agentPublicKey ? cachedAgentSummary(agentPublicKey) : null;
}

/** Whether the viewer has a 1:1 DM whose other member is this agent. */
export function hasAgentDm(
  channels: readonly Pick<Channel, "channelType" | "participantPubkeys">[],
  selfPubkey: string | undefined,
  agentPubkey: string,
) {
  if (!selfPubkey) return false;
  const self = normalizePubkey(selfPubkey);
  const agent = normalizePubkey(agentPubkey);
  return channels.some((channel) => {
    if (channel.channelType !== "dm") return false;
    const others = new Set(
      channel.participantPubkeys
        .map((pubkey) => normalizePubkey(pubkey))
        .filter((pubkey) => pubkey && pubkey !== self),
    );
    return others.size === 1 && others.has(agent);
  });
}

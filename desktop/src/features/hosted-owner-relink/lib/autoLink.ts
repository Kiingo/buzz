import {
  describeAttestRejection,
  describeRejection,
  isAttested,
  isRetryable,
  isRetryableAttest,
  MAX_REBIND_AGENTS,
  pendingAgents,
  staleAgents,
  toRelinkRequestError,
  type AttestResult,
  type HostedOwnerAgent,
  type HostedOwnerAgents,
  type RebindResult,
} from "./relink";

/**
 * "Auto-link my new agents": an owner setting, off by default. While it is
 * on and the app is in the foreground, Buzz lists the owner's hosted agents
 * on launch, on resume and every 15 minutes, attests every agent the list
 * reports as pending, re-links every agent still on an earlier owner key,
 * and then shows one quiet note naming the agents it linked. Only agents the
 * authenticated list returned are ever signed for.
 */

/** Passes repeat this often while the app is in the foreground. */
export const AUTO_LINK_INTERVAL_MS = 15 * 60_000;
/** A resume within this long of the last pass does not start another. */
export const AUTO_LINK_RESUME_GAP_MS = 60_000;

export const relinkQueryKeys = {
  available: ["hosted-owner-relink", "available"] as const,
  agents: ["hosted-owner-relink", "agents"] as const,
  unlinked: ["hosted-owner-relink", "unlinked"] as const,
};

// ---- Setting ---------------------------------------------------------------

const STORAGE_PREFIX = "buzz.hostedAgents.autoLink.v1:";
const HEX64 = /^[0-9a-f]{64}$/;

/** The setting is per signed-in key on this device. */
export function autoLinkStorageKey(ownerPublicKey: string): string | null {
  const owner = ownerPublicKey.toLowerCase();
  return HEX64.test(owner) ? `${STORAGE_PREFIX}${owner}` : null;
}

const settingListeners = new Set<() => void>();

/** Whether the owner turned auto-link on. Off when unknown or unreadable. */
export function readAutoLinkSetting(ownerPublicKey: string | null): boolean {
  const key = ownerPublicKey ? autoLinkStorageKey(ownerPublicKey) : null;
  if (!key) return false;
  try {
    return globalThis.localStorage?.getItem(key) === "on";
  } catch {
    return false;
  }
}

/** Turn auto-link on or off for this key. Off removes the stored value. */
export function writeAutoLinkSetting(
  ownerPublicKey: string,
  enabled: boolean,
): void {
  const key = autoLinkStorageKey(ownerPublicKey);
  if (!key) return;
  try {
    if (enabled) globalThis.localStorage?.setItem(key, "on");
    else globalThis.localStorage?.removeItem(key);
  } catch {
    // Best effort: an unreadable setting reads as off.
  }
  for (const listener of settingListeners) listener();
}

export function subscribeAutoLinkSetting(listener: () => void): () => void {
  settingListeners.add(listener);
  return () => settingListeners.delete(listener);
}

// ---- One pass ----------------------------------------------------------------

export type AutoLinkApi = {
  list: () => Promise<HostedOwnerAgents>;
  attestPending: (agents: HostedOwnerAgent[]) => Promise<AttestResult[]>;
  rebind: (agents: HostedOwnerAgent[]) => Promise<RebindResult[]>;
};

/**
 * What earlier passes learned: agents the provider refused for good, keyed
 * by owner key, agent id and agent key, so a pass does not sign for them
 * again every 15 minutes. Kept in memory only; a restart tries once more.
 */
export type AutoLinkMemory = { refused: Set<string> };

export const newAutoLinkMemory = (): AutoLinkMemory => ({ refused: new Set() });

const memoryKey = (owner: string, agent: HostedOwnerAgent) =>
  `${owner.toLowerCase()}|${agent.providerAgentId}|${agent.agentPublicKey.toLowerCase()}`;

export type AutoLinkPassResult = {
  /** Names of agents this pass attested or re-linked, in list order. */
  linked: string[];
  /**
   * Agents this pass could not link for good, with the reason in plain
   * words. Each is reported once: refused agents are not sent again.
   */
  notLinked: { name: string; reason: string }[];
  /** Whole-request error codes, if any request failed. */
  errors: string[];
  /** False when the pass did not run (wrong key, nothing to do). */
  sent: boolean;
};

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * One auto-link pass for `ownerPublicKey`: list, attest the pending agents,
 * re-link the stale ones, in requests of at most 20 agents, each request one
 * new id and proof. A whole-request failure stops the pass; the next pass
 * starts over from a fresh list.
 */
export async function runAutoLinkPass(
  api: AutoLinkApi,
  ownerPublicKey: string,
  memory: AutoLinkMemory,
): Promise<AutoLinkPassResult> {
  const result: AutoLinkPassResult = {
    linked: [],
    notLinked: [],
    errors: [],
    sent: false,
  };
  let view: HostedOwnerAgents;
  try {
    view = await api.list();
  } catch (error) {
    result.errors.push(toRelinkRequestError(error).code);
    return result;
  }
  const owner = ownerPublicKey.toLowerCase();
  // Never sign with a key other than the one the owner turned this on for.
  if (view.currentOwnerPublicKey.toLowerCase() !== owner) return result;
  const fresh = (agent: HostedOwnerAgent) =>
    !memory.refused.has(memoryKey(owner, agent));
  const pending = pendingAgents(view).filter(fresh);
  const stale = staleAgents(view).filter(fresh);
  const names = new Map(
    view.agents.map((agent) => [agent.providerAgentId, agent.displayName]),
  );
  const linkedIds = new Set<string>();

  try {
    for (const batch of chunk(pending, MAX_REBIND_AGENTS)) {
      result.sent = true;
      const outcomes = await api.attestPending(batch);
      for (const agent of batch) {
        const outcome = outcomes.find(
          (candidate) => candidate.providerAgentId === agent.providerAgentId,
        );
        if (isAttested(outcome)) {
          // Already active means another device or tap linked it.
          if (outcome?.outcome !== "already_active") {
            linkedIds.add(agent.providerAgentId);
          }
        } else if (!isRetryableAttest(outcome)) {
          memory.refused.add(memoryKey(owner, agent));
          result.notLinked.push({
            name: agent.displayName,
            reason: describeAttestRejection(outcome?.code ?? null),
          });
        }
      }
    }
    for (const batch of chunk(stale, MAX_REBIND_AGENTS)) {
      result.sent = true;
      const outcomes = await api.rebind(batch);
      for (const agent of batch) {
        const outcome = outcomes.find(
          (candidate) => candidate.providerAgentId === agent.providerAgentId,
        );
        if (outcome?.outcome === "rebound") {
          linkedIds.add(agent.providerAgentId);
        } else if (
          outcome?.outcome !== "already_current" &&
          !isRetryable(outcome)
        ) {
          memory.refused.add(memoryKey(owner, agent));
          result.notLinked.push({
            name: agent.displayName,
            reason: describeRejection(outcome?.code ?? null),
          });
        }
      }
    }
  } catch (error) {
    result.errors.push(toRelinkRequestError(error).code);
  }
  for (const agent of view.agents) {
    if (linkedIds.has(agent.providerAgentId)) {
      result.linked.push(names.get(agent.providerAgentId) ?? "an agent");
    }
  }
  return result;
}

/**
 * The note for agents a pass could not link, or null when there are none:
 * a title and one "name: reason" line per agent (at most three, then a
 * count).
 */
export function notLinkedNote(
  agents: readonly { name: string; reason: string }[],
): { title: string; description: string } | null {
  if (agents.length === 0) return null;
  const lines = agents
    .slice(0, 3)
    .map((agent) => `${agent.name.trim() || "An agent"}: ${agent.reason}`);
  if (agents.length > 3) lines.push(`And ${agents.length - 3} more.`);
  return {
    title:
      agents.length === 1
        ? "Couldn't link an agent"
        : `Couldn't link ${agents.length} agents`,
    description: lines.join("\n"),
  };
}

/** The quiet note after a pass, or null when it linked nothing. */
export function linkedNote(names: readonly string[]): string | null {
  const shown = names.map((name) => name.trim() || "an agent");
  if (shown.length === 0) return null;
  if (shown.length <= 4) return `Linked: ${shown.join(", ")}`;
  return `Linked: ${shown.slice(0, 3).join(", ")} and ${shown.length - 3} more`;
}

// ---- Scheduling --------------------------------------------------------------

export type AutoLinkTrigger = "launch" | "resume" | "interval";

export type AutoLinkSchedulerDeps = {
  runPass: () => Promise<void>;
  isForeground: () => boolean;
  now: () => number;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

/**
 * Runs passes on launch, on resume (at most once a minute) and every 15
 * minutes while in the foreground; never two at once.
 */
export function createAutoLinkScheduler(deps: AutoLinkSchedulerDeps) {
  let running = false;
  let stopped = false;
  let lastStart = Number.NEGATIVE_INFINITY;
  let handle: unknown = null;

  const trigger = (reason: AutoLinkTrigger): boolean => {
    if (stopped || running || !deps.isForeground()) return false;
    const now = deps.now();
    if (reason === "resume" && now - lastStart < AUTO_LINK_RESUME_GAP_MS) {
      return false;
    }
    if (reason === "interval" && now - lastStart < AUTO_LINK_INTERVAL_MS / 2) {
      return false;
    }
    running = true;
    lastStart = now;
    void deps
      .runPass()
      .catch(() => {
        // A pass reports its own errors; the next trigger tries again.
      })
      .finally(() => {
        running = false;
      });
    return true;
  };

  return {
    start() {
      stopped = false;
      handle = deps.setInterval(
        () => trigger("interval"),
        AUTO_LINK_INTERVAL_MS,
      );
      trigger("launch");
    },
    resume() {
      return trigger("resume");
    },
    trigger,
    stop() {
      stopped = true;
      if (handle !== null) deps.clearInterval(handle);
      handle = null;
    },
  };
}

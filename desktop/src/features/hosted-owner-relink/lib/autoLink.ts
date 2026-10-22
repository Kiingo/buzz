import {
  agentLabel,
  describeAttestRejection,
  describeRequestError,
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
 * authenticated list returned are ever signed for, and a pass stops before
 * its next signed request once the setting is turned off or the key changes.
 * Repeated whole-request failures back off, with one plain note.
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
  /** Sign for `agents`, which `view` (the pass's list) reported pending. */
  attestPending: (
    agents: HostedOwnerAgent[],
    view: HostedOwnerAgents,
  ) => Promise<AttestResult[]>;
  /** Sign for `agents`, which `view` reported on an earlier owner key. */
  rebind: (
    agents: HostedOwnerAgent[],
    view: HostedOwnerAgents,
  ) => Promise<RebindResult[]>;
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

export type AutoLinkPassOptions = {
  /**
   * Checked after the list and before every signed request: false (the
   * setting was turned off, the owner signed out or switched keys) stops
   * the pass without signing anything more.
   */
  shouldContinue?: () => boolean;
};

export type AutoLinkPassResult = {
  /**
   * Agents this pass attested or re-linked, in list order, each as its
   * name and key fingerprint (see `agentLabel`).
   */
  linked: string[];
  /**
   * Agents this pass could not link for good, labelled the same way, with
   * the reason in plain words. Each is reported once: refused agents are
   * not sent again.
   */
  notLinked: { name: string; reason: string }[];
  /** Whole-request error codes, if any request failed. */
  errors: string[];
  /** False when the pass did not run (wrong key, nothing to do). */
  sent: boolean;
  /** True when `shouldContinue` stopped the pass before it finished. */
  cancelled: boolean;
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
 * new id and proof, each held to this pass's list. A whole-request failure
 * stops the pass; the next pass starts over from a fresh list. The pass
 * checks `options.shouldContinue` after the list and before every request.
 */
export async function runAutoLinkPass(
  api: AutoLinkApi,
  ownerPublicKey: string,
  memory: AutoLinkMemory,
  options: AutoLinkPassOptions = {},
): Promise<AutoLinkPassResult> {
  const result: AutoLinkPassResult = {
    linked: [],
    notLinked: [],
    errors: [],
    sent: false,
    cancelled: false,
  };
  const keepGoing = () => {
    if (options.shouldContinue && !options.shouldContinue()) {
      result.cancelled = true;
      return false;
    }
    return true;
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
  const linkedIds = new Set<string>();

  try {
    for (const batch of chunk(pending, MAX_REBIND_AGENTS)) {
      if (!keepGoing()) break;
      result.sent = true;
      const outcomes = await api.attestPending(batch, view);
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
            name: agentLabel(agent),
            reason: describeAttestRejection(outcome?.code ?? null),
          });
        }
      }
    }
    for (const batch of chunk(stale, MAX_REBIND_AGENTS)) {
      if (result.cancelled || !keepGoing()) break;
      result.sent = true;
      const outcomes = await api.rebind(batch, view);
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
            name: agentLabel(agent),
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
      result.linked.push(agentLabel(agent));
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
export function linkedNote(labels: readonly string[]): string | null {
  const shown = labels.map((label) => label.trim() || "An agent");
  if (shown.length === 0) return null;
  if (shown.length <= 4) return `Linked: ${shown.join(", ")}`;
  return `Linked: ${shown.slice(0, 3).join(", ")} and ${shown.length - 3} more`;
}

// ---- Backoff -----------------------------------------------------------------

/** Whole-request failures in a row before passes back off and say so. */
export const AUTO_LINK_FAILURES_BEFORE_BACKOFF = 3;
/** The first wait after that; each further failure doubles it. */
export const AUTO_LINK_BACKOFF_BASE_MS = 30 * 60_000;
/** The longest wait between passes that keep failing. */
export const AUTO_LINK_BACKOFF_MAX_MS = 8 * 60 * 60_000;

/**
 * Backs off passes that keep failing as a whole (offline, a signature the
 * service refuses, the service down): after three failures in a row, the
 * next pass waits 30 minutes, then an hour, up to eight hours, and one
 * plain note says so. A pass that gets through resets it.
 */
export function createAutoLinkBackoff() {
  let failures = 0;
  let notBefore = Number.NEGATIVE_INFINITY;
  return {
    /** Whether a pass may start at `now`. */
    allows(now: number): boolean {
      return now >= notBefore;
    },
    /**
     * Record a finished pass. Returns the note to show, once per run of
     * failures, or null.
     */
    record(
      result: Pick<AutoLinkPassResult, "errors" | "cancelled">,
      now: number,
    ): { title: string; description: string } | null {
      if (result.cancelled) return null;
      const code = result.errors[0];
      if (code === undefined) {
        failures = 0;
        notBefore = Number.NEGATIVE_INFINITY;
        return null;
      }
      failures += 1;
      if (failures < AUTO_LINK_FAILURES_BEFORE_BACKOFF) return null;
      const steps = failures - AUTO_LINK_FAILURES_BEFORE_BACKOFF;
      notBefore =
        now +
        Math.min(
          AUTO_LINK_BACKOFF_BASE_MS * 2 ** steps,
          AUTO_LINK_BACKOFF_MAX_MS,
        );
      if (failures !== AUTO_LINK_FAILURES_BEFORE_BACKOFF) return null;
      return {
        title: "Couldn't link your agents automatically",
        description: `${describeRequestError(code)} Buzz will keep trying, less often.`,
      };
    },
    /** Consecutive whole-request failures so far. */
    get failures() {
      return failures;
    },
  };
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

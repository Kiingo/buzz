import * as React from "react";

import { invokeTauri } from "@/shared/api/tauri";

/**
 * Whether an agent's session controls (`/sessions`, `/new`, `/sessions
 * load`) are available, from the hosted provider's read-only
 * `POST /session-controls` (signed natively, no prompt). The DM sessions
 * picker is offered only when this says true.
 *
 * Looked up lazily when an agent DM opens and cached per agent public key:
 * 10 minutes for true, 2 minutes for false. Any error or timeout counts as
 * false (fail closed) and is cached like false, so nothing retries in a loop;
 * the next lookup happens when the DM is opened again after the entry
 * expires.
 */

export const SESSION_CONTROLS_TRUE_TTL_MS = 10 * 60_000;
export const SESSION_CONTROLS_FALSE_TTL_MS = 2 * 60_000;

const HEX64_RE = /^[0-9a-f]{64}$/;

type Lookup = (agentPublicKey: string) => Promise<boolean>;

const tauriLookup: Lookup = (agentPublicKey) =>
  invokeTauri<boolean>("agent_session_controls_available", { agentPublicKey });

let lookup: Lookup = tauriLookup;
let now: () => number = () => Date.now();

/** Test seam: replace the native lookup and clock. Returns a restore function. */
export function setSessionControlsLookupForTests(next: {
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

type Entry = { available: boolean; expiresAt: number };

let entries = new Map<string, Entry>();
let inflight = new Map<string, Promise<boolean>>();
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

/** The last answer for this agent; false when unknown (fail closed). */
export function cachedSessionControls(agentPublicKey: string): boolean {
  const key = normalize(agentPublicKey);
  return key ? (entries.get(key)?.available ?? false) : false;
}

/**
 * Look up the agent's session controls unless a fresh answer is cached or a
 * lookup is already in flight. Resolves to the answer (false on any error).
 */
export function ensureSessionControls(
  agentPublicKey: string,
): Promise<boolean> {
  const key = normalize(agentPublicKey);
  if (!key) return Promise.resolve(false);
  const cached = entries.get(key);
  if (cached && cached.expiresAt > now()) {
    return Promise.resolve(cached.available);
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const owner = generation;
  const request = (async () => {
    let available = false;
    try {
      available = (await lookup(key)) === true;
    } catch {
      available = false;
    }
    // A community switch while the lookup was in flight retires its answer.
    if (owner === generation) {
      inflight.delete(key);
      entries.set(key, {
        available,
        expiresAt:
          now() +
          (available
            ? SESSION_CONTROLS_TRUE_TTL_MS
            : SESSION_CONTROLS_FALSE_TTL_MS),
      });
      notify();
    }
    return available;
  })();
  inflight.set(key, request);
  return request;
}

export function subscribeSessionControls(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getVersion() {
  return version;
}

/** Clears every cached answer and retires in-flight lookups. */
export function resetSessionControlsCache() {
  generation += 1;
  entries = new Map();
  inflight = new Map();
  notify();
}

/**
 * Whether to offer session controls for this agent. Starts the lookup when
 * the DM opens (or the agent changes) and reads the cached answer.
 */
export function useSessionControlsAvailable(agentPublicKey: string): boolean {
  React.useSyncExternalStore(subscribeSessionControls, getVersion, getVersion);
  React.useEffect(() => {
    void ensureSessionControls(agentPublicKey);
  }, [agentPublicKey]);
  return cachedSessionControls(agentPublicKey);
}

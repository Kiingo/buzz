import { invokeTauri } from "@/shared/api/tauri";

/**
 * DM-open prewarm: when a 1:1 agent DM opens, ask the guest route to warm
 * the agent for the reader (`POST /agents/<agent>/prewarm`, signed natively)
 * so the first reply starts sooner. Fire and forget: at most one request per
 * agent per two minutes, the answer and any error are ignored, and nothing
 * retries. The map is cleared in resetCommunityState().
 */

export const AGENT_PREWARM_DEBOUNCE_MS = 2 * 60_000;
const HEX64_RE = /^[0-9a-f]{64}$/;

type Send = (agentPublicKey: string) => Promise<unknown>;

const tauriSend: Send = (agentPublicKey) =>
  invokeTauri<void>("agent_prewarm", { agentPublicKey });

let send: Send = tauriSend;
let now: () => number = () => Date.now();
let lastSentAt = new Map<string, number>();

/** Test seam: replace the native request and clock. Returns a restore function. */
export function setAgentPrewarmForTests(next: {
  send?: Send;
  now?: () => number;
}) {
  const previous = { send, now };
  send = next.send ?? send;
  now = next.now ?? now;
  return () => {
    send = previous.send;
    now = previous.now;
  };
}

/** Prewarm the agent unless it was prewarmed within the last two minutes. */
export function prewarmAgent(agentPublicKey: string): boolean {
  const key = agentPublicKey.trim().toLowerCase();
  if (!HEX64_RE.test(key)) return false;
  const last = lastSentAt.get(key);
  const at = now();
  if (last !== undefined && at - last < AGENT_PREWARM_DEBOUNCE_MS) return false;
  lastSentAt.set(key, at);
  try {
    void send(key).catch(() => {});
  } catch {
    // A missed prewarm only means the first reply starts cold.
  }
  return true;
}

export function resetAgentPrewarm() {
  lastSentAt = new Map();
}

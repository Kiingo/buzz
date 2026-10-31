/**
 * One live delegation board per agent, shared by the DM header and the dock
 * above the composer. The first viewer starts a long-poll on the host's
 * cards route (`rev` + `wait`); the last one to leave stops it. The host
 * answers only the agent's owner (D5): any other reader gets `hidden` and
 * the DM shows the agent's ordinary messages alone.
 *
 * Community-scoped: `resetDelegationStore()` runs in resetCommunityState().
 */

import {
  AgentCallApiError,
  getAgentVoiceSettings,
  request,
} from "@/features/agent-call/lib/agentCallApi";

import {
  type DelegationAsk,
  type DelegationPage,
  delegationsPath,
  isDelegationUuid,
  parseDelegationAsks,
  parseDelegationPoll,
} from "./delegations";

export type DelegationBoardState =
  | { status: "loading" }
  /** Not the owner, not a hosted agent, or a host without the routes. */
  | { status: "hidden" }
  | {
      status: "ready";
      agentId: string;
      page: DelegationPage;
      /** Open worker asks, by delegation id. */
      asks: ReadonlyMap<string, DelegationAsk[]>;
      /** The last poll failed; the page shown is the last good one. */
      stale: boolean;
    };

const RETRY_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;
/** A hidden board looks again this rarely (ownership can change). */
const HIDDEN_RECHECK_MS = 10 * 60_000;

type Entry = {
  state: DelegationBoardState;
  listeners: Set<() => void>;
  refs: number;
  /** Bumped on stop and on every new loop: a stale result is dropped. */
  generation: number;
  agentId: string | null;
  rev: string | null;
  /** Ends the loop's current wait at once (stop, reset). */
  wake: (() => void) | null;
};

const LOADING: DelegationBoardState = { status: "loading" };
const entries = new Map<string, Entry>();
let storeGeneration = 0;

/** A wait the entry can cut short, so a stopped loop holds no timer. */
function sleep(entry: Entry, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (entry.wake === done) entry.wake = null;
      resolve();
    }
    entry.wake = done;
  });
}

function fence(entry: Entry) {
  entry.generation = ++storeGeneration;
  entry.rev = null;
  entry.wake?.();
}

function entryFor(agentPubkey: string): Entry {
  const key = agentPubkey.toLowerCase();
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      state: LOADING,
      listeners: new Set(),
      refs: 0,
      generation: 0,
      agentId: null,
      rev: null,
      wake: null,
    };
    entries.set(key, entry);
  }
  return entry;
}

function publish(entry: Entry, state: DelegationBoardState) {
  entry.state = state;
  for (const listener of entry.listeners) listener();
}

const isRefusal = (error: unknown) =>
  error instanceof AgentCallApiError &&
  (error.status === 403 || error.status === 404 || error.status === 405);

/** The Kiingo agent behind a Buzz agent key, or null when there is none. */
async function resolveAgentId(agentPubkey: string): Promise<string | null> {
  const settings = await getAgentVoiceSettings(agentPubkey);
  const agentId = settings?.effective?.agentId ?? null;
  return isDelegationUuid(agentId) ? agentId.toLowerCase() : null;
}

/** The open asks of every card that has one. */
async function loadAsks(
  agentId: string,
  page: DelegationPage,
): Promise<Map<string, DelegationAsk[]>> {
  const asking = page.cards.filter((card) => card.pendingAsksCount > 0);
  const results = await Promise.all(
    asking.map(async (card) => {
      try {
        const body = await request<unknown>(
          "GET",
          `agents/${agentId}/delegations/${card.delegationId}`,
        );
        return [card.delegationId, parseDelegationAsks(body)] as const;
      } catch {
        return [card.delegationId, [] as DelegationAsk[]] as const;
      }
    }),
  );
  return new Map(results.filter(([, asks]) => asks.length > 0));
}

/** One read: the page (waiting on `rev` when given), or null if unchanged. */
async function readOnce(
  entry: Entry,
  agentId: string,
  wait: boolean,
): Promise<DelegationPage | null> {
  const body = await request<unknown>(
    "GET",
    delegationsPath(agentId, wait ? entry.rev : null),
  );
  const poll = parseDelegationPoll(body);
  if (!poll) throw new AgentCallApiError(null, "delegations_response_invalid");
  entry.rev = poll.kind === "page" ? poll.page.rev : poll.rev;
  return poll.kind === "page" ? poll.page : null;
}

async function applyPage(
  entry: Entry,
  generation: number,
  agentId: string,
  page: DelegationPage,
) {
  const asks = await loadAsks(agentId, page);
  if (entry.generation !== generation) return;
  publish(entry, { status: "ready", agentId, page, asks, stale: false });
}

async function run(entry: Entry, agentPubkey: string, generation: number) {
  const live = () => entry.generation === generation && entry.refs > 0;
  let backoff = RETRY_MS;
  while (live()) {
    try {
      if (!entry.agentId) {
        entry.agentId = await resolveAgentId(agentPubkey);
        if (!live()) return;
        if (!entry.agentId) {
          publish(entry, { status: "hidden" });
          await sleep(entry, HIDDEN_RECHECK_MS);
          continue;
        }
      }
      const agentId = entry.agentId;
      const page = await readOnce(entry, agentId, entry.rev !== null);
      if (!live()) return;
      if (page) await applyPage(entry, generation, agentId, page);
      backoff = RETRY_MS;
    } catch (error) {
      if (!live()) return;
      if (isRefusal(error)) {
        entry.agentId = null;
        entry.rev = null;
        publish(entry, { status: "hidden" });
        await sleep(entry, HIDDEN_RECHECK_MS);
        continue;
      }
      // Keep the last good page, marked stale; back off to a ceiling.
      entry.rev = null;
      if (entry.state.status === "ready") {
        publish(entry, { ...entry.state, stale: true });
      }
      await sleep(entry, backoff);
      backoff = Math.min(backoff * 2, RETRY_MAX_MS);
    }
  }
}

/** Reads the board now (after an action), outside the waiting long-poll. */
async function refreshNow(agentPubkey: string) {
  const entry = entryFor(agentPubkey);
  const agentId = entry.agentId;
  if (!agentId) return;
  const generation = entry.generation;
  try {
    const page = await readOnce(entry, agentId, false);
    if (page && entry.generation === generation) {
      await applyPage(entry, generation, agentId, page);
    }
  } catch {
    // The long-poll picks it up.
  }
}

export function subscribeDelegations(
  agentPubkey: string,
  listener: () => void,
): () => void {
  const entry = entryFor(agentPubkey);
  entry.listeners.add(listener);
  entry.refs += 1;
  if (entry.refs === 1) {
    entry.generation = ++storeGeneration;
    void run(entry, agentPubkey, entry.generation);
  }
  return () => {
    entry.listeners.delete(listener);
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) {
      // Fence the loop; its in-flight read lands nowhere.
      fence(entry);
    }
  };
}

export function getDelegationBoard(agentPubkey: string): DelegationBoardState {
  return entries.get(agentPubkey.toLowerCase())?.state ?? LOADING;
}

function readyAgentId(agentPubkey: string): string {
  const state = getDelegationBoard(agentPubkey);
  if (state.status !== "ready") {
    throw new AgentCallApiError(null, "delegations_unavailable");
  }
  return state.agentId;
}

/** The owner's answer to a worker ask, straight to the worker (§10.1). */
export async function answerDelegationAsk(
  agentPubkey: string,
  askId: string,
  answer: string,
): Promise<void> {
  const agentId = readyAgentId(agentPubkey);
  await request("POST", `agents/${agentId}/delegations/asks/${askId}/answer`, {
    answer,
  });
  await refreshNow(agentPubkey);
}

/** Stops one worker's turn; its session survives. */
export async function cancelDelegation(
  agentPubkey: string,
  delegationId: string,
): Promise<void> {
  const agentId = readyAgentId(agentPubkey);
  await request(
    "POST",
    `agents/${agentId}/delegations/${delegationId}/cancel`,
    {
      reason: "Stopped by the owner from Buzz.",
    },
  );
  await refreshNow(agentPubkey);
}

/** "Stop all": every running delegation of this agent; sessions are kept. */
export async function cancelAllDelegations(
  agentPubkey: string,
): Promise<number> {
  const agentId = readyAgentId(agentPubkey);
  const result = await request<{ cancelledIds?: unknown }>(
    "POST",
    `agents/${agentId}/delegations/cancel-all`,
    { reason: "Stopped by the owner from Buzz." },
  );
  await refreshNow(agentPubkey);
  return Array.isArray(result?.cancelledIds) ? result.cancelledIds.length : 0;
}

/** Community switch: every board and loop goes. */
export function resetDelegationStore() {
  for (const entry of entries.values()) fence(entry);
  entries.clear();
}

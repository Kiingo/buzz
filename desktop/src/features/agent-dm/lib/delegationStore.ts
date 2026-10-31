/**
 * One live delegation board per agent, shared by the DM header and the dock
 * above the composer. The first viewer starts a long-poll on the host's
 * cards route (`rev` + `wait`); the last one to leave stops it. The host
 * answers only the agent's owner (D5): any other reader gets `hidden` and
 * the DM shows the agent's ordinary messages alone.
 *
 * The pending ack ("Starting 2 workers: …") comes from the owner's chat
 * page. It is read whenever the cards change (a start moves them within a
 * second) and re-read every few seconds while it shows, until the agent's
 * own reply clears it or it expires. "Since you last looked" is read once
 * per viewing, when the first page lands.
 *
 * Community-scoped: `resetDelegationStore()` runs in resetCommunityState().
 */

import {
  AgentCallApiError,
  request,
} from "@/features/agent-call/lib/agentCallApi";

import {
  type DelegationAsk,
  type DelegationPage,
  type DelegationPendingAck,
  type DelegationSince,
  delegationChatPath,
  delegationSeenPath,
  delegationSincePath,
  delegationsPath,
  parseDelegationAsks,
  parseDelegationPoll,
  parseDelegationSince,
  parsePendingAck,
  undoStopPath,
} from "./delegations";

export type DelegationBoardState =
  | { status: "loading" }
  /** Not the owner, not a hosted agent, or a host without the routes. */
  | { status: "hidden" }
  | {
      status: "ready";
      /** Null only while the host leaves the agent out of the page. */
      agentId: string | null;
      page: DelegationPage;
      /** Open worker asks, by delegation id. */
      asks: ReadonlyMap<string, DelegationAsk[]>;
      /** The server's instant ack, until the agent's reply replaces it. */
      ack: DelegationPendingAck | null;
      /** What changed since the owner last marked it seen. */
      since: DelegationSince | null;
      /** The last poll failed; the page shown is the last good one. */
      stale: boolean;
    };

const RETRY_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;
/** A hidden board looks again this rarely (ownership can change). */
const HIDDEN_RECHECK_MS = 10 * 60_000;
/** A showing pending ack is re-read this often (it ends within 10 min). */
const ACK_RECHECK_MS = 3_000;

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
  /** The pending-ack reader: its loop's generation, a re-read ask, its wait. */
  ackLoop: number | null;
  ackDirty: boolean;
  ackWake: (() => void) | null;
  /** The generation whose "since" read has run (once per viewing). */
  sinceRead: number | null;
};

const LOADING: DelegationBoardState = { status: "loading" };
const entries = new Map<string, Entry>();
let storeGeneration = 0;

/** A wait the entry can cut short, so a stopped loop holds no timer. */
function sleep(
  entry: Entry,
  ms: number,
  slot: "wake" | "ackWake" = "wake",
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (entry[slot] === done) entry[slot] = null;
      resolve();
    }
    entry[slot] = done;
  });
}

function fence(entry: Entry) {
  entry.generation = ++storeGeneration;
  entry.rev = null;
  entry.wake?.();
  entry.ackWake?.();
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
      ackLoop: null,
      ackDirty: false,
      ackWake: null,
      sinceRead: null,
    };
    entries.set(key, entry);
  }
  return entry;
}

function publish(entry: Entry, state: DelegationBoardState) {
  entry.state = state;
  for (const listener of entry.listeners) listener();
}

/**
 * Not the owner (404), not allowed, or a host without these routes or
 * without Buzz key resolution (400 on `agentPubkey`).
 */
const isRefusal = (error: unknown) =>
  error instanceof AgentCallApiError &&
  (error.status === 400 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 405);

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
  agentPubkey: string,
  wait: boolean,
): Promise<DelegationPage | null> {
  const body = await request<unknown>(
    "GET",
    delegationsPath(agentPubkey, wait ? entry.rev : null),
  );
  const poll = parseDelegationPoll(body);
  if (!poll) throw new AgentCallApiError(null, "delegations_response_invalid");
  entry.rev = poll.kind === "page" ? poll.page.rev : poll.rev;
  return poll.kind === "page" ? poll.page : null;
}

async function applyPage(
  entry: Entry,
  generation: number,
  page: DelegationPage,
) {
  entry.agentId = page.agentId ?? entry.agentId;
  const agentId = entry.agentId;
  const asks = agentId ? await loadAsks(agentId, page) : new Map();
  if (entry.generation !== generation) return;
  const previous = entry.state.status === "ready" ? entry.state : null;
  publish(entry, {
    status: "ready",
    agentId,
    page,
    asks,
    ack: previous?.ack ?? null,
    since: previous?.since ?? null,
    stale: false,
  });
  readAck(entry, generation);
  if (agentId && entry.sinceRead !== generation) {
    entry.sinceRead = generation;
    void readSince(entry, generation, agentId);
  }
}

/** "Since you last looked", once per viewing. */
async function readSince(entry: Entry, generation: number, agentId: string) {
  let since: DelegationSince | null = null;
  try {
    since = parseDelegationSince(
      await request<unknown>("GET", delegationSincePath(agentId)),
    );
  } catch {
    // Display only: no chip this time; the next viewing reads it again.
    return;
  }
  const state = entry.state;
  if (entry.generation === generation && state.status === "ready") {
    publish(entry, { ...state, since });
  }
}

/** The owner chat page's pending ack; null when it cannot be read. */
async function fetchAck(agentId: string): Promise<DelegationPendingAck | null> {
  try {
    const body = await request<unknown>("GET", delegationChatPath(agentId));
    return parsePendingAck(body, Date.now());
  } catch {
    // Display only: no ack row. The next cards change reads it again.
    return null;
  }
}

/**
 * Reads the pending ack now (coalescing repeat asks into one more read),
 * then while it shows re-reads it every few seconds: the agent's reply or
 * its expiry ends it, and so does a stop.
 */
function readAck(entry: Entry, generation: number) {
  entry.ackDirty = true;
  if (entry.ackLoop === generation) {
    entry.ackWake?.();
    return;
  }
  entry.ackLoop = generation;
  void (async () => {
    const live = () => entry.generation === generation && entry.refs > 0;
    try {
      while (live() && entry.agentId) {
        entry.ackDirty = false;
        const ack = await fetchAck(entry.agentId);
        if (!live()) return;
        const state = entry.state;
        if (
          state.status === "ready" &&
          (state.ack?.id !== ack?.id || state.ack?.text !== ack?.text)
        ) {
          publish(entry, { ...state, ack });
        }
        if (!ack && !entry.ackDirty) return;
        if (!entry.ackDirty) {
          const untilExpiry = ack ? ack.expiresAtMs - Date.now() : 0;
          await sleep(
            entry,
            Math.max(0, Math.min(ACK_RECHECK_MS, untilExpiry)),
            "ackWake",
          );
        }
      }
    } finally {
      if (entry.ackLoop === generation) entry.ackLoop = null;
    }
  })();
}

async function run(entry: Entry, agentPubkey: string, generation: number) {
  const live = () => entry.generation === generation && entry.refs > 0;
  let backoff = RETRY_MS;
  while (live()) {
    try {
      const page = await readOnce(entry, agentPubkey, entry.rev !== null);
      if (!live()) return;
      if (page) await applyPage(entry, generation, page);
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
  const generation = entry.generation;
  try {
    const page = await readOnce(entry, agentPubkey, false);
    if (page && entry.generation === generation) {
      await applyPage(entry, generation, page);
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
  if (state.status !== "ready" || !state.agentId) {
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

/**
 * Marks everything up to the chip's newest change as seen (the owner's own
 * cursor) and drops the chip. A failure keeps the chip and rejects.
 */
export async function markDelegationsSeen(agentPubkey: string): Promise<void> {
  const agentId = readyAgentId(agentPubkey);
  const entry = entryFor(agentPubkey);
  const state = entry.state;
  if (state.status !== "ready" || !state.since) return;
  const { since } = state;
  await request("POST", delegationSeenPath(agentId), { at: since.latestAt });
  const current = entry.state;
  if (current.status === "ready" && current.since === since) {
    publish(entry, { ...current, since: null });
  }
}

/** Undo Stop, inside its window: the same work starts again. */
export async function undoStopDelegation(
  agentPubkey: string,
  delegationId: string,
): Promise<void> {
  const agentId = readyAgentId(agentPubkey);
  await request("POST", undoStopPath(agentId, delegationId));
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

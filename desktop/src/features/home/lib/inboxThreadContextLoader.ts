/**
 * Pure loader for the Home inbox thread context (root, ancestor chain, and
 * replies around a selected message). Kept free of React and the relay client
 * so node unit tests can drive it with stub fetchers.
 *
 * Failure policy: a missing or unreadable context event is a property of that
 * one event, not of the page. The loader therefore never reports a page-level
 * error for an ancestor; it reports which ancestor ids it could not resolve so
 * the UI can render an inline placeholder in their place — and only when the
 * event is not already available from the locally cached channel window.
 * Transient relay failures (timeouts, 429s, reconnects) get one retry before
 * they count.
 */

import { getThreadReference } from "@/features/messages/lib/threading";
import type { RelayEvent } from "@/shared/api/types";

/** Maximum number of parent hops walked from the selected message. */
export const MAX_ANCESTOR_HOPS = 50;
/** Delay before the single retry of a failed context fetch. */
export const CONTEXT_FETCH_RETRY_DELAY_MS = 400;

export type InboxThreadContextLoadInput = {
  targetEvent: RelayEvent;
  threadRootId: string;
  parentId: string | null;
  channelId: string | null;
  /** Events already available locally (channel window cache), by id. */
  lookupLocalEvent: (eventId: string) => RelayEvent | undefined;
  fetchEventById: (eventId: string) => Promise<RelayEvent>;
  /** Fetch replies referencing `rootId` in `channelId`. */
  fetchReplies: (channelId: string, rootId: string) => Promise<RelayEvent[]>;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type InboxThreadContextLoadResult = {
  /** Root/ancestor/reply events resolved by this load (unfiltered). */
  events: RelayEvent[];
  /**
   * Root/ancestor ids that could not be resolved (deleted, no longer
   * readable, or a fetch that failed twice). The UI renders a quiet inline
   * placeholder for each one that is still absent from the merged context.
   */
  unavailableEventIds: string[];
  /** True when the replies fetch failed twice. */
  repliesFailed: boolean;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function withOneRetry<T>(
  operation: () => Promise<T>,
  retryDelayMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await operation() };
  } catch {
    await sleep(retryDelayMs);
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      return { ok: false, error };
    }
  }
}

/**
 * Resolve the root, the ancestor chain of the selected message, and the
 * thread's replies. Ancestors found in the local cache are used directly and
 * never fetched, so a relay hiccup cannot flag context the user can already
 * see.
 */
export async function loadInboxThreadContext(
  input: InboxThreadContextLoadInput,
): Promise<InboxThreadContextLoadResult> {
  const {
    targetEvent,
    threadRootId,
    parentId,
    channelId,
    lookupLocalEvent,
    fetchEventById,
    fetchReplies,
  } = input;
  const retryDelayMs = input.retryDelayMs ?? CONTEXT_FETCH_RETRY_DELAY_MS;
  const sleep = input.sleep ?? defaultSleep;

  const ancestorsPromise = (async () => {
    const eventsById = new Map<string, RelayEvent>();
    const unavailable: string[] = [];

    const resolveEvent = async (eventId: string) => {
      if (eventId === targetEvent.id) {
        return targetEvent;
      }
      const known = eventsById.get(eventId) ?? lookupLocalEvent(eventId);
      if (known) {
        eventsById.set(eventId, known);
        return known;
      }
      const result = await withOneRetry(
        () => fetchEventById(eventId),
        retryDelayMs,
        sleep,
      );
      if (!result.ok || result.value.id !== eventId) {
        if (!unavailable.includes(eventId)) {
          unavailable.push(eventId);
        }
        return null;
      }
      eventsById.set(eventId, result.value);
      return result.value;
    };

    if (threadRootId !== targetEvent.id) {
      await resolveEvent(threadRootId);
    }

    let ancestorId = parentId;
    const seen = new Set<string>([targetEvent.id]);
    let hops = 0;
    while (ancestorId && !seen.has(ancestorId) && hops < MAX_ANCESTOR_HOPS) {
      seen.add(ancestorId);
      const ancestor = await resolveEvent(ancestorId);
      if (!ancestor || ancestorId === threadRootId) {
        break;
      }
      ancestorId = getThreadReference(ancestor.tags).parentId;
      hops += 1;
    }

    return { events: [...eventsById.values()], unavailable };
  })();

  const repliesPromise = channelId
    ? withOneRetry(
        () => fetchReplies(channelId, threadRootId),
        retryDelayMs,
        sleep,
      )
    : Promise.resolve({ ok: true as const, value: [] as RelayEvent[] });

  const [ancestors, replies] = await Promise.all([
    ancestorsPromise,
    repliesPromise,
  ]);
  if (!replies.ok) {
    console.warn(
      "Inbox thread replies could not be loaded",
      channelId,
      threadRootId,
      replies.error,
    );
  }
  if (ancestors.unavailable.length > 0) {
    console.warn(
      "Inbox thread context events unavailable",
      ancestors.unavailable,
    );
  }

  return {
    events: [...ancestors.events, ...(replies.ok ? replies.value : [])],
    unavailableEventIds: ancestors.unavailable,
    repliesFailed: !replies.ok,
  };
}

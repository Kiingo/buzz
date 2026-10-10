import * as React from "react";

import {
  isInboxDmContextEvent,
  isInboxThreadContextEvent,
} from "@/features/home/lib/inboxViewHelpers";
import { relayEventFromFeedItem } from "@/features/home/lib/inbox";
import { loadInboxThreadContext } from "@/features/home/lib/inboxThreadContextLoader";
import { fetchStructuralAuxForMessages } from "@/features/messages/lib/auxBackfill";
import { getThreadReference } from "@/features/messages/lib/threading";
import { relayClient } from "@/shared/api/relayClient";
import { buildChannelReactionAuxFilter } from "@/shared/api/relayChannelFilters";
import { getEventById } from "@/shared/api/tauri";
import type { FeedItem, RelayEvent } from "@/shared/api/types";
import { HOME_MENTION_EVENT_KINDS } from "@/shared/constants/kinds";

type InboxThreadContextResult = {
  events: RelayEvent[];
  /**
   * Root/ancestor ids that could not be loaded and are absent from `events`
   * (deleted or no longer readable). Rendered as inline placeholders, never as
   * a page-level error.
   */
  unavailableEventIds: string[];
  /** Replies (or, for DMs, the conversation window) failed to load. */
  hasRepliesLoadError: boolean;
  /** Re-run the context load after a failure. */
  retry: () => void;
  isLoading: boolean;
  /** Edits/deletions referencing context messages, fetched by `#e`. */
  structuralEvents: RelayEvent[];
  /** Re-fetch structural events after an Inbox edit is published. */
  refreshStructuralEvents: () => Promise<void>;
  /** kind:7 events referencing the context messages, fetched by `#e`. */
  reactionEvents: RelayEvent[];
  /** Re-fetch reaction events (e.g. after a toggle) without reloading context. */
  refreshReactions: () => Promise<void>;
};

const THREAD_CONTEXT_LIMIT = 100;
const EMPTY_IDS: string[] = [];

function dedupeEvents(events: RelayEvent[]): RelayEvent[] {
  const eventsById = new Map<string, RelayEvent>();
  for (const event of events) {
    eventsById.set(event.id, event);
  }
  return [...eventsById.values()].sort((a, b) => a.created_at - b.created_at);
}

function getThreadRootId(event: RelayEvent): string {
  const thread = getThreadReference(event.tags);
  return thread.rootId ?? thread.parentId ?? event.id;
}

export function useInboxThreadContext(
  item: FeedItem | null,
  channelMessages: RelayEvent[] | undefined,
  options: {
    fullChannel?: boolean;
    hasChannelLoadError?: boolean;
    isChannelLoading?: boolean;
    /** Refetch the channel window (the DM context source) on retry. */
    refetchChannel?: () => unknown;
  } = {},
): InboxThreadContextResult {
  const [fetchedEvents, setFetchedEvents] = React.useState<RelayEvent[]>([]);
  const [unavailableEventIds, setUnavailableEventIds] = React.useState<
    string[]
  >([]);
  const [hasRepliesLoadError, setHasRepliesLoadError] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);

  const selectedEvent = React.useMemo(
    () => (item ? relayEventFromFeedItem(item) : null),
    [item],
  );

  const selectedThreadRootId = selectedEvent
    ? getThreadRootId(selectedEvent)
    : null;
  const selectedParentId = selectedEvent
    ? getThreadReference(selectedEvent.tags).parentId
    : null;
  const selectedChannelId = item?.channelId ?? null;
  const fullChannel = options.fullChannel === true;

  // The effect reads the channel window through a ref: it is a lookup source
  // for ancestors, not a reason to refetch context on every live message.
  const channelMessagesRef = React.useRef(channelMessages);
  React.useEffect(() => {
    channelMessagesRef.current = channelMessages;
  }, [channelMessages]);
  const [reloadToken, setReloadToken] = React.useState(0);
  const { hasChannelLoadError, refetchChannel } = options;
  const retry = React.useCallback(() => {
    setReloadToken((token) => token + 1);
    if (hasChannelLoadError) {
      void refetchChannel?.();
    }
  }, [hasChannelLoadError, refetchChannel]);

  React.useEffect(() => {
    let isCancelled = false;
    void reloadToken;

    if (fullChannel || !selectedEvent || !selectedThreadRootId) {
      setFetchedEvents([]);
      setUnavailableEventIds([]);
      setHasRepliesLoadError(false);
      setIsLoading(false);
      return () => {
        isCancelled = true;
      };
    }

    const targetEvent = selectedEvent;
    const threadRootId = selectedThreadRootId;
    const selection = {
      selectedChannelId,
      selectedEventId: targetEvent.id,
      selectedParentId,
      selectedThreadRootId: threadRootId,
    };

    setIsLoading(true);
    setHasRepliesLoadError(false);
    setUnavailableEventIds([]);

    void loadInboxThreadContext({
      channelId: selectedChannelId,
      fetchEventById: getEventById,
      fetchReplies: (channelId, rootId) =>
        relayClient.fetchEvents({
          "#e": [rootId],
          "#h": [channelId],
          kinds: [...HOME_MENTION_EVENT_KINDS],
          limit: THREAD_CONTEXT_LIMIT,
        }),
      lookupLocalEvent: (eventId) =>
        channelMessagesRef.current?.find((event) => event.id === eventId),
      parentId: selectedParentId,
      targetEvent,
      threadRootId,
    })
      .then((result) => {
        if (isCancelled) {
          return;
        }
        setUnavailableEventIds(result.unavailableEventIds);
        setHasRepliesLoadError(result.repliesFailed);
        setFetchedEvents(
          dedupeEvents(
            result.events.filter((event) =>
              isInboxThreadContextEvent(event, selection),
            ),
          ),
        );
      })
      .catch((error) => {
        if (!isCancelled) {
          console.error("Failed to load Inbox message context", error);
          setHasRepliesLoadError(true);
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [
    selectedChannelId,
    selectedEvent,
    selectedParentId,
    selectedThreadRootId,
    fullChannel,
    reloadToken,
  ]);

  const events = React.useMemo(() => {
    if (!selectedEvent) {
      return [];
    }

    if (fullChannel) {
      return dedupeEvents([
        selectedEvent,
        ...(channelMessages ?? []).filter(isInboxDmContextEvent),
      ]);
    }

    const localContext = (channelMessages ?? []).filter((event) => {
      return isInboxThreadContextEvent(event, {
        selectedChannelId,
        selectedEventId: selectedEvent.id,
        selectedParentId,
        selectedThreadRootId,
      });
    });

    const currentFetchedEvents = fetchedEvents.filter((event) =>
      isInboxThreadContextEvent(event, {
        selectedChannelId,
        selectedEventId: selectedEvent.id,
        selectedParentId,
        selectedThreadRootId,
      }),
    );

    return dedupeEvents([
      selectedEvent,
      ...currentFetchedEvents,
      ...localContext,
    ]);
  }, [
    channelMessages,
    fetchedEvents,
    fullChannel,
    selectedChannelId,
    selectedEvent,
    selectedParentId,
    selectedThreadRootId,
  ]);

  const visibleUnavailableEventIds = React.useMemo(() => {
    if (fullChannel || unavailableEventIds.length === 0) {
      return EMPTY_IDS;
    }
    const presentIds = new Set(events.map((event) => event.id));
    const missing = unavailableEventIds.filter((id) => !presentIds.has(id));
    return missing.length === 0 ? EMPTY_IDS : missing;
  }, [events, fullChannel, unavailableEventIds]);

  // Auxiliary events carry only an `#e` reference, so they may be absent from
  // both the selected feed item and the channel-window cache. Hydrate them by
  // the context message ids so cold Inbox items receive edits, deletions, and
  // reactions without requiring the full channel timeline to be open.
  const contextEventIdsKey = React.useMemo(
    () =>
      events
        .map((event) => event.id)
        .sort()
        .join(","),
    [events],
  );
  const [structuralEvents, setStructuralEvents] = React.useState<RelayEvent[]>(
    [],
  );

  const fetchStructuralEvents = React.useCallback(async (): Promise<
    RelayEvent[] | null
  > => {
    const eventIds = contextEventIdsKey ? contextEventIdsKey.split(",") : [];
    if (!selectedChannelId || eventIds.length === 0) {
      return [];
    }

    try {
      // Two hops, not one. A deletion can target an edit event rather than the
      // original message, and `formatTimelineMessages` drops an edit only when
      // the edit's own id is in the deletion set. A one-hop fetch therefore
      // re-applies retracted content on a cold Inbox open. The channel and
      // thread paths already resolve this closure with the same helper.
      return await fetchStructuralAuxForMessages(selectedChannelId, eventIds);
    } catch (error) {
      console.error(
        "Failed to hydrate structural events for Inbox context messages",
        selectedChannelId,
        error,
      );
      return null;
    }
  }, [contextEventIdsKey, selectedChannelId]);

  React.useEffect(() => {
    let isCancelled = false;
    setStructuralEvents([]);

    void fetchStructuralEvents().then((fetched) => {
      if (!isCancelled && fetched !== null) {
        setStructuralEvents(fetched);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [fetchStructuralEvents]);

  const refreshStructuralEvents = React.useCallback(async () => {
    const fetched = await fetchStructuralEvents();
    if (fetched !== null) {
      setStructuralEvents(fetched);
    }
  }, [fetchStructuralEvents]);

  const [reactionEvents, setReactionEvents] = React.useState<RelayEvent[]>([]);

  const fetchReactions = React.useCallback(async (): Promise<
    RelayEvent[] | null
  > => {
    const eventIds = contextEventIdsKey ? contextEventIdsKey.split(",") : [];
    if (!selectedChannelId || eventIds.length === 0) {
      return [];
    }

    try {
      return await relayClient.fetchAuxEventsByReference(
        selectedChannelId,
        eventIds,
        buildChannelReactionAuxFilter,
      );
    } catch (error) {
      console.error(
        "Failed to hydrate reactions for Inbox context messages",
        selectedChannelId,
        error,
      );
      return null;
    }
  }, [contextEventIdsKey, selectedChannelId]);

  React.useEffect(() => {
    let isCancelled = false;
    setReactionEvents([]);

    void fetchReactions().then((fetched) => {
      if (!isCancelled && fetched !== null) {
        setReactionEvents(fetched);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [fetchReactions]);

  const refreshReactions = React.useCallback(async () => {
    const fetched = await fetchReactions();
    if (fetched !== null) {
      setReactionEvents(fetched);
    }
  }, [fetchReactions]);

  return {
    events,
    unavailableEventIds: visibleUnavailableEventIds,
    hasRepliesLoadError: fullChannel
      ? options.hasChannelLoadError === true
      : hasRepliesLoadError,
    retry,
    isLoading: fullChannel ? options.isChannelLoading === true : isLoading,
    structuralEvents,
    refreshStructuralEvents,
    reactionEvents,
    refreshReactions,
  };
}

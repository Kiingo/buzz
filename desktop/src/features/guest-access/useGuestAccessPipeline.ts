import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { subscribeAgentObserverStore } from "@/features/agents/observerRelayStore";
import { relayClient } from "@/shared/api/relayClient";
import type { HomeFeedResponse, RelayEvent } from "@/shared/api/types";

import { useGuestAccessEnabled, useOwnerPubkey } from "./hooks";
import { guestAccessApi, toGuestAccessError } from "./lib/client";
import {
  createNotifierTrust,
  GUEST_NOTIFICATION_KINDS,
  parseGuestNotification,
} from "./lib/notifications";
import {
  getGuestAccessSnapshot,
  mergeGuestApprovalFeed,
  openApprovalReview,
  reconcilePendingApprovals,
  recordApprovalRequested,
  recordApprovalResolved,
  recordEndpointStatus,
  recordGuestAlert,
  subscribeGuestAccessStore,
} from "./lib/store";

const HISTORY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const POLL_INTERVAL_MS = 60_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export const HOME_FEED_QUERY_KEY = ["home-feed"] as const;

async function fetchProfileEvent(pubkey: string): Promise<RelayEvent | null> {
  const events = await relayClient.fetchEvents({
    kinds: [0],
    authors: [pubkey],
    limit: 1,
  });
  return [...events].sort((a, b) => b.created_at - a.created_at)[0] ?? null;
}

/** Parse `guest_endpoint_status` observer payloads (contracts §14). */
export function parseEndpointStatusPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;
  const status = typeof raw.status === "string" ? raw.status : null;
  if (!status) return null;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      if (typeof raw[key] === "string") return raw[key] as string;
    }
    return null;
  };
  return {
    status,
    linkUrl: pick("link_url", "linkUrl"),
    classifierMode: pick("classifier_mode", "classifierMode"),
    guestEndpointId: pick("guest_endpoint_id", "guestEndpointId"),
  };
}

/**
 * Owner-side guest-access feed: trusted 46040–46042 notifications (history
 * plus live), the authoritative pending-approvals poll, harness endpoint
 * status, and the Inbox projection of pending approvals. Mount once.
 */
export function useGuestAccessPipeline() {
  const enabled = useGuestAccessEnabled();
  const ownerPubkey = useOwnerPubkey();
  const queryClient = useQueryClient();
  const managedAgents = useManagedAgentsQuery({ enabled });
  const localAgentsRef = React.useRef<ReadonlySet<string>>(new Set());
  const [ownerUnlinked, setOwnerUnlinked] = React.useState(false);

  React.useEffect(() => {
    localAgentsRef.current = new Set(
      (managedAgents.data ?? []).map((agent) => agent.pubkey.toLowerCase()),
    );
  }, [managedAgents.data]);

  // Keep the Inbox's Needs Action list in step with the pending set.
  React.useEffect(
    () =>
      subscribeGuestAccessStore(() => {
        queryClient.setQueryData<HomeFeedResponse>(
          HOME_FEED_QUERY_KEY,
          (feed) => (feed ? mergeGuestApprovalFeed(feed) : feed),
        );
      }),
    [queryClient],
  );

  // Notifications: history first, then live. Only the owner's own agents
  // are trusted to author them.
  React.useEffect(() => {
    if (!enabled || !ownerPubkey) return;
    let cancelled = false;
    let dispose: (() => Promise<void>) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const startedAt = Math.floor(Date.now() / 1000);
    const isTrusted = createNotifierTrust({
      ownerPubkey,
      localAgentPubkeys: () => localAgentsRef.current,
      fetchProfileEvent,
      verifyProfileOwner: (json) => guestAccessApi.profileOwner(json),
    });

    const handle = async (event: RelayEvent, live: boolean) => {
      const parsed = parseGuestNotification(event, ownerPubkey);
      if (!parsed || !(await isTrusted(parsed.author)) || cancelled) return;
      if (parsed.type === "requested") {
        recordApprovalRequested({
          approvalId: parsed.approvalId,
          eventId: parsed.eventId,
          agentPubkey: parsed.agentPubkey,
          agentName: null,
          requesterName: null,
          summary: parsed.content,
          createdAt: parsed.createdAt,
        });
        if (
          live &&
          parsed.createdAt >= startedAt - 60 &&
          getGuestAccessSnapshot().openApprovalId === null
        ) {
          openApprovalReview(parsed.approvalId);
        }
      } else if (parsed.type === "resolved") {
        recordApprovalResolved(parsed.approvalId);
      } else {
        recordGuestAlert({
          alertId: parsed.alertId,
          eventId: parsed.eventId,
          agentPubkey: parsed.agentPubkey,
          severity: parsed.severity,
          content: parsed.content,
          createdAt: parsed.createdAt,
        });
      }
    };

    const filter = {
      kinds: [...GUEST_NOTIFICATION_KINDS],
      "#p": [ownerPubkey],
    };

    const start = async () => {
      try {
        const history = await relayClient.fetchEvents({
          ...filter,
          since: startedAt - HISTORY_WINDOW_SECONDS,
          limit: 200,
        });
        // Oldest first so a later 46041 clears its 46040.
        for (const event of [...history].sort(
          (a, b) => a.created_at - b.created_at,
        )) {
          await handle(event, false);
        }
        if (cancelled) return;
        const unsubscribe = await relayClient.subscribeLive(
          { ...filter, since: startedAt, limit: 50 },
          (event) => {
            void handle(event, true);
          },
        );
        if (cancelled) {
          void unsubscribe();
          return;
        }
        dispose = unsubscribe;
        attempt = 0;
      } catch (error) {
        if (cancelled) return;
        console.warn("Guest access notifications unavailable; retrying", error);
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
        attempt = Math.min(attempt + 1, 5);
        retryTimer = setTimeout(() => void start(), delay);
      }
    };
    void start();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (dispose) void dispose();
    };
  }, [enabled, ownerPubkey]);

  // The decision API is the system of record: poll pending approvals so the
  // inbox is right even before notifications arrive or after one is missed.
  React.useEffect(() => {
    if (!enabled || !ownerPubkey || ownerUnlinked) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (document.visibilityState !== "hidden") {
        try {
          const approvals = await guestAccessApi.pendingApprovals();
          if (!cancelled) reconcilePendingApprovals(approvals);
        } catch (error) {
          const routeError = toGuestAccessError(error);
          if (routeError.code === "owner_not_linked") {
            if (!cancelled) setOwnerUnlinked(true);
            return;
          }
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, ownerPubkey, ownerUnlinked]);

  // Harness registration results (contracts §14).
  React.useEffect(() => {
    if (!enabled) return;
    return subscribeAgentObserverStore((update) => {
      if (!update) return;
      for (const event of update.events) {
        if (event.kind !== "guest_endpoint_status") continue;
        const status = parseEndpointStatusPayload(event.payload);
        if (status) recordEndpointStatus(update.agentPubkey, status);
      }
    });
  }, [enabled]);

  return { enabled, ownerUnlinked, setOwnerUnlinked };
}

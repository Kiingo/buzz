/**
 * Community-scoped state for owner-side guest access: pending approvals (from
 * trusted 46040 notifications and the pending-approvals poll), resolved ids
 * (46041 or a decision made here), alerts (46042), the review dialog's open
 * request, and per-agent endpoint status from harness observer frames.
 *
 * Pending approvals surface in the Inbox as synthetic kind-46040 Needs Action
 * items, the way workflow approvals (46010) do. `resetGuestAccessStore` is
 * wired into `resetCommunityState()`.
 */

import type { FeedItem, HomeFeedResponse } from "@/shared/api/types";

import { KIND_GUEST_APPROVAL_REQUESTED } from "./notifications";
import type { GuestApproval } from "./wire";

export type PendingApprovalEntry = {
  approvalId: string;
  /** The 46040 event id when the request arrived as a notification. */
  eventId: string | null;
  agentPubkey: string | null;
  agentName: string | null;
  requesterName: string | null;
  summary: string;
  createdAt: number;
};

export type GuestAlert = {
  alertId: string;
  eventId: string;
  agentPubkey: string;
  severity: "high" | "info";
  content: string;
  createdAt: number;
};

export type EndpointStatus = {
  status: string;
  linkUrl: string | null;
  classifierMode: string | null;
  guestEndpointId: string | null;
};

export type GuestAccessSnapshot = {
  pending: readonly PendingApprovalEntry[];
  alerts: readonly GuestAlert[];
  openApprovalId: string | null;
  endpointStatus: Readonly<Record<string, EndpointStatus>>;
};

const EMPTY: GuestAccessSnapshot = {
  pending: [],
  alerts: [],
  openApprovalId: null,
  endpointStatus: {},
};

let pending = new Map<string, PendingApprovalEntry>();
let resolved = new Set<string>();
let alerts = new Map<string, GuestAlert>();
let dismissedAlerts = new Set<string>();
let openApprovalId: string | null = null;
let endpointStatus: Record<string, EndpointStatus> = {};
let snapshot: GuestAccessSnapshot = EMPTY;
const listeners = new Set<() => void>();

function publish() {
  snapshot = {
    pending: [...pending.values()].sort((a, b) => b.createdAt - a.createdAt),
    alerts: [...alerts.values()]
      .filter((alert) => !dismissedAlerts.has(alert.alertId))
      .sort((a, b) => b.createdAt - a.createdAt),
    openApprovalId,
    endpointStatus,
  };
  for (const listener of listeners) listener();
}

export function subscribeGuestAccessStore(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getGuestAccessSnapshot(): GuestAccessSnapshot {
  return snapshot;
}

/** Record a pending approval. Ignored once that id has resolved. */
export function recordApprovalRequested(entry: PendingApprovalEntry) {
  if (resolved.has(entry.approvalId)) return;
  const existing = pending.get(entry.approvalId);
  pending.set(entry.approvalId, {
    ...entry,
    eventId: entry.eventId ?? existing?.eventId ?? null,
    agentName: entry.agentName ?? existing?.agentName ?? null,
    requesterName: entry.requesterName ?? existing?.requesterName ?? null,
    createdAt: existing
      ? Math.min(existing.createdAt, entry.createdAt)
      : entry.createdAt,
  });
  publish();
}

/** Clear an approval (46041, a decision made here, or the poll's verdict). */
export function recordApprovalResolved(approvalId: string) {
  resolved.add(approvalId);
  const changed = pending.delete(approvalId);
  if (openApprovalId === approvalId) {
    openApprovalId = null;
    publish();
    return;
  }
  if (changed) publish();
}

/**
 * The pending-approvals poll is authoritative for what is still pending:
 * anything it no longer lists has been decided, expired or cancelled.
 */
export function reconcilePendingApprovals(approvals: readonly GuestApproval[]) {
  const listed = new Set(approvals.map((approval) => approval.approvalId));
  for (const approvalId of [...pending.keys()]) {
    if (!listed.has(approvalId)) {
      pending.delete(approvalId);
      resolved.add(approvalId);
    }
  }
  for (const approval of approvals) {
    if (approval.state !== "pending" || resolved.has(approval.approvalId)) {
      continue;
    }
    const existing = pending.get(approval.approvalId);
    const createdAt = approval.createdAt
      ? Math.floor(Date.parse(approval.createdAt) / 1000)
      : Math.floor(Date.now() / 1000);
    pending.set(approval.approvalId, {
      approvalId: approval.approvalId,
      eventId: existing?.eventId ?? null,
      agentPubkey: approval.agent.pubkey ?? existing?.agentPubkey ?? null,
      agentName: approval.agent.displayName ?? existing?.agentName ?? null,
      requesterName:
        approval.requester.displayName ?? existing?.requesterName ?? null,
      summary: existing?.summary || approvalSummary(approval),
      createdAt: existing?.createdAt ?? createdAt,
    });
  }
  publish();
}

/** One-line inbox summary that never includes the question or the draft. */
export function approvalSummary(approval: GuestApproval): string {
  const who = approval.requester.displayName ?? "Someone";
  const agent = approval.agent.displayName ?? "your agent";
  return `${who} asked ${agent} something that needs your approval.`;
}

export function openApprovalReview(approvalId: string) {
  openApprovalId = approvalId;
  publish();
}

export function closeApprovalReview() {
  if (openApprovalId === null) return;
  openApprovalId = null;
  publish();
}

export function recordGuestAlert(alert: GuestAlert) {
  if (alerts.has(alert.alertId)) return;
  alerts.set(alert.alertId, alert);
  publish();
}

export function dismissGuestAlert(alertId: string) {
  dismissedAlerts.add(alertId);
  publish();
}

export function recordEndpointStatus(
  agentPubkey: string,
  status: EndpointStatus,
) {
  endpointStatus = { ...endpointStatus, [agentPubkey.toLowerCase()]: status };
  publish();
}

export function resetGuestAccessStore() {
  pending = new Map();
  resolved = new Set();
  alerts = new Map();
  dismissedAlerts = new Set();
  openApprovalId = null;
  endpointStatus = {};
  snapshot = EMPTY;
  for (const listener of listeners) listener();
}

/** Inbox id for a pending approval: the notification event, else synthetic. */
export function guestApprovalFeedItemId(entry: PendingApprovalEntry): string {
  return entry.eventId ?? `guest-approval-${entry.approvalId}`;
}

export function isGuestApprovalFeedItem(item: Pick<FeedItem, "kind">) {
  return item.kind === KIND_GUEST_APPROVAL_REQUESTED;
}

/** The approval id carried by a synthetic or notification-backed feed item. */
export function guestApprovalIdOf(item: Pick<FeedItem, "tags">): string | null {
  return item.tags.find((tag) => tag[0] === "buzz-guest-approval")?.[1] ?? null;
}

export function toGuestApprovalFeedItem(entry: PendingApprovalEntry): FeedItem {
  return {
    id: guestApprovalFeedItemId(entry),
    kind: KIND_GUEST_APPROVAL_REQUESTED,
    pubkey: entry.agentPubkey ?? "",
    content: entry.summary,
    createdAt: entry.createdAt,
    channelId: null,
    channelName: "",
    tags: [
      ["buzz-guest-approval", entry.approvalId],
      ...(entry.agentPubkey ? [["agent", entry.agentPubkey]] : []),
    ],
    category: "needs_action",
  };
}

/**
 * Replace every guest-approval item in the home feed's Needs Action list with
 * the current pending set. Idempotent, so it runs both after each feed fetch
 * and whenever the store changes.
 */
export function mergeGuestApprovalFeed(
  feed: HomeFeedResponse,
  entries: readonly PendingApprovalEntry[] = snapshot.pending,
): HomeFeedResponse {
  const others = feed.feed.needsAction.filter(
    (item) => !isGuestApprovalFeedItem(item),
  );
  if (entries.length === 0 && others.length === feed.feed.needsAction.length) {
    return feed;
  }
  const needsAction = [...others, ...entries.map(toGuestApprovalFeedItem)].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
  return { ...feed, feed: { ...feed.feed, needsAction } };
}

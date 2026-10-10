/**
 * Owner notifications for agent guest access (contracts §5.3, v1.4):
 * 46040 approval requested, 46041 approval resolved, 46042 alert. Each is a
 * stored event addressed to the owner by one `p` tag and signed by one of the
 * owner's own agents. Content is a non-sensitive one-liner; the question and
 * draft are only ever fetched from the decision API.
 */

import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_GUEST_ALERT,
  KIND_GUEST_APPROVAL_REQUEST as KIND_GUEST_APPROVAL_REQUESTED,
  KIND_GUEST_APPROVAL_RESOLVED,
} from "@/shared/constants/kinds";

export {
  KIND_GUEST_ALERT,
  KIND_GUEST_APPROVAL_REQUESTED,
  KIND_GUEST_APPROVAL_RESOLVED,
};

export const GUEST_NOTIFICATION_KINDS = [
  KIND_GUEST_APPROVAL_REQUESTED,
  KIND_GUEST_APPROVAL_RESOLVED,
  KIND_GUEST_ALERT,
] as const;

const HEX64 = /^[0-9a-f]{64}$/;
const CORRELATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type GuestNotification =
  | {
      type: "requested";
      eventId: string;
      author: string;
      approvalId: string;
      agentPubkey: string;
      content: string;
      createdAt: number;
      expiresAt: number | null;
    }
  | {
      type: "resolved";
      eventId: string;
      author: string;
      approvalId: string;
      agentPubkey: string;
      status: "approved" | "denied" | "expired" | "cancelled";
      createdAt: number;
    }
  | {
      type: "alert";
      eventId: string;
      author: string;
      alertId: string;
      agentPubkey: string;
      severity: "high" | "info";
      content: string;
      createdAt: number;
    };

function tagValues(event: RelayEvent, name: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === name && typeof tag[1] === "string")
    .map((tag) => tag[1]);
}

function single(event: RelayEvent, name: string): string | null {
  const values = tagValues(event, name);
  return values.length === 1 ? values[0] : null;
}

/**
 * Parse an owner notification addressed to `ownerPubkey`, or `null` when the
 * event is malformed, addressed to someone else, self-authored, or expired.
 * Mirrors the relay's ingest envelope checks so a relay that skipped them
 * still cannot put a malformed request in the inbox.
 */
export function parseGuestNotification(
  event: RelayEvent,
  ownerPubkey: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): GuestNotification | null {
  const owner = ownerPubkey.toLowerCase();
  const author = event.pubkey.toLowerCase();
  const pTags = tagValues(event, "p");
  if (pTags.length !== 1 || pTags[0].toLowerCase() !== owner) return null;
  if (author === owner || tagValues(event, "h").length > 0) return null;
  const agentPubkey = single(event, "agent")?.toLowerCase() ?? null;
  if (!agentPubkey || !HEX64.test(agentPubkey)) return null;
  const content = (event.content ?? "").slice(0, 512);

  if (event.kind === KIND_GUEST_APPROVAL_REQUESTED) {
    const approvalId = single(event, "buzz-guest-approval");
    if (!approvalId || !CORRELATION_ID.test(approvalId)) return null;
    const expiration = Number(single(event, "expiration"));
    const expiresAt = Number.isFinite(expiration) ? expiration : null;
    if (expiresAt !== null && expiresAt <= nowSeconds) return null;
    return {
      type: "requested",
      eventId: event.id,
      author,
      approvalId,
      agentPubkey,
      content,
      createdAt: event.created_at,
      expiresAt,
    };
  }
  if (event.kind === KIND_GUEST_APPROVAL_RESOLVED) {
    const approvalId = single(event, "buzz-guest-approval");
    const status = single(event, "status");
    if (!approvalId || !CORRELATION_ID.test(approvalId)) return null;
    if (
      status !== "approved" &&
      status !== "denied" &&
      status !== "expired" &&
      status !== "cancelled"
    ) {
      return null;
    }
    return {
      type: "resolved",
      eventId: event.id,
      author,
      approvalId,
      agentPubkey,
      status,
      createdAt: event.created_at,
    };
  }
  if (event.kind === KIND_GUEST_ALERT) {
    const alertId = single(event, "buzz-guest-alert");
    const severity = single(event, "severity");
    if (!alertId || !CORRELATION_ID.test(alertId)) return null;
    if (severity !== "high" && severity !== "info") return null;
    return {
      type: "alert",
      eventId: event.id,
      author,
      alertId,
      agentPubkey,
      severity,
      content,
      createdAt: event.created_at,
    };
  }
  return null;
}

/**
 * Decides whether an author is one of the owner's own agents. Local managed
 * agents are trusted outright (this Desktop created their keys); any other
 * author must present a signed kind:0 whose NIP-OA `auth` tag verifies to the
 * owner. Results are cached per author; a failed lookup is not cached so a
 * transient relay error does not permanently hide notifications.
 */
export function createNotifierTrust(deps: {
  ownerPubkey: string;
  localAgentPubkeys: () => ReadonlySet<string>;
  fetchProfileEvent: (pubkey: string) => Promise<RelayEvent | null>;
  verifyProfileOwner: (profileEventJson: string) => Promise<string | null>;
}) {
  const verdicts = new Map<string, boolean>();
  const inflight = new Map<string, Promise<boolean>>();
  const owner = deps.ownerPubkey.toLowerCase();

  async function resolve(author: string): Promise<boolean> {
    const profile = await deps.fetchProfileEvent(author);
    if (!profile || profile.pubkey.toLowerCase() !== author) return false;
    const verifiedOwner = await deps.verifyProfileOwner(
      JSON.stringify(profile),
    );
    return verifiedOwner?.toLowerCase() === owner;
  }

  return async function isTrusted(pubkey: string): Promise<boolean> {
    const author = pubkey.toLowerCase();
    if (author === owner) return false;
    if (deps.localAgentPubkeys().has(author)) return true;
    const cached = verdicts.get(author);
    if (cached !== undefined) return cached;
    let pending = inflight.get(author);
    if (!pending) {
      pending = resolve(author)
        .then((trusted) => {
          verdicts.set(author, trusted);
          return trusted;
        })
        .catch(() => false)
        .finally(() => inflight.delete(author));
      inflight.set(author, pending);
    }
    return pending;
  };
}

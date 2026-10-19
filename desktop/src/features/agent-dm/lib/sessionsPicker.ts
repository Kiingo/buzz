import type { RelayEvent } from "@/shared/api/types";

import {
  areAgentDmMarkersHonoured,
  KIND_AGENT_DM_QUIET,
  parseSessionsListing,
  type AgentSessionsListing,
  type DmChannelLike,
} from "./markers";

/** A listing younger than this is reused instead of asking again. */
export const LISTING_REUSE_SECONDS = 120;
/** How long the picker waits for the agent to answer `/sessions`. */
export const LISTING_WAIT_MS = 15_000;
// Agent and client clocks differ slightly; a reply may be stamped just
// before our request's own second.
const REPLY_CLOCK_SKEW_SECONDS = 5;

export const SESSIONS_LIST_COMMAND = "/sessions";
export const NEW_SESSION_COMMAND = "/new";

export function loadSessionCommand(sessionId: string, catchup: boolean) {
  return catchup
    ? `/sessions load ${sessionId} catchup`
    : `/sessions load ${sessionId}`;
}

export type ListingEvent = {
  eventId: string;
  createdAt: number;
  listing: AgentSessionsListing;
};

function listingEvents(
  events: readonly RelayEvent[],
  channel: DmChannelLike,
  agentPubkey: string,
): ListingEvent[] {
  const agent = agentPubkey.toLowerCase();
  const found: ListingEvent[] = [];
  for (const event of events) {
    if (
      event.kind !== KIND_AGENT_DM_QUIET ||
      event.pubkey.toLowerCase() !== agent ||
      !areAgentDmMarkersHonoured(channel, event.pubkey)
    ) {
      continue;
    }
    const listing = parseSessionsListing(event.tags);
    if (listing) {
      found.push({ eventId: event.id, createdAt: event.created_at, listing });
    }
  }
  return found.sort((a, b) => b.createdAt - a.createdAt);
}

/** The newest listing from the agent when it is under two minutes old. */
export function findFreshListing(
  events: readonly RelayEvent[],
  channel: DmChannelLike,
  agentPubkey: string,
  nowSeconds: number,
): ListingEvent | null {
  const newest = listingEvents(events, channel, agentPubkey)[0];
  return newest && nowSeconds - newest.createdAt < LISTING_REUSE_SECONDS
    ? newest
    : null;
}

export type ListingRequest = { eventId: string; sentAt: number };

/**
 * The agent's answer to our `/sessions`: a listing naming our request, or an
 * unattributed listing published after it.
 */
export function findListingReply(
  events: readonly RelayEvent[],
  channel: DmChannelLike,
  agentPubkey: string,
  request: ListingRequest,
): ListingEvent | null {
  return (
    listingEvents(events, channel, agentPubkey).find(
      (candidate) =>
        candidate.listing.requestId === request.eventId.toLowerCase() ||
        (candidate.listing.requestId === null &&
          candidate.createdAt >= request.sentAt - REPLY_CLOCK_SKEW_SECONDS),
    ) ?? null
  );
}

export type PickerState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "waiting"; request: ListingRequest }
  | { status: "ready"; listingEventId: string }
  | { status: "timeout" }
  | { status: "error"; message: string };

export type PickerAction =
  | { type: "show-listing"; listingEventId: string }
  | { type: "request-started" }
  | { type: "request-sent"; request: ListingRequest }
  | { type: "request-failed"; message: string }
  | { type: "listing-arrived"; listingEventId: string; requestId: string }
  | { type: "timed-out"; requestId: string }
  | { type: "reset" };

/**
 * Picker transitions. Results are fenced by request id so a late reply or
 * timer from an earlier request cannot overwrite a newer one.
 */
export function pickerReducer(
  state: PickerState,
  action: PickerAction,
): PickerState {
  switch (action.type) {
    case "show-listing":
      return { status: "ready", listingEventId: action.listingEventId };
    case "request-started":
      return { status: "requesting" };
    case "request-sent":
      return state.status === "requesting"
        ? { status: "waiting", request: action.request }
        : state;
    case "request-failed":
      return state.status === "requesting"
        ? { status: "error", message: action.message }
        : state;
    case "listing-arrived":
      return state.status === "waiting" &&
        state.request.eventId === action.requestId
        ? { status: "ready", listingEventId: action.listingEventId }
        : state;
    case "timed-out":
      return state.status === "waiting" &&
        state.request.eventId === action.requestId
        ? { status: "timeout" }
        : state;
    case "reset":
      return { status: "idle" };
  }
}

export const AGENT_DID_NOT_ANSWER =
  "The agent did not answer. Try again in a moment.";

/**
 * Plain-language wording for guest-access records. The route returns stable
 * machine codes (classifier categories, data sources, reason codes, outcomes);
 * owners see sentences. Unknown codes fall back to a humanized code so a new
 * server category is still readable, except in a grant's question kind and
 * data sources, which a proposer chooses: there an unknown code is quoted
 * (`questionKindWords`, `grantSourceLabel`).
 */

import { truncatePubkey } from "@/shared/lib/pubkey";

import {
  clampCodePoints,
  GUEST_INVISIBLE_RE,
  GUEST_QUOTE_RE,
} from "./inertText";

import type { GrantScope, RequesterKind } from "./wire";

function humanize(code: string): string {
  const text = code.replace(/[_-]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : code;
}

const CATEGORY_REASONS: Record<string, string> = {
  extraction_attempt: "Looks like an attempt to pull out private information.",
  impersonation: "The sender may be pretending to be someone else.",
  embedded_instructions:
    "The message contains instructions aimed at the agent itself.",
  act_on_behalf: "Asks the agent to act on your behalf.",
  pressure: "Uses urgency or pressure to push for an answer.",
  needs_owner_data: "Answering needs information only you can see.",
  sensitive: "Touches a sensitive topic.",
  clear_attack: "Reads as a clear attempt to misuse the agent.",
  leak: "The draft may reveal something the asker shouldn't see.",
  serious_leak: "The draft likely reveals something the asker shouldn't see.",
  slow_extraction:
    "Over several messages, this conversation is steering toward private information.",
  escalating: "The requests in this thread are escalating.",
};

/** One plain-language sentence for a classifier category. */
export function classifierReason(category: string): string {
  return CATEGORY_REASONS[category] ?? `${humanize(category)}.`;
}

const REASON_CODES: Record<string, string> = {
  owner_only_data:
    "The answer uses information only you can see, and no grant covers it.",
  inbound_classifier: "The safety check flagged the question.",
  outbound_classifier: "The safety check flagged the drafted answer.",
  owner_data_requested:
    "Answering needs information only you can see. Nothing is shared unless you approve.",
  owner_promise_guard:
    "Your agent offered to ask you, so this request was opened for you to decide.",
  classifier_unavailable:
    "The safety check was unavailable, so this was held to be safe.",
};

/** Why a request was held for approval, in the owner's terms. */
export function approvalReason(code: string): string {
  return REASON_CODES[code] ?? `${humanize(code)}.`;
}

const DATA_SOURCES: Record<string, string> = {
  memory: "Memory",
  communications: "Email and chat history",
  calendar_free_busy: "Calendar free/busy",
  calendar_details: "Calendar event details",
  clients: "Clients",
  sharepoint: "SharePoint files",
  hubspot: "HubSpot",
  shareable: "Items you marked shareable",
  owner_mailbox: "Your mailbox",
  calendar_events: "Calendar events",
  outlook_mailbox: "Outlook mailbox",
  kiingo_files: "Kiingo files",
};

const DATA_SOURCE_DESCRIPTIONS: Record<string, string> = {
  calendar_events:
    "Your meetings: titles, times, attendees, locations and notes.",
  calendar_details:
    "Your meetings: titles, times, attendees, locations and notes.",
  calendar_free_busy: "Only when you're free or busy, with no meeting details.",
  outlook_mailbox:
    "Emails in your Outlook mailbox: senders, subjects and contents.",
  owner_mailbox: "Emails in your mailbox: senders, subjects and contents.",
  kiingo_files: "Documents and files in your Kiingo workspace.",
  sharepoint: "Documents and files in your SharePoint.",
  communications: "Your past emails and chat messages.",
  memory: "What your agent remembers from earlier conversations with you.",
  clients: "Client records you can see in Kiingo.",
  hubspot: "Contacts, companies and deals in HubSpot.",
  shareable: "Only the items you marked as shareable.",
};

/**
 * One line on what sharing a source exposes, or `null` for a source this
 * desktop doesn't know yet (the label still shows).
 */
export function dataSourceDescription(source: string): string | null {
  return DATA_SOURCE_DESCRIPTIONS[source] ?? null;
}

const REQUESTER_KINDS: Record<RequesterKind, string> = {
  test: "Test",
  new: "New",
  colleague: "Colleague",
  unlinked: "Not linked",
};

/** Short label for who is asking, as the route classified them. */
export function requesterKindLabel(kind: RequesterKind): string {
  return REQUESTER_KINDS[kind];
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  const suffix =
    rem100 >= 11 && rem100 <= 13
      ? "th"
      : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ??
        "th");
  return `${n}${suffix}`;
}

/** "First request" or "3rd request", from the count of earlier requests. */
export function requestCountLabel(priorRequestCount: number): string {
  return priorRequestCount === 0
    ? "First request"
    : `${ordinal(priorRequestCount + 1)} request`;
}

/** "linked today", "linked 3 days ago", ...; `null` for a bad timestamp. */
export function linkedAgoLabel(
  linkedAt: string,
  nowMs: number = Date.now(),
): string | null {
  const at = Date.parse(linkedAt);
  if (Number.isNaN(at)) return null;
  const days = Math.floor(Math.max(0, nowMs - at) / 86_400_000);
  if (days === 0) return "linked today";
  if (days === 1) return "linked yesterday";
  if (days < 30) return `linked ${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `linked ${months} ${months === 1 ? "month" : "months"} ago`;
  }
  const years = Math.floor(days / 365);
  return `linked ${years} ${years === 1 ? "year" : "years"} ago`;
}

/** Owner-facing label for a data source the guest turn read. */
export function dataSourceLabel(source: string): string {
  return DATA_SOURCES[source] ?? humanize(source);
}

const OUTCOMES: Record<string, string> = {
  answered: "Answered",
  held: "Waiting for you",
  approved: "Approved",
  denied: "Declined",
  blocked: "Blocked",
  refused: "Refused",
  rate_limited: "Rate limited",
};

/** Short label for an access-log outcome. */
export function outcomeLabel(outcome: string): string {
  return OUTCOMES[outcome] ?? humanize(outcome);
}

/** Visual tone for an access-log outcome badge. */
export function outcomeTone(
  outcome: string,
): "neutral" | "positive" | "warning" | "danger" {
  switch (outcome) {
    case "answered":
    case "approved":
      return "positive";
    case "held":
    case "rate_limited":
      return "warning";
    case "blocked":
    case "denied":
    case "refused":
      return "danger";
    default:
      return "neutral";
  }
}

/** Grant scope label shown in the picker and the grants list. */
export function scopeLabel(scope: GrantScope, days?: number | null): string {
  switch (scope) {
    case "once":
      return "Just this once";
    case "thread":
      return "For this thread";
    case "person_days":
      return days ? `This person for ${days} days` : "This person for a while";
    case "question_kind":
      return "This kind of question from this person";
    case "always":
      return "Always for this person";
  }
}

/**
 * The owner-exclusive data sources: the only ids the server joins into a
 * question kind. Mirrors Kiingo's single source of truth,
 * BUZZ_GUEST_OWNER_ONLY_SOURCES in Kiingo/kiingo
 * packages/brain-public-ts-contracts/src/agents/buzz-guest-owner-sources.ts
 * (the `owner_only_requires_grant` sources of the kiingo-mcp guest policy).
 * Mobile mirrors it in guest_owner_copy.dart (`guestOwnerOnlySources`);
 * accessTabs.test.mjs checks the two stay equal. Change all three together.
 */
export const GUEST_OWNER_ONLY_SOURCES: readonly string[] = [
  "calendar_events",
  "outlook_mailbox",
  "kiingo_files",
];
const QUESTION_KIND_MAX = 200;
const QUESTION_KIND_MAX_SOURCES = 10;
const QUESTION_KIND_SHOWN_MAX = 80;

/**
 * A question kind in plain words, worded as the Kiingo approvals page words
 * it (`questionKindText`, apps/agent-ui/src/pages/buzz/buzz-guest-question-kind.ts).
 * Plain only in the server's exact shape (`questionKindOf`):
 * `[sensitive:]general`, or sources joined by `+` where every source is in
 * GUEST_OWNER_ONLY_SOURCES: "general questions", "sensitive questions that
 * need your calendar events, outlook mailbox". The kind is agent-influenced
 * (79, 2026-10-30), so anything else, including a list with one unknown
 * part such as "ross_approved_this", is someone's own text: shown quoted,
 * one line, no invisible characters, separators made human, capped, never
 * blank. Mirrored in mobile `questionKindWords` (guest_owner_copy.dart).
 */
export function questionKindWords(questionKind: string | null): string {
  if (!questionKind) return "this kind of question";
  const sensitive = questionKind.startsWith("sensitive:");
  const base = sensitive
    ? questionKind.slice("sensitive:".length)
    : questionKind;
  const adjective = sensitive ? "sensitive " : "";
  if (questionKind.length <= QUESTION_KIND_MAX) {
    if (base === "general") return `${adjective}general questions`;
    const sources = base.split("+");
    // Known sources in ascending order with no repeats: `questionKindOf`
    // sorts a set, so anything else is not the server's shape.
    if (
      sources.length <= QUESTION_KIND_MAX_SOURCES &&
      sources.every(
        (source, index) =>
          GUEST_OWNER_ONLY_SOURCES.includes(source) &&
          (index === 0 || source > sources[index - 1]),
      )
    ) {
      return `${adjective}questions that need your ${sources
        .map((source) => source.replace(/_/g, " "))
        .join(", ")}`;
    }
  }
  const text = inertOwnText(questionKind);
  return text ? `“${text}” questions` : "this kind of question";
}

/**
 * Someone's own text, made inert for quoting: one line, no invisible or
 * quote characters (lib/inertText.ts, so it cannot close its quote),
 * separators made human, capped by code point. Null when nothing is left.
 */
function inertOwnText(value: string): string | null {
  const shown = value
    .replace(GUEST_INVISIBLE_RE, " ")
    .replace(GUEST_QUOTE_RE, " ")
    .replace(/_/g, " ")
    .replace(/\s*\+\s*/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,]+|[\s,]+$/g, "");
  return shown ? clampCodePoints(shown, QUESTION_KIND_SHOWN_MAX) : null;
}

/**
 * Label for one data source of a grant or a grant suggestion, as the Kiingo
 * approvals page words it (`grantSourcesText`,
 * apps/agent-ui/src/pages/buzz/buzz-guest-question-kind.ts). A proposer (an
 * agent or the owner's MCP client) chooses these and the server checks only
 * their characters, so only a source in GUEST_OWNER_ONLY_SOURCES (the only
 * ids a grant can ever cover) gets its label. Anything else, such as
 * "ross_approved_this", is someone's own text: quoted like a crafted
 * question kind (79, 2026-10-30). Mirrored in mobile `grantSourceLabel`
 * (guest_owner_copy.dart).
 */
export function grantSourceLabel(source: string): string {
  if (GUEST_OWNER_ONLY_SOURCES.includes(source)) return dataSourceLabel(source);
  return `“${inertOwnText(source) ?? "…"}”`;
}

/** A grant's or a suggestion's data sources, joined: see `grantSourceLabel`. */
export function grantSourcesLabel(sources: readonly string[]): string {
  return sources.map(grantSourceLabel).join(", ");
}

/** A question kind as a badge: "Questions that need your calendar events". */
export function questionKindLabel(questionKind: string | null): string {
  const words = questionKindWords(questionKind);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Tier label for the access log (tier 3 is never available, so never shown). */
export function tierLabel(tier: number | null): string {
  switch (tier) {
    case 0:
      return "Unlinked";
    case 1:
      return "Shared info";
    case 2:
      return "Needs approval";
    default:
      return "";
  }
}

/** Requester name, or a short pubkey when the person hasn't linked. */
export function requesterLabel(requester: {
  displayName: string | null;
  pubkey: string;
}): string {
  if (requester.displayName) return requester.displayName;
  return requester.pubkey ? truncatePubkey(requester.pubkey) : "Someone";
}

/** Percent text for a 0..1 classifier score. */
export function scorePercent(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}

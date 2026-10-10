/**
 * Plain-language wording for guest-access records. The route returns stable
 * machine codes (classifier categories, data sources, reason codes, outcomes);
 * owners see sentences. Unknown codes fall back to a humanized code so a new
 * server category is still readable.
 */

import { truncatePubkey } from "@/shared/lib/pubkey";

import type { GrantScope } from "./wire";

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
};

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

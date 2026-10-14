import { dataSourceLabel } from "./copy";
import type { GrantScope, GuestApproval } from "./wire";

/**
 * The sentence shown right above an approval's buttons: what pressing the
 * primary button does, in the owner's terms. It follows the owner's current
 * choices (sources ticked, grant scope, writing the reply themselves), so it
 * never describes something the buttons won't do. Without the route's
 * `preview` block (older routes) there is no sentence.
 */

const OWNER_SOURCE_PHRASES: Record<string, string> = {
  calendar_events: "your calendar events",
  calendar_details: "your calendar event details",
  calendar_free_busy: "when you're free or busy",
  outlook_mailbox: "your Outlook mailbox",
  owner_mailbox: "your mailbox",
  kiingo_files: "your Kiingo files",
  sharepoint: "your SharePoint files",
  communications: "your email and chat history",
  memory: "what it remembers about you",
  hubspot: "your HubSpot records",
  clients: "your client records",
  shareable: "the items you marked shareable",
};

function sourcePhrase(
  id: string,
  serverLabels: ReadonlyMap<string, string>,
): string {
  return (
    serverLabels.get(id) ??
    OWNER_SOURCE_PHRASES[id] ??
    `your ${dataSourceLabel(id).toLowerCase()}`
  );
}

function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function scopePhrase(scope: GrantScope, days: number): string {
  switch (scope) {
    case "once":
      return "once";
    case "thread":
      return "and keep answering in this thread without asking you";
    case "person_days":
      return `and keep answering them for ${days} days without asking you`;
    case "question_kind":
      return "and keep answering questions like this from them without asking you";
    case "always":
      return "and keep answering them from now on without asking you";
  }
}

export type ApprovalPreviewChoices = {
  /** Sources currently ticked (owner-data requests). */
  sharedSources: readonly string[];
  grant: { scope: GrantScope; days: number };
  /** The owner is writing the reply themselves. */
  writingReply: boolean;
};

export function approvalPreviewSentence(
  approval: GuestApproval,
  choices: ApprovalPreviewChoices,
): string | null {
  const preview = approval.preview;
  if (!preview) return null;
  const agent = preview.agentName ?? approval.agent.displayName ?? "Your agent";
  const recipient =
    preview.recipientName ?? approval.requester.displayName ?? "them";
  const destination = preview.destination ?? approval.channel.type;
  const audience = preview.audienceTotal ?? approval.channel.audienceTotal;
  const where =
    destination === "channel"
      ? `in ${approval.channel.name ? `#${approval.channel.name}` : "the channel"}${
          audience && audience > 1
            ? `, where ${audience} people can see it`
            : ""
        }`
      : "in this DM";

  if (choices.writingReply) {
    return preview.action === "read_and_reply"
      ? `Your reply goes to ${recipient} ${where}. ${agent} won't read anything.`
      : `Your edited reply goes to ${recipient} ${where}.`;
  }
  if (preview.action !== "read_and_reply") return preview.summary;

  const scope = scopePhrase(choices.grant.scope, choices.grant.days);
  const tail = choices.grant.scope === "once" ? `, ${scope}.` : ` ${scope}.`;
  if (choices.sharedSources.length === 0) {
    return `Choose what ${agent} may read before it replies to ${recipient} ${where}${tail}`;
  }
  const serverLabels = new Map(
    preview.sources.flatMap((source) =>
      source.label ? [[source.id, source.label] as const] : [],
    ),
  );
  const read = joinList(
    choices.sharedSources.map((id) => sourcePhrase(id, serverLabels)),
  );
  return `${agent} will read ${read} and reply to ${recipient} ${where}${tail}`;
}

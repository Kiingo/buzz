import type {
  RemoteSignerLogEntry,
  RemoteSignerPrompt,
  RemoteSignerRequester,
  RemoteSignerScope,
  RemoteSignerStatus,
  ScopeDurationMinutes,
} from "./api";

/** The service that asks this device to sign. */
export const SIGNER_SERVICE_NAME = "Kiingo";
export const SETTINGS_SECTION_LABEL = `${SIGNER_SERVICE_NAME} signing`;
export const MASTER_SWITCH_LABEL = `Allow ${SIGNER_SERVICE_NAME} to request signatures`;

export const SCOPE_DURATIONS: ReadonlyArray<{
  minutes: ScopeDurationMinutes;
  label: string;
}> = [
  { minutes: 15, label: "15 min" },
  { minutes: 60, label: "1 hour" },
  { minutes: 480, label: "8 hours" },
];

/** Kinds a publish scope may cover, in the order the picker shows them. */
export const PUBLISH_SCOPE_KINDS: readonly number[] = [9, 7, 40003, 9005];

const KIND_LABELS: Record<number, string> = {
  0: "profiles",
  5: "deletions",
  7: "reactions",
  9: "messages",
  9005: "deletions",
  10100: "profile settings",
  39000: "channel details",
  39002: "channel members",
  40002: "messages",
  40003: "edits",
  40008: "message changes",
  45001: "forum posts",
  45003: "forum comments",
};

const PUBLISH_KIND_LABELS: Record<number, string> = {
  7: "Reaction",
  9: "Message",
  9005: "Delete",
  40003: "Edit",
};

/** "Message (kind 9)". */
export function publishKindLabel(kind: number): string {
  return `${PUBLISH_KIND_LABELS[kind] ?? "Event"} (kind ${kind})`;
}

/** "messages, edits and channel details". */
export function readKindsLabel(kinds: readonly number[]): string {
  const labels = [
    ...new Set(kinds.map((kind) => KIND_LABELS[kind] ?? `kind ${kind}`)),
  ];
  if (labels.length <= 1) return labels[0] ?? "nothing";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/**
 * The action, derived on this device from what will actually be signed
 * rather than from the requester's wording.
 */
export function promptActionLabel(prompt: RemoteSignerPrompt): string {
  if (prompt.method === "read") {
    switch (prompt.action) {
      case "list_channels":
        return "List your channels and DMs";
      case "read_thread":
        return "Read a thread";
      case "search_messages":
        return "Search your messages";
      default:
        return "Read recent messages";
    }
  }
  switch (prompt.kind) {
    case 9:
      return prompt.isReply ? "Reply in a thread" : "Post a message";
    case 7:
      return `React ${prompt.content ?? ""}`.trim();
    case 40003:
      return "Edit your message";
    case 9005:
      return "Delete your message";
    default:
      return "Sign an event";
  }
}

const ACTION_LABELS: Record<string, string> = {
  delete_message: "Delete a message",
  edit_message: "Edit a message",
  list_channels: "List channels",
  react: "React",
  read_channel: "Read a channel",
  read_thread: "Read a thread",
  reply: "Reply",
  search_messages: "Search",
  send_message: "Post a message",
};

export function logActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? (action || "Request");
}

/** Who asked: "Kiingo MCP · agent Atlas · session 1a2b…". */
export function requesterLines(requester: RemoteSignerRequester): string[] {
  const lines = [
    requester.mcpClient ?? `${SIGNER_SERVICE_NAME} (unnamed client)`,
  ];
  if (requester.label) lines.push(requester.label);
  if (requester.agentId) lines.push(`Agent ${requester.agentId}`);
  if (requester.jobId) lines.push(`Job ${requester.jobId}`);
  if (requester.sessionId) lines.push(`Session ${requester.sessionId}`);
  return lines;
}

/** Minimal channel shape the labels need. */
export type ChannelLike = {
  id: string;
  name: string;
  channelType: string;
  memberCount: number;
  participants: string[];
  participantPubkeys: string[];
};

export type ChannelTarget = {
  /** "#launch" or "DM with Alice". */
  label: string;
  /** "12 members" or null when unknown. */
  detail: string | null;
  known: boolean;
};

/** Resolve a channel id against the channels this device already knows. */
export function channelTarget(
  channelId: string | null,
  channels: readonly ChannelLike[] | undefined,
  selfPubkey: string | null,
): ChannelTarget | null {
  if (!channelId) return null;
  const channel = channels?.find((candidate) => candidate.id === channelId);
  if (!channel) {
    return {
      label: "A channel this device doesn't know",
      detail: channelId,
      known: false,
    };
  }
  if (channel.channelType === "dm") {
    const self = selfPubkey?.toLowerCase() ?? "";
    const peers = channel.participants.filter(
      (_, index) => channel.participantPubkeys[index]?.toLowerCase() !== self,
    );
    return {
      label: peers.length > 0 ? `DM with ${peers.join(", ")}` : "DM",
      detail: `${channel.memberCount} ${channel.memberCount === 1 ? "member" : "members"}`,
      known: true,
    };
  }
  return {
    label: `#${channel.name}`,
    detail: `${channel.memberCount} ${channel.memberCount === 1 ? "member" : "members"}`,
    known: true,
  };
}

export function channelName(
  channelId: string | null,
  channels: readonly ChannelLike[] | undefined,
  selfPubkey: string | null,
): string {
  if (!channelId) return "All your channels";
  return channelTarget(channelId, channels, selfPubkey)?.label ?? channelId;
}

/** "Messages and reactions in #launch" / "Read all your channels". */
export function scopeLabel(
  scope: RemoteSignerScope,
  channels: readonly ChannelLike[] | undefined,
  selfPubkey: string | null,
): string {
  const where = channelName(scope.channelId, channels, selfPubkey);
  if (scope.kind === "read") {
    return scope.channelId ? `Read ${where}` : "Read all your channels";
  }
  const kinds = scope.kinds.map(
    (kind) => PUBLISH_KIND_LABELS[kind] ?? `kind ${kind}`,
  );
  return `${kinds.join(", ")} in ${where}`;
}

/** "12 min left", "3 h left". */
export function remainingLabel(untilMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.ceil((untilMs - nowMs) / 60_000));
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h left` : `${hours} h ${rest} min left`;
}

export function decisionLabel(entry: RemoteSignerLogEntry): string {
  if (entry.decision === "prompt") return "You decided";
  if (entry.decision.startsWith("scope:")) return "Scope";
  return "Automatic";
}

const OUTCOME_LABELS: Record<string, string> = {
  cancelled: "Cancelled",
  declined: "Declined",
  expired: "Expired",
  failed: "Failed",
  refused: "Refused",
  signed: "Signed",
};

export function outcomeLabel(entry: RemoteSignerLogEntry): string {
  return OUTCOME_LABELS[entry.outcome] ?? entry.outcome;
}

export function statusLabel(
  status: RemoteSignerStatus,
  lastError: string | null,
): string {
  switch (status) {
    case "listening":
      return "Listening for requests";
    case "connecting":
      return "Connecting…";
    case "unavailable":
      return "Not available in this build";
    case "error":
      return errorLabel(lastError);
    default:
      return "Off";
  }
}

export function errorLabel(code: string | null): string {
  switch (code) {
    case "signer_not_linked":
      return `Your Buzz identity isn't linked to ${SIGNER_SERVICE_NAME}. Link your account in Settings → Profile.`;
    case "nip98_expired":
    case "nip98_replayed":
      return "Request signatures were rejected. Check this computer's clock.";
    case "signer_unreachable":
    case "signer_timeout":
      return `Can't reach ${SIGNER_SERVICE_NAME}. Retrying…`;
    case "identity_changed":
    case "identity_unavailable":
      return "Your identity is unavailable, so nothing can be signed.";
    default:
      return code
        ? `Retrying after an error (${code})`
        : "Retrying after an error";
  }
}

/** Short display form for an event id (not a pubkey). */
export function shortEventId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

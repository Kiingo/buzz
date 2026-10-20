import {
  areAgentDmMarkersHonoured,
  KIND_AGENT_DM_QUIET,
  parseMirror,
  parseQuestionState,
  parseSessionDivider,
  parseSessionsListing,
  type DmChannelLike,
} from "./markers";

type QuietCandidate = {
  kind: number;
  pubkey: string;
  tags: readonly (readonly string[])[];
};

/**
 * Whether an event is a quiet agent DM marker: a mirrored message, session
 * divider, sessions listing or question-state event (kind 40002) honoured in
 * this DM. Quiet events never make a channel unread, never count as a
 * mention, and never raise a DM alert, desktop notification, sound or
 * home-activity row. They may still advance channel recency.
 */
export function isAgentDmQuietEvent(
  event: QuietCandidate,
  channel: DmChannelLike | null | undefined,
): boolean {
  if (event.kind !== KIND_AGENT_DM_QUIET) return false;
  if (!areAgentDmMarkersHonoured(channel, event.pubkey)) return false;
  return (
    parseMirror(event.tags) !== null ||
    parseSessionDivider(event.tags) !== null ||
    parseSessionsListing(event.tags) !== null ||
    parseQuestionState(event.tags) !== null
  );
}

/**
 * Timeline-row form of {@link isAgentDmQuietEvent}: the formatter already
 * applied the honour rule and recorded it on `agentDmMarkers`.
 */
export function isAgentDmQuietMessage(message: {
  agentDmMarkers?: boolean;
  kind?: number;
  tags?: string[][];
}): boolean {
  if (!message.agentDmMarkers || message.kind !== KIND_AGENT_DM_QUIET) {
    return false;
  }
  const tags = message.tags ?? [];
  return (
    parseMirror(tags) !== null ||
    parseSessionDivider(tags) !== null ||
    parseSessionsListing(tags) !== null ||
    parseQuestionState(tags) !== null
  );
}

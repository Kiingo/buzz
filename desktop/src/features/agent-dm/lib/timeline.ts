import type { TimelineMessage } from "@/features/messages/types";
import {
  resolveUserLabel,
  type UserProfileLookup,
} from "@/features/profile/lib/identity";
import type { Channel, RelayEvent } from "@/shared/api/types";

import {
  areAgentDmMarkersHonoured,
  KIND_AGENT_DM_QUIET,
  KIND_AGENT_DM_STREAM_MESSAGE,
  mirrorDisplayAuthorPubkey,
  parseActions,
  parseAnswerAskId,
  parseCall,
  parseMirror,
  parseQuestion,
  parseQuestionState,
  parseSessionDivider,
  parseSessionsListing,
  parseSurface,
  type AgentQuestionStateValue,
} from "./markers";

export type AgentDmQuestionState = "open" | AgentQuestionStateValue;

export type AgentDmMessageKind =
  | "mirror"
  | "call"
  | "divider"
  | "listing"
  | "question"
  | "actions"
  | "surface";

type ProjectorContext = {
  currentPubkey?: string;
  currentUserAvatarUrl: string | null;
  profiles?: UserProfileLookup;
};

type MarkerRecord = { signer: string; createdAt: number };
type StateRecord = MarkerRecord & { state: AgentQuestionStateValue };

/**
 * Which marker an honoured timeline row carries. Quiet kind 40002 rows carry
 * at most one (mirror, then divider, then listing); agent kind 9 rows can
 * carry a question, action buttons and a surface card.
 */
export function agentDmMessageKinds(
  message: Pick<TimelineMessage, "agentDmMarkers" | "kind" | "tags">,
): AgentDmMessageKind[] {
  if (!message.agentDmMarkers) return [];
  const tags = message.tags ?? [];
  if (message.kind === KIND_AGENT_DM_QUIET) {
    if (parseMirror(tags))
      return parseCall(tags) ? ["mirror", "call"] : ["mirror"];
    if (parseSessionDivider(tags)) return ["divider"];
    if (parseSessionsListing(tags)) return ["listing"];
    return [];
  }
  if (message.kind !== KIND_AGENT_DM_STREAM_MESSAGE) return [];
  const kinds: AgentDmMessageKind[] = [];
  if (parseQuestion(tags)) kinds.push("question");
  if (parseActions(tags).length > 0) kinds.push("actions");
  if (parseSurface(tags)) kinds.push("surface");
  return kinds;
}

export function isAgentSessionDividerMessage(
  message: Pick<TimelineMessage, "agentDmMarkers" | "kind" | "tags">,
) {
  return agentDmMessageKinds(message).includes("divider");
}

/**
 * Edits, deletion and moderation of a mirrored message stay keyed to its
 * signer even when the row is displayed as the requester.
 */
export function agentDmManagePubkey(message: TimelineMessage) {
  return agentDmMessageKinds(message).includes("mirror") && message.signerPubkey
    ? message.signerPubkey
    : message.pubkey;
}

/** Memo comparator companion for the agent DM projection fields. */
export function agentDmRowEqual(prev: TimelineMessage, next: TimelineMessage) {
  return (
    prev.agentDmMarkers === next.agentDmMarkers &&
    prev.agentDmQuestionState === next.agentDmQuestionState
  );
}

function pushRecord<T>(map: Map<string, T[]>, key: string, record: T) {
  const list = map.get(key);
  if (list) list.push(record);
  else map.set(key, [record]);
}

function hasMarkerTag(tags: readonly (readonly string[])[]) {
  return tags.some((tag) => tag[0]?.startsWith("buzz-"));
}

/**
 * Builds the per-window agent DM projection for `formatTimelineMessages`:
 * honoured markers are flagged on the row, a mirrored requester message takes
 * that member's identity, question cards learn whether they were answered or
 * closed, and question-state events render no row.
 */
export function createAgentDmProjector(
  events: readonly RelayEvent[],
  channel: Channel | null,
  context: ProjectorContext,
) {
  const states = new Map<string, StateRecord[]>();
  const answers = new Map<string, MarkerRecord[]>();
  const dm = channel?.channelType === "dm" ? channel : null;
  if (dm) {
    for (const event of events) {
      if (!areAgentDmMarkersHonoured(dm, event.pubkey)) continue;
      const signer = event.pubkey.toLowerCase();
      if (event.kind === KIND_AGENT_DM_QUIET) {
        const marker = parseQuestionState(event.tags);
        if (marker) {
          pushRecord(states, marker.askId, {
            signer,
            createdAt: event.created_at,
            state: marker.state,
          });
        }
      } else if (event.kind === KIND_AGENT_DM_STREAM_MESSAGE) {
        const askId = parseAnswerAskId(event.tags);
        if (askId) {
          pushRecord(answers, askId, { signer, createdAt: event.created_at });
        }
      }
    }
  }

  function questionState(
    askId: string,
    signer: string,
    createdAt: number,
  ): AgentDmQuestionState {
    let latest: StateRecord | null = null;
    for (const record of states.get(askId) ?? []) {
      if (record.signer !== signer || record.createdAt < createdAt) continue;
      if (!latest || record.createdAt >= latest.createdAt) latest = record;
    }
    if (latest) return latest.state;
    const answered = (answers.get(askId) ?? []).some(
      (record) => record.signer !== signer && record.createdAt >= createdAt,
    );
    return answered ? "answered" : "open";
  }

  function identityFor(pubkey: string) {
    const index =
      dm?.participantPubkeys.findIndex(
        (candidate) => candidate.toLowerCase() === pubkey,
      ) ?? -1;
    const profile = context.profiles?.[pubkey];
    const isSelf = context.currentPubkey?.toLowerCase() === pubkey;
    return {
      author: resolveUserLabel({
        pubkey,
        currentPubkey: context.currentPubkey,
        fallbackName: index >= 0 ? (dm?.participants[index] ?? null) : null,
        profiles: context.profiles,
        preferResolvedSelfLabel: true,
      }),
      avatarUrl: isSelf
        ? context.currentUserAvatarUrl
        : (profile?.avatarUrl ?? null),
      isAgent: profile?.isAgent === true,
      accent: isSelf,
    };
  }

  return {
    project(message: TimelineMessage, event: RelayEvent): TimelineMessage[] {
      if (!dm || !hasMarkerTag(event.tags)) return [message];
      if (!areAgentDmMarkersHonoured(dm, event.pubkey)) return [message];
      const signer = event.pubkey.toLowerCase();

      if (event.kind === KIND_AGENT_DM_QUIET) {
        if (parseQuestionState(event.tags)) return [];
        const mirror = parseMirror(event.tags);
        if (mirror) {
          const requester = message.isAgent
            ? mirrorDisplayAuthorPubkey(mirror, signer, dm)
            : null;
          if (!requester) return [{ ...message, agentDmMarkers: true }];
          return [
            {
              ...message,
              ...identityFor(requester),
              pubkey: requester,
              ownerPubkey: null,
              ownerLabel: null,
              role: undefined,
              personaDisplayName: undefined,
              respondTo: undefined,
              agentDmMarkers: true,
            },
          ];
        }
        if (
          parseSessionDivider(event.tags) ||
          parseSessionsListing(event.tags)
        ) {
          return [{ ...message, agentDmMarkers: true }];
        }
        return [message];
      }

      if (event.kind !== KIND_AGENT_DM_STREAM_MESSAGE) return [message];
      const question = parseQuestion(event.tags);
      if (question) {
        return [
          {
            ...message,
            agentDmMarkers: true,
            agentDmQuestionState: questionState(
              question.askId,
              signer,
              event.created_at,
            ),
          },
        ];
      }
      return parseActions(event.tags).length > 0
        ? [{ ...message, agentDmMarkers: true }]
        : [message];
    },
  };
}

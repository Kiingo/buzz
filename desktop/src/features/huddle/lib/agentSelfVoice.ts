/**
 * Self-voiced agents: an agent that is itself a live audio participant in the
 * huddle speaks for itself, so this desktop must not also synthesize its text
 * replies. Two independent signals suppress local TTS:
 *
 * 1. Presence: the agent's pubkey holds at least one live audio admission in
 *    the media roster, excluding this desktop's own TTS publisher sockets.
 *    Admissions are tracked per peer index, so a make-before-break rejoin (two
 *    sockets for one pubkey) stays suppressed until the last one leaves. After
 *    that, only messages created more than the resume grace after the leave
 *    are spoken again.
 * 2. Marker: a message tagged `["spoken", "1"]` was already spoken in the
 *    huddle by its author. It is still shown as text, never synthesized.
 *
 * With neither signal present, TTS behaves exactly as before.
 */

export const SPOKEN_MARKER_TAG = "spoken";
export const SELF_VOICE_RESUME_GRACE_MS = 3_000;

/** One media-roster entry as reported by the native audio relay. */
export type HuddleAudioPeer = {
  pubkey: string;
  peer_index: number;
  /** True for a send-only TTS publisher socket opened by this desktop. */
  local: boolean;
};

export type AgentSelfVoiceState = {
  /** pubkey -> peer indices of live admissions not published by this desktop. */
  readonly remoteAdmissions: ReadonlyMap<string, ReadonlySet<number>>;
  /** pubkey -> wall-clock ms when its last remote admission left the roster. */
  readonly lastLeftAtMs: ReadonlyMap<string, number>;
};

export type SelfVoiceSuppression = "spoken_marker" | "agent_self_voiced" | null;

export const EMPTY_AGENT_SELF_VOICE_STATE: AgentSelfVoiceState = {
  remoteAdmissions: new Map(),
  lastLeftAtMs: new Map(),
};

function normalizePubkey(pubkey: string): string {
  return pubkey.trim().toLowerCase();
}

export function hasSpokenMarker(tags: readonly (readonly string[])[]): boolean {
  return tags.some((tag) => tag[0] === SPOKEN_MARKER_TAG && tag[1] === "1");
}

/**
 * Fold a full media-roster snapshot into the presence state.
 *
 * A remote admission that disappears from the roster is a leave and starts the
 * resume grace. An index that is reclassified as this desktop's own publisher
 * (its local registration can trail the roster delta) is not a leave: it never
 * represented the agent speaking for itself.
 */
export function applyHuddleAudioPeers(
  previous: AgentSelfVoiceState,
  peers: readonly HuddleAudioPeer[],
  nowMs: number,
): AgentSelfVoiceState {
  const rosterOwners = new Map<number, string>();
  const remoteAdmissions = new Map<string, Set<number>>();
  for (const peer of peers) {
    const pubkey = normalizePubkey(peer.pubkey);
    if (!pubkey || !Number.isInteger(peer.peer_index)) continue;
    rosterOwners.set(peer.peer_index, pubkey);
    if (peer.local) continue;
    const admissions = remoteAdmissions.get(pubkey) ?? new Set<number>();
    admissions.add(peer.peer_index);
    remoteAdmissions.set(pubkey, admissions);
  }

  const lastLeftAtMs = new Map(previous.lastLeftAtMs);
  for (const [pubkey, admissions] of previous.remoteAdmissions) {
    if (admissions.size === 0 || remoteAdmissions.has(pubkey)) continue;
    const anyLeftRoster = [...admissions].some(
      (index) => rosterOwners.get(index) !== pubkey,
    );
    if (anyLeftRoster) lastLeftAtMs.set(pubkey, nowMs);
  }
  for (const pubkey of remoteAdmissions.keys()) lastLeftAtMs.delete(pubkey);

  return { remoteAdmissions, lastLeftAtMs };
}

/** Decide whether an agent message must not be synthesized on this desktop. */
export function selfVoiceSuppression(
  state: AgentSelfVoiceState,
  event: {
    pubkey: string;
    created_at?: number;
    tags: readonly (readonly string[])[];
  },
): SelfVoiceSuppression {
  if (hasSpokenMarker(event.tags)) return "spoken_marker";
  const pubkey = normalizePubkey(event.pubkey);
  if ((state.remoteAdmissions.get(pubkey)?.size ?? 0) > 0)
    return "agent_self_voiced";
  const leftAtMs = state.lastLeftAtMs.get(pubkey);
  if (leftAtMs === undefined) return null;
  const createdAt = event.created_at;
  // A message without a usable timestamp cannot prove it postdates the
  // hand-back, so it stays with the agent's own voice.
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt))
    return "agent_self_voiced";
  return createdAt * 1000 > leftAtMs + SELF_VOICE_RESUME_GRACE_MS
    ? null
    : "agent_self_voiced";
}

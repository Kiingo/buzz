/**
 * Guest-side view of hosted guest replies (contracts §3, §8; C1). Every
 * message an agent publishes for a non-owner carries `buzz-guest` (the
 * effective requester) and usually `buzz-guest-turn`; newer route versions
 * add `buzz-guest-kind`. These markers come from the route verbatim and are
 * covered by the agent's signature, so the desktop can show who a reply was
 * produced for and whether it is a pending "I've asked …" state.
 */

export type GuestReplyKind =
  | "answer"
  | "notice"
  | "hold_notice"
  | "refusal"
  | "approved_answer"
  | "outcome_copy"
  | "unknown";

export type GuestReplyMarker = {
  requesterPubkey: string;
  turnId: string | null;
  kind: GuestReplyKind;
};

const KINDS: readonly GuestReplyKind[] = [
  "answer",
  "notice",
  "hold_notice",
  "refusal",
  "approved_answer",
  "outcome_copy",
];

/** Parse the guest markers on a message's tags, or `null` for a normal reply. */
export function parseGuestReplyMarker(
  tags: readonly string[][] | undefined,
): GuestReplyMarker | null {
  if (!tags) return null;
  const requester = tags.find((tag) => tag[0] === "buzz-guest")?.[1];
  if (!requester || !/^[0-9a-f]{64}$/i.test(requester)) return null;
  const turnId = tags.find((tag) => tag[0] === "buzz-guest-turn")?.[1] ?? null;
  const rawKind = tags.find((tag) => tag[0] === "buzz-guest-kind")?.[1];
  const kind = KINDS.includes(rawKind as GuestReplyKind)
    ? (rawKind as GuestReplyKind)
    : "unknown";
  return { requesterPubkey: requester.toLowerCase(), turnId, kind };
}

/** A hold notice stays pending until a later publication for its turn. */
export function isPendingKind(kind: GuestReplyKind) {
  return kind === "hold_notice";
}

export function isRefusalKind(kind: GuestReplyKind) {
  return kind === "refusal" || kind === "notice";
}

// Turn registry: which turns have produced a publication after a hold notice.
// Rows register when they render, so the hold notice can show "answered
// below" once the approved answer (or a decline notice) for the same turn
// appears in the same conversation.
type TurnRecord = { holdAt: number | null; followUpAt: number | null };
let turns = new Map<string, TurnRecord>();
let version = 0;
const listeners = new Set<() => void>();

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

export function registerGuestReply(
  marker: GuestReplyMarker,
  createdAt: number,
) {
  if (!marker.turnId) return;
  const record = turns.get(marker.turnId) ?? { holdAt: null, followUpAt: null };
  let changed = false;
  if (isPendingKind(marker.kind)) {
    if (record.holdAt === null || createdAt < record.holdAt) {
      record.holdAt = createdAt;
      changed = true;
    }
  } else if (
    marker.kind !== "outcome_copy" &&
    (record.followUpAt === null || createdAt > record.followUpAt)
  ) {
    record.followUpAt = createdAt;
    changed = true;
  }
  turns.set(marker.turnId, record);
  if (changed) notify();
}

/** Whether a later reply resolved this turn's hold notice. */
export function isGuestTurnResolved(turnId: string | null): boolean {
  if (!turnId) return false;
  const record = turns.get(turnId);
  return Boolean(
    record &&
      record.followUpAt !== null &&
      (record.holdAt === null || record.followUpAt >= record.holdAt),
  );
}

export function subscribeGuestTurns(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getGuestTurnsVersion() {
  return version;
}

export function resetGuestTurns() {
  turns = new Map();
  notify();
}

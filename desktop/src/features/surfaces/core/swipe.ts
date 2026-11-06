// Generated from the Kiingo surface renderer packages at 8a4382a01c1d2046b63e7c78a1220c2c33e419a3; do not edit here.
import { isObject, type JsonObject, type JsonValue } from "./json";
import { plainText } from "./text";

// SwipeDeck (GENUI-SWIPE, 2026-11-05): cards decided one at a time. Every
// renderer (and the Swift UiSwipeModel) reads the deck the same way: the
// current card is the first card in array order with no decision in the
// value, a decision is written under the card's key, and Undo goes back
// one card. No count is capped here: the surface data cap bounds the array.

export const SWIPE_DECISIONS = ["approve", "skip", "reject"] as const;
export type SwipeDecision = (typeof SWIPE_DECISIONS)[number];

export const isSwipeDecision = (value: unknown): value is SwipeDecision =>
  typeof value === "string" &&
  (SWIPE_DECISIONS as readonly string[]).includes(value);

export type SwipeCard = {
  /** Position in the bound array. */
  index: number;
  /**
   * Where the card's decision is stored in the value: its id, or
   * `#<index>` for a card with none or with an id an earlier card already
   * has (as Board cards).
   */
  key: string;
  id?: string;
  title: string;
  subtitle?: string;
  /** The whole body, line breaks kept. */
  body?: string;
  badge?: string;
  tone?: string;
};

/** Text is cleaned, never cut: one card shows at a time and scrolls. */
const WHOLE = Number.MAX_SAFE_INTEGER;

const TONES = new Set(["default", "muted", "success", "warning", "danger"]);

/** The cards in array order; anything that isn't an object is skipped. */
export const readSwipeCards = (raw: unknown[]): SwipeCard[] => {
  const keys = new Set<string>();
  const cards: SwipeCard[] = [];
  raw.forEach((item, index) => {
    if (!isObject(item)) {
      return;
    }
    const id = plainText(item.id, WHOLE);
    const key = id !== undefined && !keys.has(id) ? id : `#${index}`;
    keys.add(key);
    const subtitle = plainText(item.subtitle, WHOLE);
    const body = plainText(item.body, WHOLE, true);
    const badge = plainText(item.badge, WHOLE);
    const tone =
      typeof item.tone === "string" && TONES.has(item.tone)
        ? item.tone
        : undefined;
    cards.push({
      index,
      key,
      title: plainText(item.title, WHOLE) ?? "",
      ...(id ? { id } : {}),
      ...(subtitle ? { subtitle } : {}),
      ...(body ? { body } : {}),
      ...(badge ? { badge } : {}),
      ...(tone ? { tone } : {}),
    });
  });
  return cards;
};

/** The card's decision in `value`, when it holds a known one. */
export const swipeDecisionOf = (
  value: JsonValue | undefined,
  card: SwipeCard,
): SwipeDecision | undefined => {
  if (
    !isObject(value) ||
    !Object.prototype.hasOwnProperty.call(value, card.key)
  ) {
    return undefined;
  }
  const decision = value[card.key];
  return isSwipeDecision(decision) ? decision : undefined;
};

export type SwipeState = {
  /** The first card with no decision; undefined when all are decided. */
  current?: SwipeCard;
  /** 1-based place of the current card ("Card 3 of 12"). */
  position: number;
  total: number;
  counts: Record<SwipeDecision, number>;
  decided: number;
  /** Every card decided (and there is at least one card). */
  done: boolean;
};

export const swipeState = (
  cards: SwipeCard[],
  value: JsonValue | undefined,
): SwipeState => {
  const counts: Record<SwipeDecision, number> = {
    approve: 0,
    skip: 0,
    reject: 0,
  };
  let current: SwipeCard | undefined;
  let position = 0;
  cards.forEach((card, place) => {
    const decision = swipeDecisionOf(value, card);
    if (decision) {
      counts[decision] += 1;
    } else if (!current) {
      current = card;
      position = place + 1;
    }
  });
  const decided = counts.approve + counts.skip + counts.reject;
  return {
    ...(current ? { current } : {}),
    position: current ? position : cards.length,
    total: cards.length,
    counts,
    decided,
    done: cards.length > 0 && current === undefined,
  };
};

export type SwipeDecided = {
  cardId: string | null;
  index: number;
  decision: SwipeDecision;
};

/**
 * `value` with `card` decided: other entries (decisions on cards no longer
 * in the array, anything the agent wrote) are kept.
 */
export const decideSwipe = (
  value: JsonValue | undefined,
  card: SwipeCard,
  decision: SwipeDecision,
): { value: JsonObject; decided: SwipeDecided } => ({
  value: { ...(isObject(value) ? value : {}), [card.key]: decision },
  decided: { cardId: card.id ?? null, index: card.index, decision },
});

/**
 * The card Undo goes back to: the nearest decided card before the current
 * one, else (all decided, or only later cards decided) the last decided
 * card. Undefined when nothing is decided.
 */
export const swipeUndoTarget = (
  cards: SwipeCard[],
  value: JsonValue | undefined,
): SwipeCard | undefined => {
  const state = swipeState(cards, value);
  const decided = cards.filter((card) => swipeDecisionOf(value, card));
  if (state.current) {
    const before = decided.filter((card) => card.index < state.current!.index);
    if (before.length > 0) {
      return before[before.length - 1];
    }
  }
  return decided[decided.length - 1];
};

/** `value` without `card`'s decision (Undo); nothing else changes. */
export const undoSwipe = (
  value: JsonValue | undefined,
  card: SwipeCard,
): JsonObject => {
  const next: JsonObject = { ...(isObject(value) ? value : {}) };
  delete next[card.key];
  return next;
};

/** What a decision reads as, with the deck's own labels. */
export type SwipeLabels = Record<SwipeDecision, string>;

export const SWIPE_DEFAULT_LABELS: SwipeLabels = {
  approve: "Approve",
  skip: "Skip",
  reject: "Reject",
};

/** "2 approved, 1 skipped, 3 rejected" with the deck's labels. */
export const swipeCountsText = (
  counts: Record<SwipeDecision, number>,
  labels: SwipeLabels,
): string =>
  SWIPE_DECISIONS.filter((decision) => counts[decision] > 0)
    .map((decision) => `${labels[decision]}: ${counts[decision]}`)
    .join(" · ");

/** The keys of a deck (web and Mac): a decision, Undo, or nothing. */
export const swipeKeyAction = (
  key: string,
): SwipeDecision | "undo" | undefined => {
  switch (key) {
    case "ArrowRight":
    case "a":
    case "A":
      return "approve";
    case "ArrowLeft":
    case "x":
    case "X":
      return "reject";
    case "ArrowDown":
    case "s":
    case "S":
      return "skip";
    case "z":
    case "Z":
    case "Backspace":
      return "undo";
    default:
      return undefined;
  }
};

/** The action kinds a decision may carry (an allowlist). */
const SWIPE_DECISION_ACTION_KINDS: ReadonlySet<string> = new Set([
  "set_state",
  "open",
  "dismiss",
  "ask_agent",
]);

/**
 * Whether a decision (onApprove, onReject, onSkip) may run `action`: only
 * set_state, open, dismiss or ask_agent, and never an email_draft card's
 * Send. A swipe shows no words and asks for no confirmation (79 M1/W1,
 * LOW-79-SWIPE-DECISION-SEND). The validator holds decisions to the same
 * kinds; this keeps an older surface from firing any other. onDone is a labelled
 * button and goes through the usual tap.
 */
export const swipeDecisionMayRun = (
  action: { id: string; kind: string },
  template?: string,
): boolean =>
  SWIPE_DECISION_ACTION_KINDS.has(action.kind) &&
  !(
    template === "email_draft" &&
    (action.id === "send_confirmed" || action.id === "send")
  );

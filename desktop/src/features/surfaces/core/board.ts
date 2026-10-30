// Generated from the Kiingo surface renderer packages at f674e04ba1130af309f8d467ccc7fc5a2efeba01; do not edit here.
import { isObject, type JsonValue } from "./json";
import { plainText } from "./text";

// Board (§4.2, GU-A): kanban columns over a bound cards array. Moves rewrite
// the whole array, so every renderer (and the Swift one) moves cards the
// same way: the card takes its new column and lands at `position` among
// that column's cards.

export type BoardColumn = {
  id: string;
  title: string;
  wipLimit?: number;
  tone?: string;
};

export type BoardCard = {
  /** Position in the bound array (what `selection` receives). */
  index: number;
  /**
   * Unique within the board: the card's id, or `#<index>` for a card with
   * none or with an id an earlier card already has (79 DUP-CARD-IDS).
   */
  key: string;
  id?: string;
  title: string;
  subtitle?: string;
  column: string;
  badge?: string;
  tone?: string;
};

export type BoardLane = BoardColumn & {
  /** The lane's first BOARD_LANE_MAX cards, in array order. */
  cards: BoardCard[];
  /** Cards in the lane past BOARD_LANE_MAX (counted, not drawn). */
  more: number;
  /** Over its WIP limit (counting every card in the lane). */
  over: boolean;
};

/**
 * Drawn per lane (79 LOW: a card moved past array index 500 was hidden).
 * The cap is per lane, so a moved card shows wherever it lands in the
 * array; past it the lane says how many more. Swift: UiBoardModel.laneMax.
 */
export const BOARD_LANE_MAX = 100;
/** Cards read at most (the surface data cap bounds the array anyway). */
export const BOARD_SCAN_MAX = 5000;

const TONES = new Set(["default", "muted", "success", "warning", "danger"]);
const toneOf = (raw: unknown) =>
  typeof raw === "string" && TONES.has(raw) ? raw : undefined;

/** The literal columns, deduplicated by id, at most 12. */
export const readBoardColumns = (raw: unknown[]): BoardColumn[] => {
  const seen = new Set<string>();
  return raw.slice(0, 12).flatMap((item) => {
    if (!isObject(item)) {
      return [];
    }
    const id = plainText(item.id, 64);
    if (!id || seen.has(id)) {
      return [];
    }
    seen.add(id);
    const limit =
      typeof item.wipLimit === "number" && item.wipLimit >= 1
        ? Math.floor(item.wipLimit)
        : undefined;
    const tone = toneOf(item.tone);
    return [
      {
        id,
        title: plainText(item.title, 80) ?? id,
        ...(limit ? { wipLimit: limit } : {}),
        ...(tone ? { tone } : {}),
      },
    ];
  });
};

/**
 * The column a card is in (79 COLUMN-TYPE-DRIFT): its `column` as plain text
 * (a number reads as its digits) when that names a listed column, else the
 * first column, so nothing silently disappears. Lanes, moves, the MCP App
 * page and the fallback text all place cards by this, and so does Swift
 * (UiBoardModel.column).
 */
export const boardColumnOf = (
  columns: BoardColumn[],
  item: unknown,
): string | undefined => {
  if (columns.length === 0) {
    return undefined;
  }
  const raw = isObject(item) ? plainText(item.column, 64) : undefined;
  return raw !== undefined && columns.some((column) => column.id === raw)
    ? raw
    : columns[0]?.id;
};

/** Cards by column (boardColumnOf), in array order, BOARD_LANE_MAX each. */
export const boardLanes = (
  columns: BoardColumn[],
  raw: unknown[],
  laneMax = BOARD_LANE_MAX,
): BoardLane[] => {
  const keys = new Set<string>();
  const lanes = columns.map((column) => ({
    ...column,
    cards: [] as BoardCard[],
    more: 0,
    over: false,
  }));
  raw.slice(0, BOARD_SCAN_MAX).forEach((item, index) => {
    if (!isObject(item) || lanes.length === 0) {
      return;
    }
    const column = boardColumnOf(columns, item);
    const lane = lanes.find((entry) => entry.id === column);
    if (!lane) {
      return;
    }
    const id = plainText(item.id, 64);
    const key = id !== undefined && !keys.has(id) ? id : `#${index}`;
    keys.add(key);
    if (lane.cards.length >= laneMax) {
      lane.more += 1;
      return;
    }
    const subtitle = plainText(item.subtitle, 300);
    const badge = plainText(item.badge, 40);
    const tone = toneOf(item.tone);
    lane.cards.push({
      index,
      key,
      title: plainText(item.title, 200) ?? "",
      column: lane.id,
      ...(id ? { id } : {}),
      ...(subtitle ? { subtitle } : {}),
      ...(badge ? { badge } : {}),
      ...(tone ? { tone } : {}),
    });
  });
  for (const lane of lanes) {
    lane.over =
      lane.wipLimit !== undefined &&
      lane.cards.length + lane.more > lane.wipLimit;
  }
  return lanes;
};

/** "3" or "3 / 2" with its limit, counting every card in the lane. */
export const laneCount = (lane: BoardLane): string => {
  const total = lane.cards.length + lane.more;
  return lane.wipLimit !== undefined
    ? `${total} / ${lane.wipLimit}`
    : String(total);
};

/** "12 more" under a lane past BOARD_LANE_MAX, else undefined. */
export const laneMoreText = (lane: BoardLane): string | undefined =>
  lane.more > 0 ? `${lane.more} more` : undefined;

export type BoardMove = {
  cards: JsonValue[];
  /** What `moved` receives; `from` and `to` are column ids (boardColumnOf). */
  moved: { cardId: string | null; index: number; from: string; to: string };
};

/**
 * Moves the card at array index `from` into listed column `to`, at
 * `position` among that column's other cards (clamped; default the end).
 * Cards are in the column boardColumnOf says. Undefined when nothing would
 * change or `to` isn't listed.
 */
export const moveBoardCard = (
  columns: BoardColumn[],
  raw: JsonValue[],
  from: number,
  to: string,
  position?: number,
): BoardMove | undefined => {
  const card = raw[from];
  if (!isObject(card) || !columns.some((column) => column.id === to)) {
    return undefined;
  }
  const origin = boardColumnOf(columns, card) ?? to;
  const rest = raw.filter((_, index) => index !== from);
  const inTarget = rest
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) => isObject(item) && boardColumnOf(columns, item) === to,
    );
  const at = Math.max(
    0,
    Math.min(position ?? inTarget.length, inTarget.length),
  );
  // Insert before the at-th card of the column, else after its last card,
  // else where the card was.
  const before = inTarget[at]?.index;
  const after = inTarget[inTarget.length - 1]?.index;
  const insertAt =
    before !== undefined
      ? before
      : after !== undefined
        ? after + 1
        : Math.min(from, rest.length);
  const moved = { ...card, column: to };
  const next = [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
  if (origin === to && insertAt === from) {
    return undefined;
  }
  return {
    cards: next,
    moved: {
      cardId: typeof card.id === "string" ? card.id : null,
      index: insertAt,
      from: origin,
      to,
    },
  };
};

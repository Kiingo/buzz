// Generated from the Kiingo surface renderer packages at cec9eff8903c0d5f3d7dd58145c4f4dfdf28fb98; do not edit here.
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
  id?: string;
  title: string;
  subtitle?: string;
  column: string;
  badge?: string;
  tone?: string;
};

export type BoardLane = BoardColumn & {
  cards: BoardCard[];
  /** Over its WIP limit. */
  over: boolean;
};

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
 * Cards by column, in array order. A card whose column isn't listed goes in
 * the first column, so nothing silently disappears.
 */
export const boardLanes = (
  columns: BoardColumn[],
  raw: unknown[],
  max = 500,
): BoardLane[] => {
  const known = new Set(columns.map((column) => column.id));
  const lanes = columns.map((column) => ({
    ...column,
    cards: [] as BoardCard[],
    over: false,
  }));
  raw.slice(0, max).forEach((item, index) => {
    if (!isObject(item) || lanes.length === 0) {
      return;
    }
    const column = plainText(item.column, 64) ?? "";
    const lane =
      lanes.find((entry) => entry.id === column) ??
      (known.has(column) ? undefined : lanes[0]);
    if (!lane) {
      return;
    }
    const id = plainText(item.id, 64);
    const subtitle = plainText(item.subtitle, 300);
    const badge = plainText(item.badge, 40);
    const tone = toneOf(item.tone);
    lane.cards.push({
      index,
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
      lane.wipLimit !== undefined && lane.cards.length > lane.wipLimit;
  }
  return lanes;
};

/** "3" or "3 / 2" with its limit. */
export const laneCount = (lane: BoardLane): string =>
  lane.wipLimit !== undefined
    ? `${lane.cards.length} / ${lane.wipLimit}`
    : String(lane.cards.length);

export type BoardMove = {
  cards: JsonValue[];
  /** What `moved` receives. */
  moved: { cardId: string | null; index: number; from: string; to: string };
};

/**
 * Moves the card at array index `from` into column `to`, at `position`
 * among that column's other cards (clamped; default the end). Undefined when
 * nothing would change.
 */
export const moveBoardCard = (
  raw: JsonValue[],
  from: number,
  to: string,
  position?: number,
): BoardMove | undefined => {
  const card = raw[from];
  if (!isObject(card)) {
    return undefined;
  }
  const origin = typeof card.column === "string" ? card.column : "";
  const rest = raw.filter((_, index) => index !== from);
  const inTarget = rest
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isObject(item) && item.column === to);
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

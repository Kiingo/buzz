// Generated from the Kiingo surface renderer packages at 8a4382a01c1d2046b63e7c78a1220c2c33e419a3; do not edit here.
import { isObject, type JsonObject, type JsonValue } from "./json";

// Ink (GENUI-SPATIAL, 2026-11-05): the drawn items of a Whiteboard (and
// ImageMarkup), read defensively from surface data (catalog ZUiInkItem):
// anything malformed is skipped, never drawn half. Geometry only; the
// painters live in each renderer (surface-react ink.tsx, the Swift kit).

export type InkPoint = { x: number; y: number };

export type InkItem =
  | {
      id: string;
      z: number;
      kind: "stroke";
      points: InkPoint[];
      pressure: number[] | undefined;
      color: string;
      width: number;
      tool: "pen" | "highlighter";
    }
  | {
      id: string;
      z: number;
      kind: "line" | "arrow";
      from: InkPoint;
      to: InkPoint;
      color: string;
      width: number;
    }
  | {
      id: string;
      z: number;
      kind: "rect" | "ellipse";
      x: number;
      y: number;
      w: number;
      h: number;
      color: string;
      width: number;
      fill: string | undefined;
    }
  | {
      id: string;
      z: number;
      kind: "text";
      x: number;
      y: number;
      text: string;
      size: number;
      color: string;
    };

export type InkTool =
  | "pen"
  | "highlighter"
  | "line"
  | "arrow"
  | "rect"
  | "ellipse"
  | "text"
  | "eraser";

export const INK_TOOLS: readonly InkTool[] = [
  "pen",
  "highlighter",
  "line",
  "arrow",
  "rect",
  "ellipse",
  "text",
  "eraser",
];

/** Default board size (catalog Whiteboard: 16:10, a wide card). */
export const INK_BOARD_WIDTH = 1600;
export const INK_BOARD_HEIGHT = 1000;
/** Grid and dot spacing in board units (catalog `background`). */
export const INK_GRID = 40;
/** Text line height as a multiple of the font size. */
export const INK_LINE_HEIGHT = 1.25;

const HEX = /^#[0-9A-Fa-f]{6}$/u;
const ITEM_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number =>
  finite(value) && value > 0;
const color = (value: unknown): string | undefined =>
  typeof value === "string" && HEX.test(value) ? value : undefined;
const point = (value: unknown): InkPoint | undefined =>
  Array.isArray(value) &&
  value.length === 2 &&
  finite(value[0]) &&
  finite(value[1])
    ? { x: value[0], y: value[1] }
    : undefined;

/** One stored item, or undefined when it isn't a well-formed InkItem. */
export const inkItemOf = (id: string, raw: unknown): InkItem | undefined => {
  if (!ITEM_ID.test(id) || !isObject(raw)) {
    return undefined;
  }
  const z = finite(raw.z) ? raw.z : 0;
  const ink = color(raw.color);
  if (!ink) {
    return undefined;
  }
  switch (raw.kind) {
    case "stroke": {
      const flat = raw.points;
      if (
        !Array.isArray(flat) ||
        flat.length < 2 ||
        flat.length % 2 !== 0 ||
        !flat.every(finite) ||
        !positive(raw.width)
      ) {
        return undefined;
      }
      const points: InkPoint[] = [];
      for (let index = 0; index < flat.length; index += 2) {
        points.push({ x: flat[index] as number, y: flat[index + 1] as number });
      }
      const pressure =
        Array.isArray(raw.pressure) &&
        raw.pressure.length === points.length &&
        raw.pressure.every((value) => finite(value) && value >= 0 && value <= 1)
          ? (raw.pressure as number[])
          : undefined;
      return {
        id,
        z,
        kind: "stroke",
        points,
        pressure,
        color: ink,
        width: raw.width,
        tool: raw.tool === "highlighter" ? "highlighter" : "pen",
      };
    }
    case "line":
    case "arrow": {
      const from = point(raw.from);
      const to = point(raw.to);
      return from && to && positive(raw.width)
        ? { id, z, kind: raw.kind, from, to, color: ink, width: raw.width }
        : undefined;
    }
    case "rect":
    case "ellipse":
      return finite(raw.x) &&
        finite(raw.y) &&
        finite(raw.w) &&
        finite(raw.h) &&
        raw.w >= 0 &&
        raw.h >= 0 &&
        positive(raw.width)
        ? {
            id,
            z,
            kind: raw.kind,
            x: raw.x,
            y: raw.y,
            w: raw.w,
            h: raw.h,
            color: ink,
            width: raw.width,
            fill: color(raw.fill),
          }
        : undefined;
    case "text":
      return finite(raw.x) &&
        finite(raw.y) &&
        positive(raw.size) &&
        typeof raw.text === "string" &&
        raw.text.length > 0
        ? {
            id,
            z,
            kind: "text",
            x: raw.x,
            y: raw.y,
            text: raw.text,
            size: raw.size,
            color: ink,
          }
        : undefined;
    default:
      return undefined;
  }
};

/** The board's items in draw order: z ascending, then id. */
export const inkItemsOf = (board: unknown): InkItem[] => {
  const items = isObject(board) ? board.items : undefined;
  if (!isObject(items)) {
    return [];
  }
  return Object.entries(items)
    .map(([id, raw]) => inkItemOf(id, raw))
    .filter((item): item is InkItem => item !== undefined)
    .sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

/** The stored form of an item (catalog ZUiInkItem), without its id. */
export const inkItemJson = (item: InkItem): JsonObject => {
  const base: JsonObject = item.z !== 0 ? { z: item.z } : {};
  switch (item.kind) {
    case "stroke":
      return {
        kind: "stroke",
        points: item.points.flatMap((p) => [p.x, p.y]),
        ...(item.pressure ? { pressure: item.pressure } : {}),
        color: item.color,
        width: item.width,
        ...(item.tool === "highlighter" ? { tool: "highlighter" } : {}),
        ...base,
      };
    case "line":
    case "arrow":
      return {
        kind: item.kind,
        from: [item.from.x, item.from.y],
        to: [item.to.x, item.to.y],
        color: item.color,
        width: item.width,
        ...base,
      };
    case "rect":
    case "ellipse":
      return {
        kind: item.kind,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        color: item.color,
        width: item.width,
        ...(item.fill ? { fill: item.fill } : {}),
        ...base,
      };
    case "text":
      return {
        kind: "text",
        x: item.x,
        y: item.y,
        text: item.text,
        size: item.size,
        color: item.color,
        ...base,
      };
  }
};

/** A fresh id for an item the person draws ("u" + random). */
export const newInkItemId = (): string => {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/gu, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `u${random.slice(0, 20)}`;
};

/** The highest z on the board, so a new item draws on top. */
export const inkTopZ = (items: readonly InkItem[]): number =>
  items.reduce((top, item) => Math.max(top, item.z), 0);

/** Rounds to one decimal: finer than a pixel at any board scale we draw. */
const round = (value: number): number => Math.round(value * 10) / 10;

/**
 * Ramer-Douglas-Peucker: drops points within `tolerance` board units of the
 * line through their neighbours (0.75 is under a pixel at the default
 * board), so a stroke stores about a tenth of its raw points.
 */
export const simplifyInk = (
  points: readonly InkPoint[],
  pressure: readonly number[] | undefined,
  tolerance = 0.75,
): { points: InkPoint[]; pressure: number[] | undefined } => {
  if (points.length <= 2) {
    return {
      points: points.map((p) => ({ x: round(p.x), y: round(p.y) })),
      pressure: pressure ? pressure.map(round2) : undefined,
    };
  }
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let farthest = -1;
    let distance = tolerance;
    for (let index = start + 1; index < end; index += 1) {
      const d = segmentDistance(points[index]!, points[start]!, points[end]!);
      if (d > distance) {
        distance = d;
        farthest = index;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = true;
      stack.push([start, farthest], [farthest, end]);
    }
  }
  const kept = points
    .map((_p, index) => (keep[index] ? index : -1))
    .filter((index) => index >= 0);
  return {
    points: kept.map((index) => ({
      x: round(points[index]!.x),
      y: round(points[index]!.y),
    })),
    pressure: pressure
      ? kept.map((index) => round2(pressure[index] ?? 0.5))
      : undefined,
  };
};

const round2 = (value: number): number =>
  Math.min(1, Math.max(0, Math.round(value * 100) / 100));

/** Distance from `p` to the segment a–b. */
export const segmentDistance = (
  p: InkPoint,
  a: InkPoint,
  b: InkPoint,
): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length),
        );
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/** Whether `p` touches the item, within `slop` board units (the eraser). */
export const inkHit = (item: InkItem, p: InkPoint, slop: number): boolean => {
  switch (item.kind) {
    case "stroke": {
      const reach = slop + item.width / 2;
      if (item.points.length === 1) {
        return (
          Math.hypot(p.x - item.points[0]!.x, p.y - item.points[0]!.y) <= reach
        );
      }
      for (let index = 1; index < item.points.length; index += 1) {
        if (
          segmentDistance(p, item.points[index - 1]!, item.points[index]!) <=
          reach
        ) {
          return true;
        }
      }
      return false;
    }
    case "line":
    case "arrow":
      return segmentDistance(p, item.from, item.to) <= slop + item.width / 2;
    case "rect": {
      const reach = slop + item.width / 2;
      const inside =
        p.x >= item.x - reach &&
        p.x <= item.x + item.w + reach &&
        p.y >= item.y - reach &&
        p.y <= item.y + item.h + reach;
      if (!inside) {
        return false;
      }
      if (item.fill) {
        return true;
      }
      return (
        Math.abs(p.x - item.x) <= reach ||
        Math.abs(p.x - item.x - item.w) <= reach ||
        Math.abs(p.y - item.y) <= reach ||
        Math.abs(p.y - item.y - item.h) <= reach
      );
    }
    case "ellipse": {
      const rx = item.w / 2;
      const ry = item.h / 2;
      if (rx === 0 || ry === 0) {
        return false;
      }
      const nx = (p.x - item.x - rx) / rx;
      const ny = (p.y - item.y - ry) / ry;
      const r = Math.hypot(nx, ny);
      const band = (slop + item.width / 2) / Math.min(rx, ry);
      return item.fill ? r <= 1 + band : Math.abs(r - 1) <= band;
    }
    case "text": {
      const box = inkTextBox(item);
      return (
        p.x >= box.x - slop &&
        p.x <= box.x + box.w + slop &&
        p.y >= box.y - slop &&
        p.y <= box.y + box.h + slop
      );
    }
  }
};

/**
 * A text item's box, estimated without a font (0.6 em a character): for
 * hit tests and the screen-reader order, not for drawing.
 */
export const inkTextBox = (
  item: Extract<InkItem, { kind: "text" }>,
): { x: number; y: number; w: number; h: number } => {
  const lines = item.text.split("\n");
  const longest = lines.reduce((top, line) => Math.max(top, line.length), 0);
  return {
    x: item.x,
    y: item.y,
    w: longest * item.size * 0.6,
    h: lines.length * item.size * INK_LINE_HEIGHT,
  };
};

/** One plain line per item for screen readers and the snapshot alt text. */
export const inkItemDescription = (item: InkItem): string => {
  switch (item.kind) {
    case "stroke":
      return item.tool === "highlighter" ? "Highlight" : "Pen stroke";
    case "line":
      return "Line";
    case "arrow":
      return "Arrow";
    case "rect":
      return item.fill ? "Filled rectangle" : "Rectangle";
    case "ellipse":
      return item.fill ? "Filled ellipse" : "Ellipse";
    case "text":
      return `Text: ${item.text}`;
  }
};

/** The board size from the component's props (defaults when missing). */
export const inkBoardSize = (
  width: unknown,
  height: unknown,
): { width: number; height: number } => ({
  width: positive(width) ? Math.round(width) : INK_BOARD_WIDTH,
  height: positive(height) ? Math.round(height) : INK_BOARD_HEIGHT,
});

/** Whether a raw board value is `{ items: {...} }` (else edits write the whole board). */
export const hasInkItems = (board: JsonValue | undefined): boolean =>
  isObject(board) && isObject(board.items);

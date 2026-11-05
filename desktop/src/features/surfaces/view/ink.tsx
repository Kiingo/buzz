// Generated from the Kiingo surface renderer packages at f7dffff48426f852528f24ecb4cb04fb5bc2d5b2; do not edit here.
import {
  INK_GRID,
  INK_LINE_HEIGHT,
  type InkItem,
  type InkPoint,
} from "../core";

// The ink painter (GENUI-SPATIAL): draws InkItems on a 2D canvas in board
// units. Shared by Whiteboard and ImageMarkup; the Swift kit draws the same
// way (UiInk.swift). Colours are #RRGGBB only (surface-core `inkItemOf`),
// drawn only inside the board, like ColorPicker swatches.

export type InkBackground = "blank" | "grid" | "dots" | "none";

/** Highlighter ink: see-through so the strokes under it still show. */
const HIGHLIGHTER_ALPHA = 0.35;

export const paintInkBackground = (
  ink: CanvasRenderingContext2D,
  width: number,
  height: number,
  background: InkBackground,
) => {
  if (background === "none") {
    return;
  }
  ink.fillStyle = "#FFFFFF";
  ink.fillRect(0, 0, width, height);
  if (background === "grid") {
    ink.strokeStyle = "#E5E7EB";
    ink.lineWidth = 1;
    ink.beginPath();
    for (let x = INK_GRID; x < width; x += INK_GRID) {
      ink.moveTo(x, 0);
      ink.lineTo(x, height);
    }
    for (let y = INK_GRID; y < height; y += INK_GRID) {
      ink.moveTo(0, y);
      ink.lineTo(width, y);
    }
    ink.stroke();
  } else if (background === "dots") {
    ink.fillStyle = "#D1D5DB";
    for (let x = INK_GRID; x < width; x += INK_GRID) {
      for (let y = INK_GRID; y < height; y += INK_GRID) {
        ink.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
    }
  }
};

const arrowHead = (
  ink: CanvasRenderingContext2D,
  from: InkPoint,
  to: InkPoint,
  width: number,
) => {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.max(12, width * 4);
  ink.beginPath();
  for (const side of [-1, 1]) {
    ink.moveTo(to.x, to.y);
    ink.lineTo(
      to.x - length * Math.cos(angle + (side * Math.PI) / 7),
      to.y - length * Math.sin(angle + (side * Math.PI) / 7),
    );
  }
  ink.stroke();
};

/** One item, in board units (the caller sets the scale). */
export const paintInkItem = (ink: CanvasRenderingContext2D, item: InkItem) => {
  ink.save();
  ink.lineCap = "round";
  ink.lineJoin = "round";
  ink.strokeStyle = item.color;
  ink.fillStyle = item.color;
  switch (item.kind) {
    case "stroke": {
      if (item.tool === "highlighter") {
        ink.globalAlpha = HIGHLIGHTER_ALPHA;
      }
      const points = item.points;
      if (points.length === 1) {
        ink.beginPath();
        ink.arc(points[0]!.x, points[0]!.y, item.width / 2, 0, Math.PI * 2);
        ink.fill();
        break;
      }
      if (!item.pressure) {
        ink.lineWidth = item.width;
        ink.beginPath();
        ink.moveTo(points[0]!.x, points[0]!.y);
        for (const p of points.slice(1)) {
          ink.lineTo(p.x, p.y);
        }
        ink.stroke();
        break;
      }
      // Pressure: each segment at its own width (0.5x to 1.5x).
      for (let index = 1; index < points.length; index += 1) {
        const pressure =
          ((item.pressure[index - 1] ?? 0.5) + (item.pressure[index] ?? 0.5)) /
          2;
        ink.lineWidth = item.width * (0.5 + pressure);
        ink.beginPath();
        ink.moveTo(points[index - 1]!.x, points[index - 1]!.y);
        ink.lineTo(points[index]!.x, points[index]!.y);
        ink.stroke();
      }
      break;
    }
    case "line":
    case "arrow":
      ink.lineWidth = item.width;
      ink.beginPath();
      ink.moveTo(item.from.x, item.from.y);
      ink.lineTo(item.to.x, item.to.y);
      ink.stroke();
      if (item.kind === "arrow") {
        arrowHead(ink, item.from, item.to, item.width);
      }
      break;
    case "rect":
    case "ellipse":
      ink.lineWidth = item.width;
      ink.beginPath();
      if (item.kind === "rect") {
        ink.rect(item.x, item.y, item.w, item.h);
      } else {
        ink.ellipse(
          item.x + item.w / 2,
          item.y + item.h / 2,
          item.w / 2,
          item.h / 2,
          0,
          0,
          Math.PI * 2,
        );
      }
      if (item.fill) {
        ink.fillStyle = item.fill;
        ink.fill();
      }
      ink.stroke();
      break;
    case "text":
      ink.font = `${item.size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ink.textBaseline = "top";
      item.text.split("\n").forEach((line, index) => {
        ink.fillText(
          line,
          item.x,
          item.y + index * item.size * INK_LINE_HEIGHT,
        );
      });
      break;
  }
  ink.restore();
};

/**
 * The whole board onto `canvas`, scaled from board units to the canvas's
 * pixel size. `extra` is the item being drawn right now (not saved yet).
 */
export const paintInk = (
  canvas: HTMLCanvasElement,
  board: { width: number; height: number },
  items: readonly InkItem[],
  background: InkBackground,
  extra?: InkItem,
) => {
  const ink = canvas.getContext("2d");
  if (!ink) {
    return;
  }
  ink.setTransform(1, 0, 0, 1, 0, 0);
  ink.clearRect(0, 0, canvas.width, canvas.height);
  ink.scale(canvas.width / board.width, canvas.height / board.height);
  paintInkBackground(ink, board.width, board.height, background);
  for (const item of items) {
    paintInkItem(ink, item);
  }
  if (extra) {
    paintInkItem(ink, extra);
  }
};

/**
 * Canvas pixels for a board: the board's own size up to 2048 px on its
 * longest side (the photo capture's long edge), so a very large board
 * doesn't allocate a huge bitmap; the drawing is the same, only scaled.
 */
export const inkCanvasSize = (board: {
  width: number;
  height: number;
}): { width: number; height: number } => {
  const scale = Math.min(1, 2048 / Math.max(board.width, board.height));
  return {
    width: Math.max(1, Math.round(board.width * scale)),
    height: Math.max(1, Math.round(board.height * scale)),
  };
};

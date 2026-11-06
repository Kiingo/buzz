// Generated from the Kiingo surface renderer packages at 8a4382a01c1d2046b63e7c78a1220c2c33e419a3; do not edit here.
import {
  appendPointer,
  bindingOf,
  hasInkItems,
  INK_TOOLS,
  inkBoardSize,
  inkHit,
  inkItemDescription,
  inkItemJson,
  inkItemsOf,
  inkTopZ,
  isObject,
  newInkItemId,
  simplifyInk,
  type InkItem,
  type InkPoint,
  type InkTool,
  type JsonValue,
} from "../core";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "./cn";
import { useNodeContext } from "./context";
import { FileRow } from "./display";
import { aria, type FieldProps } from "./field";
import { Glyphs } from "./icons";
import { inkCanvasSize, paintInk, type InkBackground } from "./ink";
import { SurfaceButton } from "./ui";
import { fileRefOf } from "./uploads";

// Whiteboard (GENUI-SPATIAL, 2026-11-05). The board is the bound value
// `{ items: { [id]: InkItem } }`. Each item the person draws, erases or
// changes is its own edit at `<value>/items/<id>`, so it never overlaps the
// agent's items under user-wins; Clear replaces the items map. Share
// snapshot uploads a PNG only on the person's tap (the capture rule), like
// SignaturePad's Done. The Swift kit is the reference for wording.

const TOOL_LABEL: Record<InkTool, string> = {
  pen: "Pen",
  highlighter: "Highlighter",
  line: "Line",
  arrow: "Arrow",
  rect: "Rectangle",
  ellipse: "Ellipse",
  text: "Text",
  eraser: "Eraser",
};

/** The palette the person picks from (the agent may use any #RRGGBB). */
const COLORS: ReadonlyArray<{ hex: string; name: string }> = [
  { hex: "#111827", name: "Black" },
  { hex: "#DC2626", name: "Red" },
  { hex: "#2563EB", name: "Blue" },
  { hex: "#16A34A", name: "Green" },
  { hex: "#F59E0B", name: "Yellow" },
  { hex: "#9333EA", name: "Purple" },
];

/** Line widths in board units; text sizes follow them. */
const WIDTHS: ReadonlyArray<{ width: number; name: string }> = [
  { width: 3, name: "Thin" },
  { width: 6, name: "Medium" },
  { width: 12, name: "Thick" },
];

/** Eraser and tap reach in board units: about a fingertip at the default board. */
const SLOP = 12;

type Undo =
  | { kind: "added"; id: string }
  | { kind: "removed"; id: string; item: JsonValue }
  | { kind: "cleared"; items: JsonValue };

type Drag = {
  tool: InkTool;
  start: InkPoint;
  points: InkPoint[];
  pressure: number[];
};

const shapeOf = (
  drag: Drag,
  at: InkPoint,
  color: string,
  width: number,
  z: number,
): InkItem | undefined => {
  const id = "draft";
  switch (drag.tool) {
    case "pen":
    case "highlighter":
      return {
        id,
        z,
        kind: "stroke",
        points: drag.points,
        pressure: undefined,
        color,
        width: drag.tool === "highlighter" ? width * 3 : width,
        tool: drag.tool,
      };
    case "line":
    case "arrow":
      return { id, z, kind: drag.tool, from: drag.start, to: at, color, width };
    case "rect":
    case "ellipse":
      return {
        id,
        z,
        kind: drag.tool,
        x: Math.min(drag.start.x, at.x),
        y: Math.min(drag.start.y, at.y),
        w: Math.abs(at.x - drag.start.x),
        h: Math.abs(at.y - drag.start.y),
        color,
        width,
        fill: undefined,
      };
    default:
      return undefined;
  }
};

export const WhiteboardInput = (props: FieldProps) => {
  const context = useNodeContext();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | undefined>(undefined);
  const [draft, setDraft] = useState<InkItem>();
  const [tool, setTool] = useState<InkTool>("pen");
  const [color, setColor] = useState(COLORS[0]!.hex);
  const [width, setWidth] = useState(WIDTHS[1]!.width);
  const [typing, setTyping] = useState<{ at: InkPoint; text: string }>();
  const [undo, setUndo] = useState<Undo[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  const component = props.component;
  const raw = context.read(props.pointer);
  const items = useMemo(() => inkItemsOf(raw), [raw]);
  const board = inkBoardSize(component.props.width, component.props.height);
  const pixels = inkCanvasSize(board);
  const background =
    (["blank", "grid", "dots"] as const).find(
      (value) => value === context.string(component, "background"),
    ) ?? "blank";
  const listed = Array.isArray(component.props.tools)
    ? INK_TOOLS.filter((name) =>
        (component.props.tools as unknown[]).includes(name),
      )
    : [];
  const tools = listed.length ? listed : INK_TOOLS;
  const readOnly = context.flag(component, "readOnly", props.scope);
  const drawing = !props.disabled && !readOnly;
  const snapshotPointer = bindingOf(component.props.snapshot, props.scope);
  const snapshot = snapshotPointer ? context.read(snapshotPointer) : undefined;
  const upload = context.host.uploadFile;

  useEffect(() => {
    if (!tools.includes(tool)) {
      setTool(tools[0]!);
    }
  }, [tools, tool]);

  useEffect(() => {
    if (canvas.current) {
      paintInk(
        canvas.current,
        board,
        items,
        background as InkBackground,
        draft,
      );
    }
  }, [items, draft, board.width, board.height, background]);

  const itemPointer = (id: string) =>
    appendPointer(appendPointer(props.pointer, "items"), id);

  /** Writes one item (or removes it with undefined) as its own edit. */
  const put = (id: string, value: JsonValue | undefined) => {
    if (hasInkItems(raw)) {
      context.edit(itemPointer(id), value);
      return;
    }
    // No board yet: the first item writes the whole value.
    const base = isObject(raw) ? raw : {};
    context.edit(props.pointer, {
      ...base,
      items: value === undefined ? {} : { [id]: value },
    });
  };

  const add = (item: InkItem) => {
    const id = newInkItemId();
    put(id, inkItemJson(item));
    setUndo((stack) => [...stack, { kind: "added", id }]);
  };

  const at = (event: ReactPointerEvent<HTMLCanvasElement>): InkPoint => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * board.width,
      y: ((event.clientY - box.top) / box.height) * board.height,
    };
  };

  const erase = (p: InkPoint) => {
    const hit = [...items].reverse().find((item) => inkHit(item, p, SLOP));
    if (!hit) {
      return;
    }
    const stored =
      isObject(raw) && isObject(raw.items) ? raw.items[hit.id] : undefined;
    put(hit.id, undefined);
    if (stored !== undefined) {
      setUndo((stack) => [
        ...stack,
        { kind: "removed", id: hit.id, item: stored },
      ]);
    }
  };

  const down = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing || busy) {
      return;
    }
    const p = at(event);
    if (tool === "text") {
      setTyping({ at: p, text: "" });
      return;
    }
    if (tool === "eraser") {
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { tool, start: p, points: [p], pressure: [] };
      erase(p);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      tool,
      start: p,
      points: [p],
      pressure: [event.pointerType === "pen" ? event.pressure : 0.5],
    };
    setDraft(shapeOf(drag.current, p, color, width, inkTopZ(items) + 1));
  };

  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = drag.current;
    if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    const p = at(event);
    if (current.tool === "eraser") {
      erase(p);
      return;
    }
    current.points.push(p);
    current.pressure.push(event.pointerType === "pen" ? event.pressure : 0.5);
    setDraft(shapeOf(current, p, color, width, inkTopZ(items) + 1));
  };

  const up = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = drag.current;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraft(undefined);
    if (!current || current.tool === "eraser") {
      return;
    }
    const p = at(event);
    const z = inkTopZ(items) + 1;
    if (current.tool === "pen" || current.tool === "highlighter") {
      const pen = event.pointerType === "pen";
      const simple = simplifyInk(
        current.points,
        pen ? current.pressure : undefined,
      );
      add({
        id: "new",
        z,
        kind: "stroke",
        points: simple.points,
        pressure: simple.pressure,
        color,
        width: current.tool === "highlighter" ? width * 3 : width,
        tool: current.tool,
      });
      return;
    }
    const shape = shapeOf(current, p, color, width, z);
    const tiny =
      Math.hypot(p.x - current.start.x, p.y - current.start.y) < SLOP / 2;
    if (shape && !tiny) {
      add(shape);
    }
  };

  const commitText = () => {
    const pending = typing;
    setTyping(undefined);
    const text = pending?.text.trim();
    if (!pending || !text) {
      return;
    }
    add({
      id: "new",
      z: inkTopZ(items) + 1,
      kind: "text",
      x: pending.at.x,
      y: pending.at.y,
      text,
      size: width * 6,
      color,
    });
  };

  const undoLast = () => {
    const last = undo[undo.length - 1];
    if (!last) {
      return;
    }
    setUndo((stack) => stack.slice(0, -1));
    if (last.kind === "added") {
      put(last.id, undefined);
    } else if (last.kind === "removed") {
      put(last.id, last.item);
    } else {
      context.edit(appendPointer(props.pointer, "items"), last.items);
    }
  };

  const clear = () => {
    if (!hasInkItems(raw) || items.length === 0) {
      return;
    }
    const before = (raw as { items: JsonValue }).items;
    context.edit(appendPointer(props.pointer, "items"), {});
    setUndo((stack) => [...stack, { kind: "cleared", items: before }]);
  };

  const share = () => {
    if (!upload || !snapshotPointer) {
      return;
    }
    const element = document.createElement("canvas");
    element.width = pixels.width;
    element.height = pixels.height;
    paintInk(element, board, items, background as InkBackground);
    setBusy(true);
    setProblem(undefined);
    element.toBlob((blob) => {
      if (!blob) {
        setBusy(false);
        setProblem("Couldn’t make the snapshot. Try again.");
        return;
      }
      void upload(blob, "whiteboard.png", {
        surfaceId: context.controller.id,
        ...(context.controller.surface.agentId
          ? { agentId: context.controller.surface.agentId }
          : {}),
      })
        .then((answer) => {
          if (answer.kind === "uploaded") {
            context.edit(snapshotPointer, fileRefOf(answer.file));
          } else {
            setProblem(answer.message);
          }
        })
        .catch(() => setProblem("The snapshot didn’t upload. Try again."))
        .finally(() => setBusy(false));
    }, "image/png");
  };

  const summary =
    items.length === 0
      ? "Empty whiteboard."
      : `Whiteboard with ${items.length} ${items.length === 1 ? "item" : "items"}.`;

  return (
    <div className="flex flex-col gap-1.5" {...aria(props)}>
      {drawing ? (
        <div
          className="flex flex-wrap items-center gap-1"
          role="toolbar"
          aria-label="Drawing tools"
        >
          {tools.map((name) => (
            <SurfaceButton
              key={name}
              size="sm"
              variant={tool === name ? "primary" : "plain"}
              aria-pressed={tool === name}
              disabled={busy}
              onClick={() => setTool(name)}
            >
              {TOOL_LABEL[name]}
            </SurfaceButton>
          ))}
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          {COLORS.map((swatch) => (
            <button
              key={swatch.hex}
              type="button"
              aria-label={swatch.name}
              aria-pressed={color === swatch.hex}
              onClick={() => setColor(swatch.hex)}
              className={cn(
                "h-6 w-6 rounded-full border",
                color === swatch.hex
                  ? "ring-2 ring-ring ring-offset-1"
                  : "border-border",
              )}
              style={{ backgroundColor: swatch.hex }}
            />
          ))}
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          {WIDTHS.map((option) => (
            <SurfaceButton
              key={option.width}
              size="sm"
              variant={width === option.width ? "primary" : "plain"}
              aria-pressed={width === option.width}
              onClick={() => setWidth(option.width)}
            >
              {option.name}
            </SurfaceButton>
          ))}
        </div>
      ) : null}
      <div className="relative">
        <canvas
          ref={canvas}
          width={pixels.width}
          height={pixels.height}
          role="img"
          aria-label={summary}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          className={cn(
            "block w-full touch-none rounded-md border border-input bg-white",
            drawing ? "cursor-crosshair" : "",
            props.disabled ? "opacity-50" : "",
          )}
          style={{ aspectRatio: `${board.width} / ${board.height}` }}
        />
        {typing ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: the person just tapped where the text goes.
            autoFocus
            type="text"
            aria-label="Text to add to the board"
            value={typing.text}
            onChange={(event) =>
              setTyping({ ...typing, text: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitText();
              } else if (event.key === "Escape") {
                setTyping(undefined);
              }
            }}
            onBlur={commitText}
            className="absolute h-7 w-48 rounded border border-input bg-background px-2 text-xs"
            style={{
              left: `${(typing.at.x / board.width) * 100}%`,
              top: `${(typing.at.y / board.height) * 100}%`,
            }}
          />
        ) : null}
      </div>
      <ul className="sr-only">
        {items.map((item) => (
          <li key={item.id}>{inkItemDescription(item)}</li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {drawing ? (
          <>
            <SurfaceButton
              size="sm"
              variant="plain"
              disabled={busy || undo.length === 0}
              onClick={undoLast}
            >
              Undo
            </SurfaceButton>
            <SurfaceButton
              size="sm"
              variant="plain"
              disabled={busy || items.length === 0}
              onClick={clear}
            >
              Clear
            </SurfaceButton>
          </>
        ) : null}
        {snapshotPointer ? (
          upload ? (
            <SurfaceButton
              size="sm"
              disabled={busy || props.disabled}
              onClick={share}
            >
              {busy ? "Sharing…" : "Share snapshot"}
            </SurfaceButton>
          ) : (
            <span className="text-xs text-muted-foreground">
              Share a snapshot in the Kiingo app.
            </span>
          )
        ) : null}
      </div>
      {isObject(snapshot) ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Glyphs.success aria-hidden className="h-3.5 w-3.5" />
          <span>Snapshot shared</span>
          <div className="min-w-0 flex-1">
            <FileRow item={snapshot} outside={false} />
          </div>
        </div>
      ) : null}
      {problem ? (
        <p role="status" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  );
};

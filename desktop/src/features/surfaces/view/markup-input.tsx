// Generated from the Kiingo surface renderer packages at f7dffff48426f852528f24ecb4cb04fb5bc2d5b2; do not edit here.
import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  compareModelOf,
  inkItemJson,
  isObject,
  newInkItemId,
  type CompareSide,
  type InkItem,
  type InkPoint,
  type InkTool,
  type JsonValue,
} from "../core";
import { cn } from "./cn";
import { useNodeContext } from "./context";
import { FileRow } from "./display";
import { aria, type FieldProps } from "./field";
import type { UploadTarget } from "./host";
import { Glyphs } from "./icons";
import { paintInk, paintInkItem } from "./ink";
import { usePicture } from "./markup";
import { QuotedText, SurfaceButton } from "./ui";
import { fileRefOf } from "./uploads";

// ImageMarkup (GENUI-MARKUP; 79 OK 2026-11-05): the person draws on an image
// and presses Done. Done flattens the image and the marks into a NEW PNG,
// uploads it through `SurfaceHost.uploadFile` (the viewer's own chat
// attachment upload) and saves `{ ...file ref, width, height, items }`;
// the original file is never written. Nothing uploads on render or for an
// agent. Items are the shared ink items (ui-catalog `ZUiInkItem`, with
// Whiteboard) in the image's own pixels, painted by the shared ink painter
// (`ink.tsx`) as the Swift kit paints them. The Swift kit is the reference.

/** The tools ImageMarkup offers (catalog IMAGE_MARKUP_TOOLS), in its order. */
type MarkupTool = Extract<
  InkTool,
  "pen" | "highlighter" | "arrow" | "rect" | "ellipse" | "text"
>;

const MARKUP_TOOLS: readonly MarkupTool[] = [
  "pen",
  "highlighter",
  "arrow",
  "rect",
  "ellipse",
  "text",
];

const TOOL_LABELS: Record<MarkupTool, string> = {
  pen: "Pen",
  highlighter: "Highlighter",
  arrow: "Arrow",
  rect: "Box",
  ellipse: "Ellipse",
  text: "Text",
};

/** Kiingo red for ink, yellow for the highlighter (FILEVIEW's PDF markup colours). */
const INK = "#DC2626";
const HIGHLIGHT = "#FACC15";

const isHighlight = (item: InkItem) =>
  item.kind === "stroke" && item.tool === "highlighter";

/**
 * Highlighters under the ink, so a highlight never dims a mark drawn before
 * it; otherwise the order drawn (the Swift kit's `ordered`). The drawing
 * layer and the flattened PNG paint the same list, so what the person saw
 * is what is saved.
 */
const ordered = (items: readonly InkItem[]): InkItem[] => [
  ...items.filter(isHighlight),
  ...items.filter((item) => !isHighlight(item)),
];

type Draft =
  | { kind: "stroke"; points: InkPoint[] }
  | { kind: "drag"; from: InkPoint; to: InkPoint };

const useTarget = (): UploadTarget => {
  const { controller } = useNodeContext();
  return {
    surfaceId: controller.id,
    ...(controller.surface.agentId
      ? { agentId: controller.surface.agentId }
      : {}),
  };
};

/** The PNG's name: the image's, marked up; never the original's name alone. */
const markedName = (name: string | undefined): string => {
  const base = (name ?? "image").replace(/\.[A-Za-z0-9]{1,5}$/u, "");
  return `${base || "image"} (marked up).png`;
};

export const ImageMarkupInput = (props: FieldProps) => {
  const context = useNodeContext();
  const target = useTarget();
  const upload = context.host.uploadFile;
  const imageValue = context.value(props.component, "image", props.scope);
  // An image reads as a Compare side does (the same loader and checks).
  const side: CompareSide | undefined =
    compareModelOf(imageValue, imageValue, undefined, undefined, undefined)
      ?.before ?? undefined;
  const picture = usePicture(side ?? { page: 1, label: "", alt: "" });
  const outside = context.isUntrusted(props.component, "image", props.scope);
  const prompt = context.text(props.component, "prompt", props.scope, 300);
  const listed = context
    .list(props.component, "tools", props.scope)
    .filter(
      (tool): tool is MarkupTool =>
        typeof tool === "string" &&
        (MARKUP_TOOLS as readonly string[]).includes(tool),
    );
  const tools = listed.length ? listed : [...MARKUP_TOOLS];
  const raw = context.read(props.pointer);
  const saved = isObject(raw) ? raw : undefined;

  const [tool, setTool] = useState<MarkupTool>(tools[0]!);
  // The person's marks, in the order drawn (local until Done).
  const [items, setItems] = useState<InkItem[]>([]);
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [note, setNote] = useState<
    { x: number; y: number; text: string } | undefined
  >(undefined);
  const [natural, setNatural] = useState<{ w: number; h: number } | undefined>(
    undefined,
  );
  const [shown, setShown] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const image = useRef<HTMLImageElement>(null);
  const layer = useRef<HTMLCanvasElement>(null);
  const pointerId = useRef<number | undefined>(undefined);

  // Widths and text size scale with the image, so marks read the same on a
  // phone photo and a 4K screenshot.
  const unit = natural ? Math.max(natural.w, natural.h) : 1000;
  const widthFor = (kind: MarkupTool) =>
    kind === "highlighter" ? unit * 0.02 : Math.max(2, unit * 0.004);
  const textSize = Math.max(14, unit * 0.03);

  const draftItem = (): InkItem | undefined => {
    if (!draft) {
      return undefined;
    }
    const z = items.length;
    if (draft.kind === "stroke") {
      const highlighter = tool === "highlighter";
      return {
        id: "draft",
        z,
        kind: "stroke",
        points: draft.points,
        pressure: undefined,
        color: highlighter ? HIGHLIGHT : INK,
        width: widthFor(tool),
        tool: highlighter ? "highlighter" : "pen",
      };
    }
    const { from, to } = draft;
    if (tool === "arrow") {
      return {
        id: "draft",
        z,
        kind: "arrow",
        from,
        to,
        color: INK,
        width: widthFor("arrow"),
      };
    }
    return {
      id: "draft",
      z,
      kind: tool === "ellipse" ? "ellipse" : "rect",
      x: Math.min(from.x, to.x),
      y: Math.min(from.y, to.y),
      w: Math.abs(to.x - from.x),
      h: Math.abs(to.y - from.y),
      color: INK,
      width: widthFor(tool),
      fill: undefined,
    };
  };

  // Repaint the drawing layer at the size the image is shown.
  useEffect(() => {
    const canvas = layer.current;
    if (!canvas || !natural || shown.w <= 0) {
      return;
    }
    const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.max(1, Math.floor(shown.w * ratio));
    canvas.height = Math.max(1, Math.floor(shown.h * ratio));
    const extra = draftItem();
    paintInk(
      canvas,
      { width: natural.w, height: natural.h },
      ordered(extra ? [...items, extra] : items),
      "none",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, draft, shown, natural, tool]);

  // Track the shown size (the card resizes with the window).
  useEffect(() => {
    const element = image.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(() =>
      setShown({ w: element.clientWidth, h: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [picture.kind]);

  const add = (item: InkItem) => {
    setItems((current) => [
      ...current,
      { ...item, id: newInkItemId(), z: current.length },
    ]);
  };
  const undo = () => {
    setItems((current) => current.slice(0, -1));
  };
  const clear = () => {
    setItems([]);
    setNote(undefined);
    setProblem(undefined);
  };

  const at = (event: PointerEvent<HTMLCanvasElement>): InkPoint => {
    const box = event.currentTarget.getBoundingClientRect();
    const scale = natural ? natural.w / Math.max(1, box.width) : 1;
    const x = Math.min(box.width, Math.max(0, event.clientX - box.left));
    const y = Math.min(box.height, Math.max(0, event.clientY - box.top));
    return { x: x * scale, y: y * scale };
  };

  const done = async () => {
    const element = image.current;
    if (!upload || !element || !natural || items.length === 0) {
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = natural.w;
      canvas.height = natural.h;
      const ink = canvas.getContext("2d");
      if (!ink) {
        throw new Error("no canvas");
      }
      ink.drawImage(element, 0, 0, natural.w, natural.h);
      for (const item of ordered(items)) {
        paintInkItem(ink, item);
      }
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!blob) {
        throw new Error("no png");
      }
      const answer = await upload(blob, markedName(side?.name), target);
      if (answer.kind !== "uploaded") {
        setProblem(answer.message);
        return;
      }
      context.edit(props.pointer, {
        ...(fileRefOf(answer.file) as Record<string, JsonValue>),
        width: natural.w,
        height: natural.h,
        items: Object.fromEntries(
          items.map((item) => [item.id, inkItemJson(item)]),
        ),
      });
      clear();
    } catch {
      setProblem("The marked-up image didn’t save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const savedRow = saved ? (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Glyphs.success aria-hidden className="h-3.5 w-3.5" />
      <span>Marked up</span>
      <div className="min-w-0 flex-1">
        <FileRow item={saved} outside={false} />
      </div>
    </div>
  ) : null;

  if (!side) {
    return (
      <p className="text-xs text-muted-foreground">No image to mark up.</p>
    );
  }
  if (picture.kind !== "image") {
    return (
      <div className="flex flex-col gap-1.5" {...aria(props)}>
        {savedRow}
        <div className="flex min-h-[5rem] flex-col justify-center gap-1.5 rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
          {side.fileId ? (
            <FileRow
              item={{
                artifactId: side.fileId,
                name: side.name ?? side.alt,
                ...(side.contentType ? { contentType: side.contentType } : {}),
              }}
              outside={outside}
            />
          ) : (
            <span className="flex items-center gap-2">
              <Glyphs.image aria-hidden className="h-4 w-4 shrink-0" />
              {outside ? (
                <QuotedText text={side.alt} />
              ) : (
                <span>{side.alt}</span>
              )}
            </span>
          )}
          <span role="status">
            {picture.kind === "loading"
              ? "Loading…"
              : picture.kind === "checking"
                ? "Checking…"
                : picture.kind === "closed"
                  ? picture.message
                  : (picture.message ?? "The image can’t be marked up here.")}
          </span>
        </div>
      </div>
    );
  }

  const drawing = Boolean(upload) && !props.disabled && !busy;
  return (
    <div className="flex flex-col gap-1.5" {...aria(props)}>
      {savedRow}
      {prompt ? (
        <p className="text-xs text-muted-foreground">{prompt}</p>
      ) : null}
      {drawing ? (
        <div
          role="toolbar"
          aria-label="Markup tools"
          className="flex flex-wrap gap-1"
        >
          {tools.map((option) => (
            <SurfaceButton
              key={option}
              size="sm"
              variant={tool === option ? "primary" : "plain"}
              aria-pressed={tool === option}
              onClick={() => {
                setTool(option);
                setNote(undefined);
              }}
            >
              {TOOL_LABELS[option]}
            </SurfaceButton>
          ))}
        </div>
      ) : null}
      <div className="relative w-full">
        <img
          ref={image}
          src={picture.src}
          alt={side.alt}
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={(event) => {
            const element = event.currentTarget;
            setNatural({ w: element.naturalWidth, h: element.naturalHeight });
            setShown({ w: element.clientWidth, h: element.clientHeight });
          }}
          className="block h-auto max-h-[32rem] w-full select-none rounded-md bg-muted object-contain"
        />
        <canvas
          ref={layer}
          aria-hidden={!drawing}
          aria-label={
            drawing
              ? `Draw with the ${TOOL_LABELS[tool].toLowerCase()}`
              : undefined
          }
          role={drawing ? "img" : undefined}
          className={cn(
            "absolute left-0 top-0",
            drawing ? "cursor-crosshair touch-none" : "pointer-events-none",
          )}
          style={{ width: shown.w, height: shown.h }}
          onPointerDown={(event) => {
            if (!drawing || event.button !== 0) {
              return;
            }
            const point = at(event);
            if (tool === "text") {
              setNote({ x: point.x, y: point.y, text: "" });
              return;
            }
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            pointerId.current = event.pointerId;
            setDraft(
              tool === "pen" || tool === "highlighter"
                ? { kind: "stroke", points: [point] }
                : { kind: "drag", from: point, to: point },
            );
          }}
          onPointerMove={(event) => {
            if (pointerId.current !== event.pointerId) {
              return;
            }
            const point = at(event);
            setDraft((current) =>
              !current
                ? current
                : current.kind === "stroke"
                  ? { kind: "stroke", points: [...current.points, point] }
                  : { ...current, to: point },
            );
          }}
          onPointerUp={(event) => {
            if (pointerId.current !== event.pointerId) {
              return;
            }
            pointerId.current = undefined;
            const item = draftItem();
            const last = draft;
            setDraft(undefined);
            // A tap draws no box or arrow: those need a drag.
            if (
              last?.kind === "drag" &&
              Math.hypot(last.to.x - last.from.x, last.to.y - last.from.y) <
                unit * 0.005
            ) {
              return;
            }
            if (item) {
              add(item);
            }
          }}
          onPointerCancel={() => {
            pointerId.current = undefined;
            setDraft(undefined);
          }}
        />
      </div>
      {!upload ? (
        <p className="text-xs text-muted-foreground">
          Mark it up in the Kiingo app.
        </p>
      ) : null}
      {drawing && (tool === "text" || note) ? (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={note?.text ?? ""}
            disabled={!note}
            placeholder={
              note ? "Type a note" : "Tap the image where the note goes"
            }
            aria-label="Note text"
            onChange={(event) =>
              setNote((current) =>
                current ? { ...current, text: event.target.value } : current,
              )
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && note?.text.trim()) {
                event.preventDefault();
                add({
                  id: "draft",
                  z: 0,
                  kind: "text",
                  x: note.x,
                  y: note.y,
                  text: note.text.trim(),
                  size: textSize,
                  color: INK,
                });
                setNote(undefined);
              }
            }}
            className="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2 text-xs"
          />
          <SurfaceButton
            size="sm"
            disabled={!note?.text.trim()}
            onClick={() => {
              if (note?.text.trim()) {
                add({
                  id: "draft",
                  z: 0,
                  kind: "text",
                  x: note.x,
                  y: note.y,
                  text: note.text.trim(),
                  size: textSize,
                  color: INK,
                });
                setNote(undefined);
              }
            }}
          >
            Add note
          </SurfaceButton>
        </div>
      ) : null}
      {upload ? (
        <div className="flex gap-2">
          <SurfaceButton
            size="sm"
            variant="plain"
            disabled={!drawing || items.length === 0}
            onClick={undo}
          >
            Undo
          </SurfaceButton>
          <SurfaceButton
            size="sm"
            variant="plain"
            disabled={!drawing || items.length === 0}
            onClick={clear}
          >
            Clear
          </SurfaceButton>
          <SurfaceButton
            size="sm"
            disabled={!drawing || items.length === 0}
            onClick={() => void done()}
          >
            {busy ? "Saving…" : "Done"}
          </SurfaceButton>
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

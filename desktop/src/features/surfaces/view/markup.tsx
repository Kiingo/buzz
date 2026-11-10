// Generated from the Kiingo surface renderer packages at 23394ec833a81a2fb1d9cfb5c0a7fcc34cd1b948; do not edit here.
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  COMPARE_STEP,
  compareModelOf,
  proxiedMediaUrl,
  sniffRasterType,
  type CompareSide,
} from "../core";
import { cn } from "./cn";
import { useNodeContext, type NodeProps } from "./context";
import { FileRow } from "./display";
import { fetchMedia, MAX_IMAGE_BYTES } from "./host";
import { Glyphs } from "./icons";
import { QuotedText, SurfaceButton } from "./ui";

// Compare (GENUI-MARKUP, 2026-11-05): a before and an after picture on one
// divider. A proxied URL loads as Image does (no credentials, a checked
// raster type); a Kiingo file only through the host's `readFileImage`
// (the viewer's own session behind the scan gate). Either way the picture
// draws only when its first bytes are png, jpeg, gif or webp, as an <img>
// from a blob: URL. The Swift `UiCompareView` is the reference.

/** While a file is being scanned, ask again this often (contract §4: "every few seconds"). */
const CHECK_AGAIN_MS = 5_000;

export type Picture =
  | { kind: "loading" }
  | { kind: "image"; src: string }
  | { kind: "checking" }
  | { kind: "closed"; message: string }
  /** No picture: the side shows its file row or its alt text. */
  | { kind: "none"; message?: string };

/** The blob, re-typed from its own first bytes, or undefined when it isn't a raster image. */
const rasterBlob = async (blob: Blob): Promise<Blob | undefined> => {
  if (blob.size > MAX_IMAGE_BYTES * 4) {
    // A page or a photo the host already checked; still bounded so a wrong
    // answer can't fill memory (4x the proxy's 10 MB image cap).
    return undefined;
  }
  const type = sniffRasterType(
    new Uint8Array(await blob.slice(0, 16).arrayBuffer()),
  );
  return type ? new Blob([blob], { type }) : undefined;
};

export const usePicture = (side: CompareSide): Picture => {
  const context = useNodeContext();
  const host = context.host;
  const controller = context.controller;
  const surfaceId = context.surface.id;
  const agentId = side.agentId ?? context.surface.agentId;
  const proxied = side.url
    ? proxiedMediaUrl(side.url, host.apiOrigin)
    : undefined;
  const readFileImage = host.readFileImage;
  // The loader, not the host object: a host rebuilt on the app's re-render
  // must not reload the picture (CHAT-SCROLL-PERF).
  const loadMedia = host.loadMedia;
  const [picture, setPicture] = useState<Picture>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const show = async (blob: Blob) => {
      const checked = await rasterBlob(blob);
      if (cancelled) {
        return;
      }
      if (!checked) {
        setPicture({ kind: "none", message: "This isn’t a picture." });
        return;
      }
      objectUrl = URL.createObjectURL(checked);
      setPicture({ kind: "image", src: objectUrl });
    };
    if (proxied) {
      setPicture({ kind: "loading" });
      void (loadMedia ?? fetchMedia)(proxied).then((answer) => {
        if (cancelled) {
          return;
        }
        if (answer.kind === "image") {
          void show(answer.blob);
        } else {
          if (answer.kind === "expired") {
            void controller.refreshForExpiredMedia();
          }
          setPicture({ kind: "none" });
        }
      });
    } else if (side.fileId && readFileImage) {
      if (attempt === 0) {
        setPicture({ kind: "loading" });
      }
      readFileImage(
        {
          fileId: side.fileId,
          ...(agentId ? { agentId } : {}),
          ...(side.contentType ? { contentType: side.contentType } : {}),
          page: side.page,
          ...(side.version ? { version: side.version } : {}),
          surfaceId,
        },
        abort.signal,
      )
        .then((answer) => {
          if (cancelled) {
            return;
          }
          if (answer.kind === "image") {
            void show(answer.blob);
          } else if (answer.kind === "checking") {
            setPicture({ kind: "checking" });
            timer = setTimeout(
              () => setAttempt((at) => at + 1),
              CHECK_AGAIN_MS,
            );
          } else if (answer.kind === "closed") {
            setPicture({ kind: "closed", message: answer.message });
          } else if (answer.kind === "missing") {
            setPicture({
              kind: "none",
              message: "This file isn’t there, or isn’t yours to open.",
            });
          } else {
            setPicture({
              kind: "none",
              ...(answer.message ? { message: answer.message } : {}),
            });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setPicture({
              kind: "none",
              message: "The picture didn’t load. Try again later.",
            });
          }
        });
    } else {
      setPicture({ kind: "none" });
    }
    return () => {
      cancelled = true;
      abort.abort();
      if (timer) {
        clearTimeout(timer);
      }
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
    // The controller is stable per surface; a re-signed URL reloads.
  }, [
    proxied,
    side.fileId,
    side.page,
    side.version,
    side.contentType,
    agentId,
    surfaceId,
    readFileImage,
    loadMedia,
    controller,
    attempt,
  ]);
  return picture;
};

const SideLabel = ({
  text,
  outside,
  className,
}: {
  text: string;
  outside: boolean;
  className?: string;
}) => (
  <span
    className={cn(
      "pointer-events-none rounded bg-background/85 px-1.5 py-0.5 text-2xs font-medium text-foreground shadow-sm",
      className,
    )}
  >
    {outside ? <QuotedText text={text} /> : text}
  </span>
);

/** One side drawn alone: its picture, or why there isn't one. */
const SidePanel = ({
  side,
  picture,
  outside,
}: {
  side: CompareSide;
  picture: Picture;
  outside: boolean;
}) => {
  const body =
    picture.kind === "image" ? (
      <img
        src={picture.src}
        alt={side.alt}
        draggable={false}
        referrerPolicy="no-referrer"
        className="block max-h-80 w-full rounded-md bg-muted object-contain"
      />
    ) : (
      <div className="flex min-h-[5rem] flex-col justify-center gap-1.5 rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
        {side.fileId ? (
          <FileRow
            item={{
              artifactId: side.fileId,
              name: side.name ?? side.label,
              ...(side.contentType ? { contentType: side.contentType } : {}),
            }}
            outside={outside}
          />
        ) : (
          <span className="flex items-center gap-2">
            <Glyphs.image aria-hidden className="h-4 w-4 shrink-0" />
            {outside ? <QuotedText text={side.alt} /> : <span>{side.alt}</span>}
          </span>
        )}
        <span role="status">
          {picture.kind === "loading"
            ? "Loading…"
            : picture.kind === "checking"
              ? "Checking…"
              : picture.kind === "closed"
                ? picture.message
                : (picture.message ?? "")}
        </span>
      </div>
    );
  return (
    <figure className="flex min-w-0 flex-col gap-1">
      <figcaption className="text-xs font-medium">
        {outside ? <QuotedText text={side.label} /> : side.label}
      </figcaption>
      {body}
    </figure>
  );
};

const Slider = ({
  before,
  after,
  beforeSrc,
  afterSrc,
  vertical,
  start,
  outside,
}: {
  before: CompareSide;
  after: CompareSide;
  beforeSrc: string;
  afterSrc: string;
  vertical: boolean;
  start: number;
  outside: { before: boolean; after: boolean };
}) => {
  const [position, setPosition] = useState(start);
  const [aspect, setAspect] = useState<number | undefined>(undefined);
  const [focused, setFocused] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | undefined>(undefined);
  // The agent moving the start moves it; the viewer's own drag stays.
  useEffect(() => {
    setPosition(start);
  }, [start]);

  const moveTo = (event: PointerEvent<HTMLDivElement>) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const fraction = vertical
      ? (event.clientY - rect.top) / rect.height
      : (event.clientX - rect.left) / rect.width;
    setPosition(Math.min(100, Math.max(0, fraction * 100)));
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Home") {
      event.preventDefault();
      setPosition(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setPosition(100);
    }
  };
  const clip = vertical
    ? `inset(${position}% 0 0 0)`
    : `inset(0 0 0 ${position}%)`;
  const spoken = `${Math.round(position)}% ${before.label}, ${Math.round(100 - position)}% ${after.label}`;
  return (
    <div
      ref={box}
      className={cn(
        "relative w-full touch-none select-none overflow-hidden rounded-md bg-muted",
        vertical ? "cursor-row-resize" : "cursor-col-resize",
      )}
      style={{ aspectRatio: String(aspect ?? 4 / 3) }}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = event.pointerId;
        moveTo(event);
      }}
      onPointerMove={(event) => {
        if (dragging.current === event.pointerId) {
          moveTo(event);
        }
      }}
      onPointerUp={(event) => {
        if (dragging.current === event.pointerId) {
          dragging.current = undefined;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={() => {
        dragging.current = undefined;
      }}
    >
      <img
        src={beforeSrc}
        alt={before.alt}
        draggable={false}
        referrerPolicy="no-referrer"
        onLoad={(event) => {
          const image = event.currentTarget;
          if (image.naturalWidth > 0 && image.naturalHeight > 0) {
            setAspect(image.naturalWidth / image.naturalHeight);
          }
        }}
        className="absolute inset-0 h-full w-full object-contain"
      />
      <img
        src={afterSrc}
        alt={after.alt}
        draggable={false}
        referrerPolicy="no-referrer"
        className="absolute inset-0 h-full w-full object-contain"
        style={{ clipPath: clip }}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute bg-background ring-1 ring-border",
          vertical ? "inset-x-0 h-0.5" : "inset-y-0 w-0.5",
        )}
        style={
          vertical
            ? { top: `${position}%`, transform: "translateY(-50%)" }
            : { left: `${position}%`, transform: "translateX(-50%)" }
        }
      >
        <span
          className={cn(
            "absolute left-1/2 top-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-xs text-foreground shadow",
            focused ? "ring-2 ring-ring" : "",
          )}
        >
          {vertical ? "↕" : "↔"}
        </span>
      </div>
      <SideLabel
        text={before.label}
        outside={outside.before}
        className="absolute left-1.5 top-1.5"
      />
      <SideLabel
        text={after.label}
        outside={outside.after}
        className={cn(
          "absolute",
          vertical ? "bottom-1.5 left-1.5" : "right-1.5 top-1.5",
        )}
      />
      <input
        type="range"
        min={0}
        max={100}
        step={COMPARE_STEP}
        value={Math.round(position)}
        aria-label="Before and after"
        aria-valuetext={spoken}
        aria-orientation={vertical ? "vertical" : "horizontal"}
        onChange={(event) => setPosition(Number(event.target.value))}
        onKeyDown={onKey}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="sr-only"
      />
    </div>
  );
};

export const CompareView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const model = compareModelOf(
    context.value(component, "before", scope),
    context.value(component, "after", scope),
    component.props.mode,
    component.props.orientation,
    context.value(component, "initialPosition", scope),
  );
  const empty: CompareSide = { page: 1, label: "", alt: "" };
  const before = usePicture(model?.before ?? empty);
  const after = usePicture(model?.after ?? empty);
  const [showingAfter, setShowingAfter] = useState(false);
  if (!model) {
    return <p className="text-xs text-muted-foreground">Nothing to compare.</p>;
  }
  const outside = {
    before: context.isUntrusted(component, "before", scope),
    after: context.isUntrusted(component, "after", scope),
  };
  const caption = context.text(component, "caption", scope, 300);
  const captionOutside = context.isUntrusted(component, "caption", scope);
  const bothDrawn = before.kind === "image" && after.kind === "image";
  let body;
  if (model.mode === "slider" && bothDrawn) {
    body = (
      <Slider
        before={model.before}
        after={model.after}
        beforeSrc={before.src}
        afterSrc={after.src}
        vertical={model.vertical}
        start={model.position}
        outside={outside}
      />
    );
  } else if (model.mode === "toggle" && bothDrawn) {
    const side = showingAfter ? model.after : model.before;
    body = (
      <div className="flex flex-col gap-1.5">
        <SidePanel
          side={side}
          picture={showingAfter ? after : before}
          outside={showingAfter ? outside.after : outside.before}
        />
        <SurfaceButton
          size="sm"
          onClick={() => setShowingAfter((at) => !at)}
          aria-label={`Showing ${side.label}. Show ${showingAfter ? model.before.label : model.after.label}`}
        >
          Show {showingAfter ? model.before.label : model.after.label}
        </SurfaceButton>
      </div>
    );
  } else {
    // Side by side, or a side that can't draw: each on its own.
    body = (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <SidePanel
          side={model.before}
          picture={before}
          outside={outside.before}
        />
        <SidePanel side={model.after} picture={after} outside={outside.after} />
      </div>
    );
  }
  return (
    <figure className="flex flex-col gap-1.5">
      {body}
      {caption ? (
        <figcaption className="text-xs text-muted-foreground">
          {captionOutside ? <QuotedText text={caption} /> : caption}
        </figcaption>
      ) : null}
    </figure>
  );
};

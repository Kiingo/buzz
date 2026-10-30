// Generated from the Kiingo surface renderer packages at 7bc569bf4968cc5b06bdc6a9ea3b371d7d21efc7; do not edit here.
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { asNumber, isObject, plainText, type JsonValue } from "../core";
import { cn } from "./cn";
import { useNodeContext } from "./context";
import { FileRow } from "./display";
import { aria, type FieldProps } from "./field";
import type { UploadTarget } from "./host";
import { Glyphs } from "./icons";
import { SurfaceButton } from "./ui";
import { fileRefOf } from "./uploads";

// Capture inputs (GU-B): SignaturePad, PhotoCapture, VoiceNote. Each
// uploads only on the viewer's own Done / Use photo / Keep, through
// `SurfaceHost.uploadFile` (the viewer's chat attachment upload), never on
// render or for an agent. A host without uploads shows the value and where
// to capture instead. The Swift kit is the reference for wording.

const useTarget = (): UploadTarget => {
  const { controller } = useNodeContext();
  return {
    surfaceId: controller.id,
    ...(controller.surface.agentId
      ? { agentId: controller.surface.agentId }
      : {}),
  };
};

const Problem = ({ text }: { text: string | undefined }) =>
  text ? (
    <p role="status" className="text-xs text-destructive">
      {text}
    </p>
  ) : null;

// --- SignaturePad -----------------------------------------------------------------

const PAD_WIDTH = 600;
const PAD_HEIGHT = 200;
type Point = { x: number; y: number };

/** Draws the strokes (or a typed name) dark on white, as the PNG is saved. */
const paint = (
  canvas: HTMLCanvasElement,
  strokes: readonly Point[][],
  typed: string,
) => {
  const ink = canvas.getContext("2d");
  if (!ink) {
    return;
  }
  ink.fillStyle = "#FFFFFF";
  ink.fillRect(0, 0, PAD_WIDTH, PAD_HEIGHT);
  ink.strokeStyle = "#111111";
  ink.fillStyle = "#111111";
  ink.lineWidth = 3;
  ink.lineCap = "round";
  ink.lineJoin = "round";
  for (const stroke of strokes) {
    ink.beginPath();
    stroke.forEach((point, index) => {
      if (index === 0) {
        ink.moveTo(point.x, point.y);
      } else {
        ink.lineTo(point.x, point.y);
      }
    });
    if (stroke.length === 1) {
      ink.lineTo(stroke[0]!.x + 0.1, stroke[0]!.y);
    }
    ink.stroke();
  }
  if (strokes.length === 0 && typed) {
    ink.font = 'italic 48px "Snell Roundhand", "Segoe Script", cursive';
    ink.textBaseline = "middle";
    ink.fillText(typed, 24, PAD_HEIGHT / 2, PAD_WIDTH - 48);
  }
};

export const SignatureInput = (props: FieldProps) => {
  const context = useNodeContext();
  const target = useTarget();
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const [inked, setInked] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const raw = context.read(props.pointer);
  const saved = isObject(raw) ? raw : undefined;
  const signer = context.text(props.component, "signerName", props.scope, 120);
  const upload = context.host.uploadFile;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `inked` is the trigger: repaint after Clear and the first stroke.
  useEffect(() => {
    if (canvas.current) {
      paint(canvas.current, strokes.current, typed);
    }
  }, [typed, inked]);

  if (!upload) {
    return (
      <div className="flex flex-col gap-1">
        {saved ? <FileRow item={saved} outside={false} /> : null}
        <p className="text-xs text-muted-foreground">Sign in the Kiingo app.</p>
      </div>
    );
  }

  const at = (event: PointerEvent<HTMLCanvasElement>): Point => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * PAD_WIDTH,
      y: ((event.clientY - box.top) / box.height) * PAD_HEIGHT,
    };
  };
  const clear = () => {
    strokes.current = [];
    setTyped("");
    setInked(false);
    setProblem(undefined);
    if (canvas.current) {
      paint(canvas.current, [], "");
    }
  };
  const done = () => {
    const element = canvas.current;
    if (!element || (!inked && !typed.trim())) {
      return;
    }
    paint(element, strokes.current, typed.trim());
    setBusy(true);
    setProblem(undefined);
    element.toBlob((blob) => {
      if (!blob) {
        setBusy(false);
        setProblem("Couldn’t save the signature. Try again.");
        return;
      }
      void upload(blob, "signature.png", target)
        .then((answer) => {
          if (answer.kind === "uploaded") {
            context.edit(props.pointer, fileRefOf(answer.file));
            clear();
          } else {
            setProblem(answer.message);
          }
        })
        .catch(() => setProblem("The signature didn’t upload. Try again."))
        .finally(() => setBusy(false));
    }, "image/png");
  };

  return (
    <div className="flex flex-col gap-1.5" {...aria(props)}>
      {saved ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Glyphs.success aria-hidden className="h-3.5 w-3.5" />
          <span>Signed</span>
          <div className="min-w-0 flex-1">
            <FileRow item={saved} outside={false} />
          </div>
        </div>
      ) : null}
      <canvas
        ref={canvas}
        width={PAD_WIDTH}
        height={PAD_HEIGHT}
        role="img"
        aria-label={
          inked
            ? "Signature drawn. Press Done to attach it, or Clear."
            : "Signature pad. Draw with a pen, finger or mouse, or type your name below."
        }
        className={cn(
          "h-32 w-full touch-none rounded-md border border-input bg-white",
          props.disabled ? "opacity-50" : "cursor-crosshair",
        )}
        onPointerDown={(event) => {
          if (props.disabled || busy) {
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          strokes.current = [...strokes.current, [at(event)]];
          setTyped("");
          setInked(true);
        }}
        onPointerMove={(event) => {
          const stroke = strokes.current[strokes.current.length - 1];
          if (
            !stroke ||
            !event.currentTarget.hasPointerCapture(event.pointerId)
          ) {
            return;
          }
          stroke.push(at(event));
          if (stroke.length < 2000 && canvas.current) {
            paint(canvas.current, strokes.current, "");
          }
        }}
        onPointerUp={(event) =>
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      />
      <div className="flex items-center justify-between gap-2 border-t border-border pt-1 text-xs text-muted-foreground">
        <span>{signer ?? ""}</span>
        <input
          type="text"
          value={typed}
          maxLength={80}
          disabled={props.disabled || busy || inked}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="Or type your name"
          aria-label="Type your name to sign"
          className="h-7 w-44 rounded border border-input bg-background px-2 text-xs"
        />
      </div>
      <div className="flex gap-2">
        <SurfaceButton
          size="sm"
          variant="plain"
          disabled={props.disabled || busy || (!inked && !typed)}
          onClick={clear}
        >
          Clear
        </SurfaceButton>
        <SurfaceButton
          size="sm"
          disabled={props.disabled || busy || (!inked && !typed.trim())}
          onClick={done}
        >
          {busy ? "Saving…" : "Done"}
        </SurfaceButton>
      </div>
      <Problem text={problem} />
    </div>
  );
};

// --- PhotoCapture -----------------------------------------------------------------

const LONG_EDGE = 2048;
const PHOTO_MAX_BYTES = 10_000_000;

/** JPEG, long edge ≤ 2048 px, orientation applied, no metadata (CallPhotoEncoder). */
export const encodePhoto = async (file: Blob): Promise<Blob | undefined> => {
  if (typeof createImageBitmap !== "function") {
    return undefined;
  }
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  const scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ink = canvas.getContext("2d");
  if (!ink) {
    bitmap.close();
    return undefined;
  }
  ink.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  for (const quality of [0.8, 0.65, 0.5]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (blob && blob.size <= PHOTO_MAX_BYTES) {
      return blob;
    }
  }
  return undefined;
};

export const PhotoInput = (props: FieldProps) => {
  const context = useNodeContext();
  const target = useTarget();
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const raw = context.read(props.pointer);
  const photos: JsonValue[] = Array.isArray(raw) ? raw : [];
  const max = Math.max(
    1,
    Math.min(10, Math.round(asNumber(props.component.props.maxPhotos) ?? 1)),
  );
  const listed = context
    .list(props.component, "sources", props.scope)
    .filter((item): item is string => typeof item === "string");
  const sources = listed.length ? listed : ["camera", "library"];
  const upload = context.host.uploadFile;

  const take = async (files: File[]) => {
    if (!upload) {
      return;
    }
    setBusy(true);
    setProblem(undefined);
    const room = max === 1 ? 1 : max - photos.length;
    const refs: JsonValue[] = [];
    for (const [index, file] of files.slice(0, room).entries()) {
      try {
        const jpeg = await encodePhoto(file);
        if (!jpeg) {
          setProblem("That photo couldn’t be read.");
          continue;
        }
        const answer = await upload(jpeg, `photo-${index + 1}.jpg`, target);
        if (answer.kind === "uploaded") {
          refs.push(fileRefOf(answer.file));
        } else {
          setProblem(answer.message);
        }
      } catch {
        setProblem("The photo didn’t upload. Try again.");
      }
    }
    if (refs.length) {
      context.edit(
        props.pointer,
        max === 1 ? refs.slice(0, 1) : [...photos, ...refs].slice(0, max),
      );
    }
    setBusy(false);
  };

  const chooser = (ref: typeof camera, capture: boolean) => (
    <input
      ref={ref}
      type="file"
      accept="image/*"
      hidden
      tabIndex={-1}
      aria-hidden
      multiple={!capture && max > 1}
      {...(capture ? { capture: "environment" as const } : {})}
      onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (files.length) {
          void take(files);
        }
      }}
    />
  );
  const full = max > 1 && photos.length >= max;

  return (
    <div className="flex flex-col gap-1.5" {...aria(props)}>
      {photos.map((item, index) => (
        <div key={index} className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <FileRow item={item} outside={false} />
          </div>
          <SurfaceButton
            size="sm"
            variant="plain"
            disabled={props.disabled || busy}
            onClick={() =>
              context.edit(
                props.pointer,
                photos.filter((_, other) => other !== index),
              )
            }
          >
            Remove
          </SurfaceButton>
        </div>
      ))}
      {upload ? (
        <div className="flex flex-wrap gap-2">
          {sources.includes("camera") ? chooser(camera, true) : null}
          {sources.includes("library") ? chooser(library, false) : null}
          {sources.includes("camera") ? (
            <SurfaceButton
              size="sm"
              disabled={props.disabled || busy || full}
              onClick={() => camera.current?.click()}
            >
              <Glyphs.image aria-hidden className="h-4 w-4" />
              {busy ? "Attaching…" : "Take photo"}
            </SurfaceButton>
          ) : null}
          {sources.includes("library") ? (
            <SurfaceButton
              size="sm"
              variant="secondary"
              disabled={props.disabled || busy || full}
              onClick={() => library.current?.click()}
            >
              Choose photo
            </SurfaceButton>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Add a photo in the Kiingo app.
        </p>
      )}
      <Problem text={problem} />
    </div>
  );
};

// --- VoiceNote --------------------------------------------------------------------

/** A VoiceNote value: the voice note id and its transcript (null: no speech). */
export const voiceNoteOf = (
  value: unknown,
):
  | { voiceNoteId: string; transcript: string | null; durationMs?: number }
  | undefined => {
  if (!isObject(value) || typeof value.voiceNoteId !== "string") {
    return undefined;
  }
  const durationMs = asNumber(value.durationMs);
  return {
    voiceNoteId: value.voiceNoteId,
    transcript: plainText(value.transcript, 20_000, true) ?? null,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
};

/**
 * Records in the Kiingo app only: the web has no voice-note upload host yet,
 * so the page shows the transcript the person kept there.
 */
export const VoiceNoteInput = (props: FieldProps) => {
  const context = useNodeContext();
  const note = voiceNoteOf(context.read(props.pointer));
  return (
    <div className="flex flex-col gap-1" {...aria(props)}>
      {note ? (
        <p className="whitespace-pre-wrap text-sm">
          {note.transcript ?? "No speech was heard in the recording."}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">Record in the Kiingo app.</p>
    </div>
  );
};

// Generated from the Kiingo surface renderer packages at 0d7eecf6d3b78f4c52514554faa33adb7a1fe131; do not edit here.
import { useRef, useState } from "react";
import { formatBytes, type JsonValue } from "../core";
import { useNodeContext } from "./context";
import type { UploadedFile, UploadTarget } from "./host";
import { Glyphs } from "./icons";
import { SurfaceButton } from "./ui";

// FileInput's device source (GU-B, 2026-10-29). Three hosts: one that picks
// and uploads itself (`pickFiles`, the native apps), one that uploads what
// the page's own file chooser picked (`uploadFile`, the dashboard), and one
// with neither, which says where to do it. An upload starts only from the
// viewer's choice in the chooser, never on render or for an agent.

/** The chat attachment upload's own cap (AGENT_CHAT_ATTACHMENT_MAX_BYTES). */
export const UPLOAD_MAX_BYTES = 20_000_000;

/** A FileInput value entry from an uploaded file. */
export const fileRefOf = (file: UploadedFile): JsonValue => ({
  artifactId: file.id,
  name: file.name || "File",
  ...(file.size !== undefined ? { size: file.size } : {}),
  ...(file.type ? { contentType: file.type } : {}),
});

/** Whether `type` is one of `accept` (exact, or `image/*` style). */
export const acceptsType = (accept: readonly string[], type: string) =>
  accept.length === 0 ||
  accept.some((pattern) => {
    const want = pattern.trim().toLowerCase();
    const have = type.trim().toLowerCase();
    return want.endsWith("/*")
      ? have.startsWith(want.slice(0, -1))
      : want === have;
  });

export const DeviceFiles = ({
  target,
  multiple,
  room,
  accept,
  maxBytes,
  disabled,
  onAdd,
}: {
  target: UploadTarget;
  multiple: boolean;
  /** How many more files fit. */
  room: number;
  accept: readonly string[];
  maxBytes: number | undefined;
  disabled: boolean;
  onAdd: (refs: JsonValue[]) => void;
}) => {
  const context = useNodeContext();
  const chooser = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const { pickFiles, uploadFile } = context.host;
  const cap = Math.min(UPLOAD_MAX_BYTES, maxBytes ?? UPLOAD_MAX_BYTES);
  const full = room <= 0;

  if (!pickFiles && !uploadFile) {
    return (
      <p className="text-xs text-muted-foreground">
        Attach files from this device in the Kiingo app.
      </p>
    );
  }

  const upload = async (files: File[]) => {
    if (!uploadFile) {
      return;
    }
    setBusy(true);
    const notes: string[] = [];
    const refs: JsonValue[] = [];
    if (files.length > room) {
      notes.push(
        `Only ${room} more ${room === 1 ? "file fits" : "files fit"}; the rest weren’t attached.`,
      );
    }
    for (const file of files.slice(0, room)) {
      const name = file.name || "File";
      if (!acceptsType(accept, file.type)) {
        notes.push(`${name} isn’t a kind of file this asks for.`);
        continue;
      }
      if (file.size === 0) {
        notes.push(`${name} is empty.`);
        continue;
      }
      if (file.size > cap) {
        notes.push(`${name} is over ${formatBytes(cap)}.`);
        continue;
      }
      try {
        const answer = await uploadFile(file, name, target);
        if (answer.kind === "uploaded") {
          refs.push(fileRefOf(answer.file));
        } else {
          notes.push(`${name}: ${answer.message}`);
        }
      } catch {
        notes.push(`${name} didn’t upload. Try again.`);
      }
    }
    if (refs.length) {
      onAdd(refs);
    }
    setProblems(notes);
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-1">
      {uploadFile && !pickFiles ? (
        <input
          ref={chooser}
          type="file"
          hidden
          tabIndex={-1}
          aria-hidden
          multiple={multiple}
          {...(accept.length ? { accept: accept.join(",") } : {})}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            // Let the same file be chosen again after a refusal.
            event.target.value = "";
            if (files.length) {
              void upload(files);
            }
          }}
        />
      ) : null}
      <SurfaceButton
        size="sm"
        className="self-start"
        disabled={disabled || busy || full}
        onClick={() => {
          setProblems([]);
          if (pickFiles) {
            setBusy(true);
            void pickFiles(multiple, target)
              .then((uploaded) => {
                const refs = uploaded.slice(0, room).map(fileRefOf);
                if (refs.length) {
                  onAdd(refs);
                }
              })
              .finally(() => setBusy(false));
          } else {
            chooser.current?.click();
          }
        }}
      >
        <Glyphs.attach aria-hidden className="h-4 w-4" />
        {busy ? "Attaching…" : "Attach files"}
      </SurfaceButton>
      {problems.length ? (
        <ul role="status" className="text-xs text-destructive">
          {problems.map((problem, index) => (
            <li key={index}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};

// Generated from the Kiingo surface renderer packages at 9bead1b8e2a179fc0d6d93a384d86d28e66ddf51; do not edit here.
import { useEffect, useState, type ReactNode } from "react";
import {
  canFormatTextFile,
  readTextFileBytes,
  textFileDigest,
  TEXT_FILE_DIGEST_UNREADABLE,
  TEXT_FILE_FAILED_MESSAGE,
  TEXT_FILE_MAX_BYTES,
  TEXT_FILE_MISSING_MESSAGE,
  TEXT_FILE_TOO_LARGE_MESSAGE,
  type TextFileRef,
} from "../core";
import { useNodeContext } from "./context";
import { CopyButton } from "./copy";
import { MarkdownText } from "./markdown";
import { SurfaceButton, SurfaceDialog } from "./ui";

// The text and Markdown file viewer (fd, 2026-10-30; surface-core
// `text-file.ts`, Swift `UiTextFileSheet`): a FileList row whose file is
// text or Markdown opens a sheet that reads it through the host's
// `readTextFile` (the viewer's own session; never a URL) only when the
// person opens it. Plain text by default; "Formatted" draws Markdown
// through the safe subset (no images, no HTML) with links going through
// the surface's link check, outside hosts confirmed first.

type Loaded =
  | { kind: "loading" }
  | { kind: "ready"; text: string }
  | { kind: "failed"; message: string };

export const TextFileRow = ({
  file,
  children,
}: {
  file: TextFileRef;
  children: ReactNode;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-w-0 text-left hover:opacity-80"
        aria-label={`Read ${file.name}`}
      >
        {children}
      </button>
      {open ? (
        <TextFileDialog file={file} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
};

const TextFileDialog = ({
  file,
  onClose,
}: {
  file: TextFileRef;
  onClose: () => void;
}) => {
  const context = useNodeContext();
  const read = context.host.readTextFile;
  const digest = textFileDigest(context.data, file.fileId);
  // A bodyFile naming this file with an unreadable digest refuses (79 LOW).
  const unreadable = digest === TEXT_FILE_DIGEST_UNREADABLE;
  const sha256 = typeof digest === "object" ? digest.sha256 : undefined;
  const sizeBytes = typeof digest === "object" ? digest.sizeBytes : undefined;
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [formatted, setFormatted] = useState(false);

  useEffect(() => {
    if (!read) {
      return undefined;
    }
    const abort = new AbortController();
    setLoaded({ kind: "loading" });
    const fail = (message: string) => {
      if (!abort.signal.aborted) {
        setLoaded({ kind: "failed", message });
      }
    };
    read(file.fileId, abort.signal, TEXT_FILE_MAX_BYTES)
      .then(async (answer) => {
        if (answer.kind === "missing") {
          fail(TEXT_FILE_MISSING_MESSAGE);
          return;
        }
        if (answer.kind !== "file") {
          fail(answer.message ?? TEXT_FILE_FAILED_MESSAGE);
          return;
        }
        if (answer.blob.size > TEXT_FILE_MAX_BYTES) {
          fail(TEXT_FILE_TOO_LARGE_MESSAGE);
          return;
        }
        const bytes = new Uint8Array(await answer.blob.arrayBuffer());
        const reading = await readTextFileBytes(
          bytes,
          unreadable
            ? TEXT_FILE_DIGEST_UNREADABLE
            : sha256 && sizeBytes
              ? { sha256, sizeBytes }
              : undefined,
        );
        if (abort.signal.aborted) {
          return;
        }
        setLoaded(
          reading.kind === "text"
            ? { kind: "ready", text: reading.text }
            : { kind: "failed", message: reading.message },
        );
      })
      .catch(() => fail(TEXT_FILE_FAILED_MESSAGE));
    return () => abort.abort();
  }, [read, file.fileId, sha256, sizeBytes, unreadable]);

  const text = loaded.kind === "ready" ? loaded.text : undefined;
  const canFormat = text !== undefined && canFormatTextFile(file, text);
  const showFormatted = formatted && canFormat;
  return (
    <SurfaceDialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      title={file.name}
      description="The file's text, read with your own sign-in."
      wide
      footer={
        text !== undefined ? (
          <>
            {file.markdown ? (
              <div
                role="group"
                aria-label="Show as"
                className="mr-auto flex items-center gap-1"
              >
                <SurfaceButton
                  size="sm"
                  variant={showFormatted ? "secondary" : "primary"}
                  aria-pressed={!showFormatted}
                  onClick={() => setFormatted(false)}
                >
                  Plain
                </SurfaceButton>
                <SurfaceButton
                  size="sm"
                  variant={showFormatted ? "primary" : "secondary"}
                  aria-pressed={showFormatted}
                  disabled={!canFormat}
                  title={
                    canFormat
                      ? undefined
                      : "Too long to format; shown as plain text."
                  }
                  onClick={() => setFormatted(true)}
                >
                  Formatted
                </SurfaceButton>
              </div>
            ) : null}
            <CopyButton text={text} what="text" />
          </>
        ) : undefined
      }
    >
      {loaded.kind === "loading" ? (
        <p className="text-sm text-muted-foreground">Loading the file…</p>
      ) : loaded.kind === "failed" ? (
        <p className="text-sm text-muted-foreground">{loaded.message}</p>
      ) : showFormatted ? (
        <MarkdownText text={loaded.text} onLink={context.openLink} />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
          {loaded.text}
        </pre>
      )}
    </SurfaceDialog>
  );
};

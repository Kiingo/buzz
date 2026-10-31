// Generated from the Kiingo surface renderer packages at 5736645688767c7e713cc125961539139af6ba91; do not edit here.
import { useEffect, useState } from "react";
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_NOT_PDF_MESSAGE,
  DOCUMENT_TOO_LARGE_MESSAGE,
  documentModel,
  highlightLabel,
  highlightsCopyText,
  isDocumentFileId,
  isPdfBytes,
} from "../core";
import { cn } from "./cn";
import { useNodeContext, type NodeProps } from "./context";
import { CopyButton } from "./copy";
import { SurfaceButton } from "./ui";

// DocumentViewer (GU-B, 2026-10-29): a PDF from a Kiingo file the viewer
// may read, read through the host's `readFile` (the viewer's own session;
// never a URL from the spec). Only bytes that are a PDF are drawn, and
// they are drawn as `application/pdf` whatever the file says it is, in the
// browser's own PDF viewer: framed without a sandbox, as the dashboard's
// blob-frame rule (preview-policy.ts), since Chromium's viewer won't render
// sandboxed and never runs page script. The page is the agent's to set (`page`) and
// the viewer's to change on their screen; highlights jump to their page.

const HEIGHTS: Record<string, string> = {
  sm: "h-64",
  md: "h-96",
  lg: "h-[36rem]",
};

type Loaded =
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "failed"; message: string };

export const DocumentView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const model = documentModel(
    context.value(component, "file", scope),
    context.value(component, "page", scope),
    context.value(component, "highlights", scope),
  );
  const readFile = context.host.readFile;
  const fileId = model?.fileId;
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [page, setPage] = useState(model?.page ?? 1);
  const agentPage = model?.page ?? 1;
  // The agent moving the page moves it; the viewer's own paging stays.
  useEffect(() => {
    setPage(agentPage);
  }, [agentPage]);
  useEffect(() => {
    if (!fileId || !readFile) {
      return;
    }
    if (!isDocumentFileId(fileId)) {
      setLoaded({ kind: "failed", message: "This isn’t a Kiingo file." });
      return;
    }
    const abort = new AbortController();
    let url: string | undefined;
    setLoaded({ kind: "loading" });
    readFile(fileId, abort.signal, DOCUMENT_MAX_BYTES)
      .then(async (answer) => {
        if (answer.kind !== "file") {
          setLoaded({
            kind: "failed",
            message:
              answer.kind === "missing"
                ? "This document isn’t there, or isn’t yours to open."
                : (answer.message ??
                  "The document didn’t load. Try again later."),
          });
          return;
        }
        if (answer.blob.size > DOCUMENT_MAX_BYTES) {
          setLoaded({ kind: "failed", message: DOCUMENT_TOO_LARGE_MESSAGE });
          return;
        }
        const head = new Uint8Array(
          await answer.blob.slice(0, 5).arrayBuffer(),
        );
        if (abort.signal.aborted) {
          return;
        }
        if (!isPdfBytes(head)) {
          setLoaded({ kind: "failed", message: DOCUMENT_NOT_PDF_MESSAGE });
          return;
        }
        url = URL.createObjectURL(
          new Blob([answer.blob], { type: "application/pdf" }),
        );
        setLoaded({ kind: "ready", url });
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setLoaded({
            kind: "failed",
            message: "The document didn’t load. Try again later.",
          });
        }
      });
    return () => {
      abort.abort();
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [fileId, readFile]);

  if (!model) {
    return <p className="text-xs text-muted-foreground">No document.</p>;
  }
  const copyText = highlightsCopyText(model.highlights);
  const height =
    HEIGHTS[context.string(component, "height") ?? "md"] ?? HEIGHTS.md;
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate font-medium">{model.name}</span>
        {component.props.copyable === false || !copyText ? null : (
          <CopyButton text={copyText} what="highlights" compact />
        )}
      </figcaption>
      {!readFile ? (
        <p className="text-xs text-muted-foreground">
          Open it in the Kiingo app.
        </p>
      ) : loaded.kind === "ready" ? (
        <>
          <iframe
            key={`${loaded.url}#${page}`}
            src={`${loaded.url}#page=${page}`}
            title={`${model.name}, page ${page}`}
            className={cn("w-full rounded-md border border-border", height)}
          />
          <div className="flex items-center gap-2 text-xs">
            <SurfaceButton
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((at) => Math.max(1, at - 1))}
              aria-label="Previous page"
            >
              ‹
            </SurfaceButton>
            <span aria-live="polite">Page {page}</span>
            <SurfaceButton
              size="sm"
              onClick={() => setPage((at) => Math.min(10_000, at + 1))}
              aria-label="Next page"
            >
              ›
            </SurfaceButton>
          </div>
        </>
      ) : loaded.kind === "failed" ? (
        <p className="text-xs text-muted-foreground">{loaded.message}</p>
      ) : (
        <p className={cn("text-xs text-muted-foreground", height)}>
          Loading the document…
        </p>
      )}
      {model.highlights.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs">
          {model.highlights.map((mark, index) => (
            <li key={`${mark.page}-${index}`}>
              <button
                type="button"
                className="text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setPage(mark.page)}
                disabled={!readFile || loaded.kind !== "ready"}
              >
                <span className="font-medium">{highlightLabel(mark)}</span>
                {mark.text && mark.note ? (
                  <span className="block text-muted-foreground">
                    “{mark.text}”
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </figure>
  );
};

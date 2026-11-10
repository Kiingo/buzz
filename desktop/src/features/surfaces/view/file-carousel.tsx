// Generated from the Kiingo surface renderer packages at 1055d96f74fb6ac27bf0ebcd3c7fa12aee50be9c; do not edit here.
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  IMAGE_MIME_TYPES,
  asNumber,
  fileCheckDelayMs,
  fileKindLabel,
  formatBytes,
  isObject,
  plainId,
  plainText,
  textFileDigest,
  textFileRef,
  type JsonValue,
} from "../core";
import { cn } from "./cn";
import { useNodeContext } from "./context";
import {
  MAX_IMAGE_BYTES,
  type SurfaceFileCard,
  type SurfaceFileRef,
} from "./host";
import { Glyphs } from "./icons";
import { PagedRow } from "./paged";
import { TextFileRow } from "./text-file";

// FileList with `layout: carousel` (GENUI-CAROUSEL, Ross 2026-11-05: "a
// carousel so that an agent could present files or images"): a swipeable
// row of file cards. Each card shows the server's thumbnail when it has one
// (a type icon otherwise), the card's name, the server's type and size, and
// "Checking…" while the scan runs. A tap opens the app's one viewer at that
// file with the others to page through (`host.openFile`). The card is read
// through the host's own session (`host.fileCard`), asked again while it is
// checking and on screen (3 s, then 1.5x up to 30 s), never after a count.
// Outside-content lists never get here: they stay quoted rows.

/** A file row's or card's ref for the host's viewer, or undefined without an id. */
export const surfaceFileRefOf = (
  item: JsonValue | undefined,
): SurfaceFileRef | undefined => {
  if (!isObject(item)) {
    return undefined;
  }
  const fileId = plainId(item.artifactId);
  if (!fileId) {
    return undefined;
  }
  const contentType = plainText(item.contentType, 200);
  const size = asNumber(item.size);
  return {
    fileId,
    name: plainText(item.name, 300) ?? "File",
    ...(contentType ? { contentType } : {}),
    ...(size !== undefined ? { size } : {}),
  };
};

export const FileCarousel = ({ files }: { files: JsonValue[] }) => {
  const refs = files.map((item) => surfaceFileRefOf(item));
  const openable = refs.filter((ref): ref is SurfaceFileRef => !!ref);
  return (
    <PagedRow
      count={files.length}
      label="Files"
      noun="File"
      itemClassName="w-52"
      renderItem={(index) => {
        const ref = refs[index];
        return (
          <FileCard
            item={files[index]!}
            fileRef={ref}
            set={
              ref
                ? { files: openable, index: openable.indexOf(ref) }
                : undefined
            }
          />
        );
      }}
    />
  );
};

const FileCard = ({
  item,
  fileRef,
  set,
}: {
  item: JsonValue;
  fileRef: SurfaceFileRef | undefined;
  set: { files: SurfaceFileRef[]; index: number } | undefined;
}) => {
  const context = useNodeContext();
  const host = context.host;
  const surface = context.surface;
  const element = useRef<HTMLDivElement>(null);
  const record = isObject(item) ? item : {};
  // The ref's own agent (ZUiFileRef.agentId), else the surface's.
  const agentId = plainId(record.agentId) ?? surface.agentId;
  const { card, thumbnail } = useFileCard(fileRef, agentId, element);
  const name = plainText(record.name, 300) ?? "File";
  const type = card?.contentType ?? plainText(record.contentType, 200);
  const kind = fileKindLabel(type);
  const size = card?.size ?? asNumber(record.size);
  const detail = [kind, size !== undefined ? formatBytes(size) : undefined]
    .filter(Boolean)
    .join(" · ");
  const status =
    card?.state === "checking"
      ? "Checking…"
      : card?.state === "closed"
        ? card.sentence
        : card?.state === "missing"
          ? "Can’t find this file."
          : undefined;
  const Icon = kind === "Image" ? Glyphs.image : Glyphs.file;
  const content = (
    <div
      ref={element}
      className="flex w-full flex-col gap-1.5 rounded-lg border bg-muted/30 p-2 text-left"
    >
      <div className="flex h-28 w-full items-center justify-center overflow-hidden rounded-md bg-muted">
        {thumbnail ? (
          <img
            src={thumbnail}
            alt=""
            draggable={false}
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
        ) : (
          <Icon aria-hidden className="h-8 w-8 text-muted-foreground" />
        )}
      </div>
      <span className="line-clamp-2 break-words text-sm">{name}</span>
      {detail ? (
        <span className="text-xs text-muted-foreground">{detail}</span>
      ) : null}
      {status ? (
        <span
          className={cn(
            "text-xs",
            card?.state === "closed"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
          aria-live="polite"
        >
          {status}
        </span>
      ) : null}
    </div>
  );
  // A text or Markdown file opens in the text viewer as a FileList row
  // does: always for a card body the card pins by sha256 (`bodyFile`), else
  // when the host has no viewer.
  const textFile = textFileRef(item);
  const pinnedBody =
    textFile !== undefined &&
    textFileDigest(context.data, textFile.fileId) !== undefined;
  if (textFile && host.readTextFile && (pinnedBody || !host.openFile)) {
    return <TextFileRow file={textFile}>{content}</TextFileRow>;
  }
  if (fileRef && host.openFile) {
    const openSet = set ?? { files: [fileRef], index: 0 };
    return (
      <button
        type="button"
        onClick={() =>
          host.openFile?.({
            files: openSet.files,
            index: openSet.index,
            surfaceId: surface.id,
            ...(surface.agentId ? { agentId: surface.agentId } : {}),
          })
        }
        className="block w-full rounded-lg text-left hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Open ${name}`}
      >
        {content}
      </button>
    );
  }
  if (fileRef && host.openEntity) {
    const entity = { type: "file" as const, id: fileRef.fileId, title: name };
    if (host.canOpenEntity?.(entity) !== false) {
      return (
        <button
          type="button"
          onClick={() => host.openEntity?.(entity)}
          className="block w-full rounded-lg text-left hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open ${name}`}
        >
          {content}
        </button>
      );
    }
  }
  return content;
};

/**
 * The host's read of one card, again while it is checking and on screen.
 * The thumbnail is shown only as a raster image up to `MAX_IMAGE_BYTES`
 * (the proxied image cap), from an object URL revoked when it goes.
 */
const useFileCard = (
  fileRef: SurfaceFileRef | undefined,
  agentId: string | undefined,
  element: RefObject<HTMLDivElement | null>,
) => {
  // The read, not the host object: a host rebuilt on the app's re-render
  // must not restart a card's read (CHAT-SCROLL-PERF).
  const readCard = useNodeContext().host.fileCard;
  const [card, setCard] = useState<SurfaceFileCard | undefined>(undefined);
  const [thumbnail, setThumbnail] = useState<string | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  const settled = useRef(false);
  const shownUrl = useRef<string | undefined>(undefined);
  const fileId = fileRef?.fileId;

  useEffect(() => {
    const node = element.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [element]);

  useEffect(() => {
    settled.current = false;
  }, [fileId]);

  useEffect(() => {
    const read = readCard;
    if (!read || !fileRef || !visible || settled.current) {
      return undefined;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const ask = async () => {
      let answer: SurfaceFileCard;
      try {
        answer = await read(
          agentId ? { ...fileRef, agentId } : fileRef,
          controller.signal,
        );
      } catch {
        answer = { state: "unavailable" };
      }
      if (controller.signal.aborted) {
        return;
      }
      setCard(answer);
      const blob = answer.thumbnail;
      if (
        blob &&
        IMAGE_MIME_TYPES.has(blob.type) &&
        blob.size <= MAX_IMAGE_BYTES
      ) {
        const url = URL.createObjectURL(blob);
        if (shownUrl.current) {
          URL.revokeObjectURL(shownUrl.current);
        }
        shownUrl.current = url;
        setThumbnail(url);
      }
      if (answer.state === "checking") {
        timer = setTimeout(() => void ask(), fileCheckDelayMs(attempt));
        attempt += 1;
      } else {
        settled.current = true;
      }
    };
    void ask();
    return () => {
      controller.abort();
      if (timer) {
        clearTimeout(timer);
      }
    };
    // The ref is rebuilt each render; its id and the agent decide the read.
  }, [readCard, fileId, agentId, visible]);

  useEffect(
    () => () => {
      if (shownUrl.current) {
        URL.revokeObjectURL(shownUrl.current);
        shownUrl.current = undefined;
      }
    },
    [],
  );

  return { card, thumbnail };
};

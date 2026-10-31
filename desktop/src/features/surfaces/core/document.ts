// Generated from the Kiingo surface renderer packages at 5736645688767c7e713cc125961539139af6ba91; do not edit here.
import { isObject } from "./json";
import { plainText } from "./text";

// DocumentViewer (GU-B, 2026-10-29): the shared reading of its props for
// every renderer. The file is a Kiingo file id read through the viewer's own
// session (`GET /api/files/:fileId/content`, the files.get read check);
// never a URL. Swift `UiDocument` matches.

/** At most this many highlights are listed. */
export const DOCUMENT_HIGHLIGHTS_MAX = 50;

/**
 * The largest file a DocumentViewer opens, on every renderer (79
 * SHOULD-GUB-NO-SIZE-CAP; Swift `UiDocument.maxBytes`, the Mac broker's
 * `files.content_read`): a host's readFile stops reading past it.
 */
export const DOCUMENT_MAX_BYTES = 200 * 1024 * 1024;

export const DOCUMENT_TOO_LARGE_MESSAGE =
  "This document is over 200 MB, too large to show here.";
export const DOCUMENT_NOT_PDF_MESSAGE =
  "This file isn’t a PDF, so it can’t be shown here.";

const FILE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `id` is a Kiingo file id a viewer may read: a UUID (the files
 * routes take only those), so never a dot segment or a path (79
 * SHOULD-GUB-FILEID-DOT-SEGMENT). Anything else shows the file row only.
 */
export const isDocumentFileId = (id: string): boolean => FILE_ID.test(id);

export type DocumentHighlight = {
  page: number;
  text?: string;
  note?: string;
};

export type DocumentModel = {
  fileId: string;
  name: string;
  contentType?: string;
  /** The page to open on, from 1. */
  page: number;
  highlights: DocumentHighlight[];
};

const pageOf = (value: unknown): number | undefined =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= 10_000
    ? value
    : undefined;

/** The props as one model; undefined without a readable file ref. */
export const documentModel = (
  file: unknown,
  page: unknown,
  highlights: unknown,
): DocumentModel | undefined => {
  if (!isObject(file)) {
    return undefined;
  }
  const fileId = plainText(file.artifactId, 200);
  if (!fileId) {
    return undefined;
  }
  const contentType = plainText(file.contentType, 200);
  const marks: DocumentHighlight[] = [];
  for (const item of Array.isArray(highlights) ? highlights : []) {
    if (marks.length >= DOCUMENT_HIGHLIGHTS_MAX) {
      break;
    }
    if (!isObject(item)) {
      continue;
    }
    const at = pageOf(item.page);
    if (at === undefined) {
      continue;
    }
    const words = plainText(item.text, 300);
    const note = plainText(item.note, 300);
    marks.push({
      page: at,
      ...(words ? { text: words } : {}),
      ...(note ? { note } : {}),
    });
  }
  return {
    fileId,
    name: plainText(file.name, 300) ?? "Document",
    ...(contentType ? { contentType } : {}),
    page: pageOf(page) ?? 1,
    highlights: marks,
  };
};

/** "Page 4 · Cap is lower than our standard": a highlight's own label. */
export const highlightLabel = (mark: DocumentHighlight): string =>
  [`Page ${mark.page}`, mark.note ?? (mark.text ? `“${mark.text}”` : "")]
    .filter(Boolean)
    .join(" · ");

/** What Copy gives: each highlight's words with its page. */
export const highlightsCopyText = (marks: DocumentHighlight[]): string =>
  marks
    .filter((mark) => mark.text)
    .map((mark) => `p. ${mark.page}: ${mark.text}`)
    .join("\n");

/**
 * Whether `bytes` start with "%PDF-", the dashboard's blob-frame rule
 * (agent-ui preview-policy.ts): the file's own leading bytes, never its
 * stated type. Nothing else is drawn.
 */
export const isPdfBytes = (bytes: Uint8Array): boolean =>
  bytes.length >= 5 &&
  bytes[0] === 0x25 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x44 &&
  bytes[3] === 0x46 &&
  bytes[4] === 0x2d;

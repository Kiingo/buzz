// Generated from the Kiingo surface renderer packages at 9bead1b8e2a179fc0d6d93a384d86d28e66ddf51; do not edit here.
import { isDocumentFileId } from "./document";
import { isObject } from "./json";
import { plainText } from "./text";

// The text and Markdown file viewer (fd, 2026-10-30): a FileList row whose
// file is UTF-8 text or Markdown opens to be read in the card, through the
// viewer's own signed-in read of `GET /api/files/:fileId/content` (the
// files.get read check; no access and missing are both 404). Never a URL,
// never a remote image or script: the text is shown plain by default, and
// "Formatted" draws it through the safe Markdown subset (`parseMarkdown`,
// no images, no HTML), its links opening only through the surface's link
// check (outside hosts confirmed first). Built for an email_draft card's
// long body (79 Q3: `bodyFile`, a requester-private file); the card's
// `bodyFile` names the exact sha256 and size, which the viewer checks
// before it shows a byte. Swift `UiTextFile` matches.

/**
 * The largest text file the viewer reads, on every renderer: the server's
 * largest card body file (`UI_SOURCE_BODY_MAX_BYTES`, 4 MiB). A host's
 * readTextFile stops reading past it.
 */
export const TEXT_FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The longest text "Formatted" draws (the safe Markdown parser's own input
 * cap). Longer text is shown plain only, never cut.
 */
export const TEXT_FILE_FORMATTED_MAX_CHARS = 100_000;

export const TEXT_FILE_TOO_LARGE_MESSAGE =
  "This file is over 4 MB, too large to show here.";
export const TEXT_FILE_NOT_TEXT_MESSAGE =
  "This file isn’t plain text, so it can’t be shown here.";
export const TEXT_FILE_MISSING_MESSAGE =
  "This file isn’t there, or isn’t yours to open.";
export const TEXT_FILE_FAILED_MESSAGE =
  "The file didn’t load. Try again later.";
export const TEXT_FILE_CHANGED_MESSAGE =
  "This isn’t the exact text the card names, so it isn’t shown. Ask your agent to show the draft again.";
export const TEXT_FILE_RESTORING_MESSAGE =
  "This file is being restored. Try again in a few minutes.";

const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown"]);
const TEXT_TYPES = new Set(["text/plain"]);
const MARKDOWN_NAME = /\.(md|markdown)$/i;
const TEXT_NAME = /\.txt$/i;
const SHA256 = /^[0-9a-f]{64}$/;

/** A file a FileList row may open in the text viewer. */
export type TextFileRef = {
  fileId: string;
  name: string;
  /** Markdown (Formatted is offered) or plain text. */
  markdown: boolean;
  /** The size the row states, in bytes, if any. */
  size?: number;
};

const baseType = (value: unknown): string | undefined =>
  plainText(value, 200)?.split(";")[0]?.trim().toLowerCase();

/**
 * The text viewer's reading of a file row `{artifactId, name, size?,
 * contentType?}`: a Kiingo file id (a UUID) that is Markdown or plain
 * text by its stated type, or by its name when no type is stated.
 * Anything else stays a plain file row.
 */
export const textFileRef = (item: unknown): TextFileRef | undefined => {
  if (!isObject(item)) {
    return undefined;
  }
  const fileId = plainText(item.artifactId, 200);
  if (!fileId || !isDocumentFileId(fileId)) {
    return undefined;
  }
  const name = plainText(item.name, 300) ?? "File";
  const type = baseType(item.contentType);
  let markdown: boolean;
  if (type && MARKDOWN_TYPES.has(type)) {
    markdown = true;
  } else if (type && TEXT_TYPES.has(type)) {
    markdown = false;
  } else if (!type && MARKDOWN_NAME.test(name)) {
    markdown = true;
  } else if (!type && TEXT_NAME.test(name)) {
    markdown = false;
  } else {
    return undefined;
  }
  const size =
    typeof item.size === "number" &&
    Number.isInteger(item.size) &&
    item.size >= 0
      ? item.size
      : undefined;
  return { fileId, name, markdown, ...(size !== undefined ? { size } : {}) };
};

/** The exact bytes a card names for one of its files. */
export type TextFileDigest = { sha256: string; sizeBytes: number };

/**
 * A card that names this file in its `bodyFile` but whose sha256 or size
 * can't be read: refused like bytes that don't match, never skipped as if
 * no digest were named (79 LOW, 2026-10-30). Swift `Digest.unreadable`.
 */
export const TEXT_FILE_DIGEST_UNREADABLE = "unreadable" as const;

export type TextFileDigestCheck =
  | TextFileDigest
  | typeof TEXT_FILE_DIGEST_UNREADABLE;

/**
 * The digest the card's own data names for `fileId`: an email_draft's
 * server-written `bodyFile` {fileId, sha256, sizeBytes} (79 Q3). The
 * viewer shows that file only when its bytes hash to it. Undefined when
 * the card names no digest for this file; `TEXT_FILE_DIGEST_UNREADABLE`
 * when its `bodyFile` names this file but the sha256 or size can't be read.
 */
export const textFileDigest = (
  data: unknown,
  fileId: string,
): TextFileDigestCheck | undefined => {
  if (!isObject(data) || !isObject(data.bodyFile)) {
    return undefined;
  }
  const body = data.bodyFile;
  if (
    typeof body.fileId !== "string" ||
    body.fileId.toLowerCase() !== fileId.toLowerCase()
  ) {
    return undefined;
  }
  if (
    typeof body.sha256 !== "string" ||
    !SHA256.test(body.sha256) ||
    typeof body.sizeBytes !== "number" ||
    !Number.isInteger(body.sizeBytes) ||
    body.sizeBytes <= 0
  ) {
    return TEXT_FILE_DIGEST_UNREADABLE;
  }
  return { sha256: body.sha256, sizeBytes: body.sizeBytes };
};

/**
 * `text` with every "\r\n" and lone "\r" as "\n", so a Windows or old-Mac
 * file reads line by line in plain and Formatted alike (79 LOW,
 * 2026-10-30). Swift `UiTextFile.lineBreaksNormalized`.
 */
export const normalizeTextFileLineBreaks = (text: string): string =>
  text.replace(/\r\n?/g, "\n");

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

export type TextFileReading =
  | { kind: "text"; text: string }
  | { kind: "refused"; message: string };

/**
 * The text of a file's bytes, or why it isn't shown: past
 * `TEXT_FILE_MAX_BYTES`, not the bytes the card names (size, then sha256;
 * a digest that can't be checked here, or that the card names but can't
 * be read, refuses too), or not UTF-8 text (invalid UTF-8 or a NUL byte).
 * A leading byte-order mark is dropped, and line breaks read as "\n".
 */
export const readTextFileBytes = async (
  bytes: Uint8Array,
  digest?: TextFileDigestCheck,
): Promise<TextFileReading> => {
  if (bytes.byteLength > TEXT_FILE_MAX_BYTES) {
    return { kind: "refused", message: TEXT_FILE_TOO_LARGE_MESSAGE };
  }
  if (digest === TEXT_FILE_DIGEST_UNREADABLE) {
    return { kind: "refused", message: TEXT_FILE_CHANGED_MESSAGE };
  }
  if (digest) {
    const subtle = globalThis.crypto?.subtle;
    if (bytes.byteLength !== digest.sizeBytes || !subtle) {
      return { kind: "refused", message: TEXT_FILE_CHANGED_MESSAGE };
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const hashed = hex(await subtle.digest("SHA-256", copy.buffer));
    if (hashed !== digest.sha256) {
      return { kind: "refused", message: TEXT_FILE_CHANGED_MESSAGE };
    }
  }
  if (bytes.includes(0)) {
    return { kind: "refused", message: TEXT_FILE_NOT_TEXT_MESSAGE };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { kind: "text", text: normalizeTextFileLineBreaks(text) };
  } catch {
    return { kind: "refused", message: TEXT_FILE_NOT_TEXT_MESSAGE };
  }
};

/** Whether "Formatted" may draw `text` (Markdown, within the parser's cap). */
export const canFormatTextFile = (ref: TextFileRef, text: string): boolean =>
  ref.markdown && text.length <= TEXT_FILE_FORMATTED_MAX_CHARS;

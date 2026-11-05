// Generated from the Kiingo surface renderer packages at f7dffff48426f852528f24ecb4cb04fb5bc2d5b2; do not edit here.
import { asNumber, isObject } from "./json";
import { isDocumentFileId } from "./document";
import { plainText } from "./text";

// Compare (GENUI-MARKUP, 2026-11-05): the shared reading of its props for
// every renderer (Swift `UiCompare` matches). A side is a proxied image URL
// or a Kiingo file id (an image, or one page of a PDF) the viewer's own
// access reads behind the scan gate. Everything here is the agent's word:
// the type is a hint and the server's view decides what draws.

export type CompareSide = {
  /** The proxied image URL as the card holds it (checked by the loader). */
  url?: string;
  /** A Kiingo file id (a UUID); anything else shows the name only. */
  fileId?: string;
  name?: string;
  contentType?: string;
  agentId?: string;
  /** For a PDF: the page to draw, from 1. */
  page: number;
  /** A file's earlier version number; the current one when absent. */
  version?: number;
  label: string;
  alt: string;
};

export type CompareMode = "slider" | "sideBySide" | "toggle";

export type CompareModel = {
  before: CompareSide;
  after: CompareSide;
  mode: CompareMode;
  vertical: boolean;
  /** Where the divider starts, 0-100. */
  position: number;
};

/** The slider moves in 5% steps from the keyboard and VoiceOver. */
export const COMPARE_STEP = 5;

const sideOf = (value: unknown, fallbackLabel: string): CompareSide | null => {
  if (!isObject(value)) {
    return null;
  }
  const url = typeof value.url === "string" ? value.url : undefined;
  const raw = plainText(value.artifactId, 200);
  const fileId = raw && isDocumentFileId(raw) ? raw.toLowerCase() : undefined;
  if (!url && !raw) {
    return null;
  }
  const name = plainText(value.name, 300);
  const page = Math.floor(asNumber(value.page) ?? 1);
  const version = Math.floor(asNumber(value.version) ?? 0);
  const label = plainText(value.label, 60) ?? fallbackLabel;
  return {
    ...(url ? { url } : {}),
    ...(fileId ? { fileId } : {}),
    ...(name ? { name } : {}),
    ...(plainText(value.contentType, 200)
      ? { contentType: plainText(value.contentType, 200)!.toLowerCase() }
      : {}),
    ...(plainText(value.agentId, 200)
      ? { agentId: plainText(value.agentId, 200)!.toLowerCase() }
      : {}),
    page: Number.isFinite(page) && page >= 1 ? page : 1,
    ...(fileId && Number.isSafeInteger(version) && version >= 1
      ? { version }
      : {}),
    label,
    alt: plainText(value.alt, 300) ?? name ?? label,
  };
};

/** The Compare to draw, or null when a side is missing. */
export const compareModelOf = (
  before: unknown,
  after: unknown,
  mode: unknown,
  orientation: unknown,
  initialPosition: unknown,
): CompareModel | null => {
  const first = sideOf(before, "Before");
  const second = sideOf(after, "After");
  if (!first || !second) {
    return null;
  }
  const start = asNumber(initialPosition);
  return {
    before: first,
    after: second,
    mode: mode === "sideBySide" || mode === "toggle" ? mode : "slider",
    vertical: orientation === "vertical",
    position:
      start === undefined || !Number.isFinite(start)
        ? 50
        : Math.min(100, Math.max(0, start)),
  };
};

/**
 * The raster type of an image's first bytes (png, jpeg, gif, webp), or
 * null: a file is drawn only when its bytes are one of these, whatever its
 * name or the type it was served with.
 */
export const sniffRasterType = (head: Uint8Array): string | null => {
  const at = (index: number) => head[index];
  if (
    head.length >= 8 &&
    at(0) === 0x89 &&
    at(1) === 0x50 &&
    at(2) === 0x4e &&
    at(3) === 0x47 &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  ) {
    return "image/png";
  }
  if (head.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return "image/jpeg";
  }
  if (
    head.length >= 6 &&
    at(0) === 0x47 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x38 &&
    (at(4) === 0x37 || at(4) === 0x39) &&
    at(5) === 0x61
  ) {
    return "image/gif";
  }
  if (
    head.length >= 12 &&
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return "image/webp";
  }
  return null;
};

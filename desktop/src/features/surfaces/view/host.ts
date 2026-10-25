// Generated from the Kiingo surface renderer packages; do not edit here.
import { createContext, useContext } from "react";
import { IMAGE_MIME_TYPES, isOutsideUrl, type EntityKey } from "../core";

/**
 * What the app around a surface does for it (the Swift `UiSurfaceHost`).
 * The renderer never navigates, sends or uploads by itself: a tap asks the
 * host. Everything is optional except `openUrl` and `apiOrigin`; a missing
 * capability draws its control disabled.
 */
export type SurfaceHost = {
  /** `send_message` and suggestion chips: the words go as the user's own message. */
  sendMessage?: (text: string) => void;
  /** Whether a Kiingo object can be opened here (else its chip is plain). */
  canOpenEntity?: (entity: EntityKey) => boolean;
  openEntity?: (entity: EntityKey) => void;
  /** `display: expanded` and `open` with `target: expanded`. */
  openExpanded?: (surfaceId: string) => void;
  /** Opens an https or Kiingo link. Outside hosts were confirmed first. */
  openUrl: (url: string) => void;
  /** Hosts that are not the organization's own (asked before opening). */
  isOutside?: (url: string) => boolean;
  /** The API's origin, e.g. https://api.kiingo.com: media load only from its proxy. */
  apiOrigin: string;
  /** Loads one proxy URL (default: `fetch` with no credentials; the token is the capability). */
  loadMedia?: (url: string) => Promise<MediaAnswer>;
  /** FileInput's device source: pick and upload, answering `{id, name, size, type}` per file. */
  pickFiles?: (multiple: boolean) => Promise<UploadedFile[]>;
};

export type UploadedFile = {
  id: string;
  name: string;
  size?: number;
  type?: string;
};

export type MediaAnswer =
  | { kind: "image"; blob: Blob }
  /** 401/410: the signature expired; the surface is read again. */
  | { kind: "expired" }
  | { kind: "failed" };

/** Raster images up to 10 MB, as the Swift client (never SVG or anything else). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const fetchMedia = async (url: string): Promise<MediaAnswer> => {
  try {
    const response = await fetch(url, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
    });
    if (response.status === 401 || response.status === 410) {
      return { kind: "expired" };
    }
    if (!response.ok) {
      return { kind: "failed" };
    }
    const type = (response.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (!IMAGE_MIME_TYPES.has(type)) {
      return { kind: "failed" };
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_IMAGE_BYTES) {
      return { kind: "failed" };
    }
    const blob = await response.blob();
    if (blob.size > MAX_IMAGE_BYTES) {
      return { kind: "failed" };
    }
    // Re-typed from the checked header, never from the bytes.
    return { kind: "image", blob: new Blob([blob], { type }) };
  } catch {
    return { kind: "failed" };
  }
};

export const defaultIsOutside = (url: string): boolean => isOutsideUrl(url);

const noHost: SurfaceHost = {
  openUrl: () => undefined,
  apiOrigin: "https://api.kiingo.com",
};

export const SurfaceHostContext = createContext<SurfaceHost>(noHost);

export const useSurfaceHost = (): SurfaceHost => useContext(SurfaceHostContext);

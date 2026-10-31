// Generated from the Kiingo surface renderer packages at 9bead1b8e2a179fc0d6d93a384d86d28e66ddf51; do not edit here.
import { createContext, useContext } from "react";
import {
  IMAGE_MIME_TYPES,
  isOutsideUrl,
  type EntityKey,
  type SurfaceTapRef,
} from "../core";

/**
 * What the app around a surface does for it (the Swift `UiSurfaceHost`).
 * The renderer never navigates, sends or uploads by itself: a tap asks the
 * host. Everything is optional except `openUrl` and `apiOrigin`; a missing
 * capability draws its control disabled.
 */
export type SurfaceHost = {
  /**
   * `send_message` and suggestion chips: `text` (exactly what the control
   * showed) goes as the user's message, carrying `tap` so the turn gets
   * tap-turn trust (r3/r3b): the dashboard sends it as the turn's
   * `ui_surface_tap` metadata, Buzz as the `buzz-surface-tap` tag.
   */
  sendMessage?: (text: string, tap: SurfaceTapRef) => void;
  /** Whether a Kiingo object can be opened here (else its chip is plain). */
  canOpenEntity?: (entity: EntityKey) => boolean;
  openEntity?: (entity: EntityKey) => void;
  /** `display: expanded` and `open` with `target: expanded`. */
  openExpanded?: (surfaceId: string) => void;
  /** Opens an https or Kiingo link. Outside hosts were confirmed first. */
  openUrl: (url: string) => void;
  /**
   * Links confirmed before opening: by default everything but the page's
   * own origin (79 W10), which the host routes in-app.
   */
  isOutside?: (url: string) => boolean;
  /** The API's origin, e.g. https://api.kiingo.com: media load only from its proxy. */
  apiOrigin: string;
  /** Loads one proxy URL (default: `fetch` with no credentials; the token is the capability). */
  loadMedia?: (url: string) => Promise<MediaAnswer>;
  /** FileInput's device source: pick and upload, answering `{id, name, size, type}` per file. */
  pickFiles?: (
    multiple: boolean,
    target: UploadTarget,
  ) => Promise<UploadedFile[]>;
  /**
   * Uploads one file the viewer chose or made in a surface (FileInput's
   * picker on the web, a signature, a photo, a voice note) through the
   * viewer's own app session into the normal chat attachment upload, so
   * the viewer owns it (dd, 2026-10-29). Called only after the viewer's
   * explicit gesture (choosing files, Done, Keep, Use photo), never on
   * render or for an agent's action. The saved ref is visible to the agent
   * once the surface saves, like any FileInput value.
   */
  uploadFile?: (
    file: Blob,
    name: string,
    target: UploadTarget,
  ) => Promise<UploadAnswer>;
  /**
   * DocumentViewer's read of one Kiingo file through the viewer's own
   * session (`GET /api/files/:fileId/content`, the files.get read check;
   * no access and missing are both 404, so `missing`). Without it the
   * viewer shows the file row and where to open it. `fileId` is always a
   * UUID (`isDocumentFileId`); the host still encodes it as one path
   * segment. The host reads at most `maxBytes` (`DOCUMENT_MAX_BYTES`),
   * streaming and stopping past it, and refuses a file whose first bytes
   * aren't "%PDF-" before reading further (79 SHOULD-GUB-NO-SIZE-CAP). A
   * host that shows the PDF outside a browser frame of a verified blob
   * (Buzz desktop) needs its own 79 review first: never a CSP frame-src
   * widened to blob:, pdf.js with isEvalSupported and enableScripting off,
   * links through openUrl (SHOULD-GUB-DESKTOP-PDF-NO-FRAME-BLOB).
   */
  readFile?: (
    fileId: string,
    signal: AbortSignal,
    maxBytes: number,
  ) => Promise<FileAnswer>;
  /**
   * The text viewer's read of one Kiingo text or Markdown file (a FileList
   * row, e.g. an email_draft card's long body) through the viewer's own
   * session: the same `GET /api/files/:fileId/content` and read check as
   * `readFile`, but for text, so no "%PDF-" check. The host reads at most
   * `maxBytes` (`TEXT_FILE_MAX_BYTES`), streaming and stopping past it;
   * the renderer checks the card's sha256 and that the bytes are UTF-8.
   * Without it the row opens as a file entity, as before.
   */
  readTextFile?: (
    fileId: string,
    signal: AbortSignal,
    maxBytes: number,
  ) => Promise<FileAnswer>;
};

export type FileAnswer =
  | { kind: "file"; blob: Blob }
  /** 404: not there, or not the viewer's to read (never told apart). */
  | { kind: "missing" }
  /** Restoring from the archive, offline or any other failure. */
  | { kind: "unavailable"; message?: string };

/** Where an upload goes: the viewer's own chat with the surface's agent. */
export type UploadTarget = {
  surfaceId: string;
  agentId?: string;
};

export type UploadAnswer =
  | { kind: "uploaded"; file: UploadedFile }
  /** A plain sentence for the viewer (too large, a type Kiingo won't take…). */
  | { kind: "refused"; message: string };

export type UploadedFile = {
  id: string;
  name: string;
  size?: number;
  type?: string;
};

export type MediaAnswer =
  | { kind: "image"; blob: Blob }
  /** 401: the signature expired; the surface is read again. */
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
    // Only 401 is an expired signature; 410 is a refusal (79 nit).
    if (response.status === 401) {
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

/** Everything but this page's own origin is confirmed first (79 W10). */
export const defaultIsOutside = (url: string): boolean =>
  isOutsideUrl(
    url,
    typeof window !== "undefined" && window.location?.origin
      ? [window.location.origin]
      : [],
  );

const noHost: SurfaceHost = {
  openUrl: () => undefined,
  apiOrigin: "https://api.kiingo.com",
};

export const SurfaceHostContext = createContext<SurfaceHost>(noHost);

export const useSurfaceHost = (): SurfaceHost => useContext(SurfaceHostContext);

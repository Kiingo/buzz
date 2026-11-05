// Generated from the Kiingo surface renderer packages at f7dffff48426f852528f24ecb4cb04fb5bc2d5b2; do not edit here.
import { createContext, useContext } from "react";
import {
  IMAGE_MIME_TYPES,
  isOutsideUrl,
  type EntityKey,
  type SurfaceTapRef,
  type WorkRunRef,
  type WorkViewSource,
} from "../core";

/**
 * What the app around a surface does for it (the Swift `UiSurfaceHost`).
 * The renderer never navigates, sends or uploads by itself: a tap asks the
 * host. Everything is optional except `openUrl` and `apiOrigin`; a missing
 * capability draws its control disabled.
 */
export type SurfaceHost = WorkViewHost & {
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
  /**
   * Full screen for any card: the header's Full screen button and `open`
   * with `target: fullscreen` (GENUI-TREE, 2026-11-05). Without it the
   * button is not drawn and the target opens the expanded view.
   */
  openFullScreen?: (surfaceId: string) => void;
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
  /**
   * The app's own file viewer (FILEVIEW, Ross 2026-11-05: one viewer in
   * chat, cards and Files). A FileList row, a file chip, Media by file id
   * and DocumentViewer's "Open" hand it the files and which one to show;
   * the host reads them with the viewer's own session, behind the scan
   * gate. Called only on the viewer's tap. Without it rows behave as
   * before (text viewer, file entity).
   */
  openFile?: (request: SurfaceFileOpen) => void;
  /**
   * Compare and ImageMarkup (GENUI-MARKUP): the pixels of one Kiingo file
   * a card draws, read with the viewer's own session behind the scan gate
   * (the file's view, then its gated same-origin byte route). An image
   * answers its bytes; a PDF answers page `page` as a PNG (the pages
   * rendition, else the host renders it). The renderer draws the answer
   * only when its first bytes are png, jpeg, gif or webp, and only as an
   * <img> from a blob: URL or on a canvas. Never framed, never navigated
   * to. Without it a file side shows its row (Open in the viewer).
   */
  readFileImage?: (
    request: SurfaceFileImageRequest,
    signal: AbortSignal,
  ) => Promise<FileImageAnswer>;
  /**
   * Model3D (GENUI-SPATIAL; 79 ruling S3 on proposal-v1): the bytes of one
   * Kiingo 3D file, read with the viewer's own session behind the scan gate
   * (the file's view, then its gated same-origin `original` route), only
   * when the server's own type is `model/gltf-binary` or
   * `model/vnd.usdz+zip`. The renderer reads a GLB itself with the checked
   * reader (`readGlb`); a USDZ is never parsed on the web. Never framed,
   * never navigated to. Without it the card shows its poster and alt.
   */
  readFileModel?: (
    request: SurfaceFileModelRequest,
    signal: AbortSignal,
  ) => Promise<FileModelAnswer>;
  /**
   * A FileList carousel card's read before it is opened (GENUI-CAROUSEL,
   * `layout: carousel`): the file's view through the viewer's own session
   * (`GET /api/file-views/:fileId?agentId=`) for the scan state, the
   * server's type and size, and its thumbnail rendition's bytes when it
   * has one and the scan is clean (at most `MAX_IMAGE_BYTES`). Asked when
   * the card shows and again while it is checking and on screen. Without
   * it the card shows the card's own hints and a type icon; the viewer
   * still checks at open.
   */
  fileCard?: (
    file: SurfaceFileRef & { agentId?: string },
    signal: AbortSignal,
  ) => Promise<SurfaceFileCard>;
};

/** What a file card shows (`SurfaceHost.fileCard`). */
export type SurfaceFileCard = {
  /**
   * open: scanned clean. checking: the scan hasn't answered ("Checking…").
   * closed: flagged or never cleared; it never opens (`sentence` says
   * why). missing: not there or not the viewer's (never told apart).
   * unavailable: no answer now.
   */
  state: "open" | "checking" | "closed" | "missing" | "unavailable";
  sentence?: string;
  /** The server's type and size. */
  contentType?: string;
  size?: number;
  /** The thumbnail rendition (raster only, drawn from a blob: URL). */
  thumbnail?: Blob;
};

export type SurfaceFileModelRequest = {
  fileId: string;
  /** Whose Files to resolve it against; default the surface's agent. */
  agentId?: string;
  surfaceId: string;
};

export type FileModelAnswer =
  /** The server's type decides `format`; the renderer checks the bytes too. */
  | { kind: "model"; format: "glb" | "usdz"; bytes: ArrayBuffer }
  | { kind: "checking" }
  | { kind: "closed"; message: string }
  | { kind: "missing" }
  | { kind: "unavailable"; message?: string };

export type SurfaceFileImageRequest = {
  fileId: string;
  /** Whose Files to resolve it against; default the surface's agent. */
  agentId?: string;
  /** The card's type hint; the server's view decides. */
  contentType?: string;
  /** For a PDF: the page, from 1. */
  page: number;
  /** An earlier version of the file (its number); the current one when absent. */
  version?: number;
  surfaceId: string;
};

export type FileImageAnswer =
  | { kind: "image"; blob: Blob }
  /** The scan isn't done: show "Checking…" and ask again. */
  | { kind: "checking" }
  /** Malicious or not cleared by the scan: it never draws. */
  | { kind: "closed"; message: string }
  /** 404: not there, or not the viewer's to read (never told apart). */
  | { kind: "missing" }
  /** Not a picture this host can draw here (a type, a page, a rule). */
  | { kind: "unavailable"; message?: string };

/** One file a surface shows: its ref as the card states it (untrusted text). */
export type SurfaceFileRef = {
  /** The ref's `artifactId`: a Kiingo file or attachment id. */
  fileId: string;
  name: string;
  contentType?: string;
  size?: number;
};

/** Files to open together (a set you page through), starting at `index`. */
export type SurfaceFileOpen = {
  files: SurfaceFileRef[];
  index: number;
  /** A PDF page to open on, from 1 (DocumentViewer). */
  page?: number;
  surfaceId: string;
  agentId?: string;
};

/**
 * WorkView's read of one worker tree through the viewer's own session
 * (GENUI-WORKVIEW): `GET {apiOrigin}{workViewPath(source)}`, the existing
 * owner-only delegation reads. 404 (not the agent's owner, or nothing
 * there; never told apart) is `missing`. The JSON goes to surface-core's
 * `workViewModel` as it came.
 */
export type WorkViewAnswer =
  | { kind: "json"; body: unknown }
  /** The chat's cards still match the `rev` sent: keep the last tree. */
  | { kind: "unchanged" }
  | { kind: "missing" }
  | { kind: "unavailable" };

export type WorkViewHost = {
  /**
   * `rev`, a chat's last cards `rev`: the read long-polls for
   * WORK_VIEW_WAIT_SEC and answers `unchanged` when nothing moved.
   */
  readWorkView?: (
    source: WorkViewSource,
    signal: AbortSignal,
    rev?: string,
  ) => Promise<WorkViewAnswer>;
  /** Opens one worker's session screen (the app's own session view). */
  openWorkerSession?: (target: { sessionId: string; agentId?: string }) => void;
  /**
   * Opens the Run a worker belongs to (the app's agent session page). Only
   * offered for a node the server named a Run on: the viewer's own Run read
   * answers there.
   */
  openWorkerRun?: (target: WorkRunRef) => void;
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

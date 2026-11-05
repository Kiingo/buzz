import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { sniffRasterType, type WorkViewSource } from "@/features/surfaces/core";
import {
  type FileImageAnswer,
  type FileModelAnswer,
  MAX_IMAGE_BYTES,
  type SurfaceFileCard,
  type SurfaceFileImageRequest,
  type SurfaceFileModelRequest,
  type SurfaceFileOpen,
  type SurfaceFileRef,
  type WorkViewAnswer,
} from "@/features/surfaces/view";
import { invokeTauri } from "@/shared/api/tauri";

import { appOriginFor } from "./delegations";

/**
 * One surface card's file and WorkView reads on Buzz desktop (BUZZWIRE,
 * 79 ruling 2026-11-05): `fileCard`, `readFileImage`, `readFileModel` and
 * `readWorkView` go through the native `agent_ui_request` (NIP-98 signed by
 * the signed-in user; the key, URLs and credentials never reach the
 * webview) to the host's routes under this surface. The host answers only
 * the surface's owner, only for files and threads the surface names, only
 * from the surface agent's own Files and delegations, and "unavailable"
 * for anything else (library files, task trees, another agent's). Bytes
 * come back base64; pictures are used only when their first bytes are
 * png, jpeg, gif or webp and they fit MAX_IMAGE_BYTES. `openFile` opens the
 * agent's Files in the Kiingo app, where the viewer's own session reads
 * them; Buzz reads nothing for it.
 */

type Raw = { status: number; body: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const read = async (path: string): Promise<unknown> => {
  const raw = await invokeTauri<Raw>("agent_ui_request", {
    method: "GET",
    path,
  });
  return raw.status === 200 ? raw.body : null;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const bytesOf = (base64: unknown): Uint8Array<ArrayBuffer> | null => {
  if (typeof base64 !== "string") return null;
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
};

/** A picture's bytes as a Blob, only a checked raster within the cap. */
const pictureOf = (base64: unknown): Blob | null => {
  const bytes = bytesOf(base64);
  if (!bytes || bytes.byteLength > MAX_IMAGE_BYTES) return null;
  const type = sniffRasterType(bytes.subarray(0, 16));
  return type ? new Blob([bytes], { type }) : null;
};

const aborted = (signal: AbortSignal) => {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
};

/** The answers the host and the renderer share, passed through checked. */
const plainAnswer = (
  body: Record<string, unknown> | null,
):
  | { kind: "checking" }
  | { kind: "closed"; message: string }
  | { kind: "missing" }
  | { kind: "unavailable"; message?: string } => {
  switch (body?.kind) {
    case "checking":
      return { kind: "checking" };
    case "closed":
      return {
        kind: "closed",
        message: text(body.message) ?? "This file can’t be opened.",
      };
    case "missing":
      return { kind: "missing" };
    default:
      return { kind: "unavailable" };
  }
};

export function surfaceReads(params: {
  surfaceId: string;
  /** The surface's agent, from the surface record. */
  agentId: () => string | undefined;
  /** The host's API origin (`https://api.…`), once known. */
  apiOrigin: () => string | null;
}) {
  const surfaceId = params.surfaceId.toLowerCase();
  const base = `surfaces/${surfaceId}`;
  const ours = (id: string) => id.toLowerCase() === surfaceId;

  const fileCard = async (
    file: SurfaceFileRef & { agentId?: string },
    signal: AbortSignal,
  ): Promise<SurfaceFileCard> => {
    if (!UUID.test(file.fileId)) return { state: "unavailable" };
    const body = record(
      await read(`${base}/files/${file.fileId.toLowerCase()}/card`),
    );
    aborted(signal);
    const state = body?.state;
    if (
      state !== "open" &&
      state !== "checking" &&
      state !== "closed" &&
      state !== "missing"
    ) {
      return { state: "unavailable" };
    }
    const contentType = text(body?.contentType);
    const size =
      typeof body?.size === "number" && Number.isFinite(body.size)
        ? body.size
        : undefined;
    const thumbnail =
      state === "open" ? pictureOf(record(body?.thumbnail)?.base64) : null;
    return {
      state,
      ...(state === "closed"
        ? { sentence: text(body?.sentence) ?? "This file can’t be opened." }
        : {}),
      ...(contentType ? { contentType } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(thumbnail ? { thumbnail } : {}),
    };
  };

  const readFileImage = async (
    request: SurfaceFileImageRequest,
    signal: AbortSignal,
  ): Promise<FileImageAnswer> => {
    const page = Math.floor(request.page);
    if (
      !ours(request.surfaceId) ||
      !UUID.test(request.fileId) ||
      !Number.isSafeInteger(page) ||
      page < 1
    ) {
      return { kind: "unavailable" };
    }
    const fileId = request.fileId.toLowerCase();
    const version =
      request.version !== undefined &&
      Number.isSafeInteger(request.version) &&
      request.version >= 1
        ? `/versions/${request.version}`
        : "";
    const body = record(
      await read(`${base}/files/${fileId}${version}/image/${page}`),
    );
    aborted(signal);
    if (body?.kind === "image") {
      const blob = pictureOf(body.base64);
      return blob
        ? { kind: "image", blob }
        : {
            kind: "unavailable",
            message: "This file isn’t a picture that can be shown here.",
          };
    }
    return plainAnswer(body);
  };

  const readFileModel = async (
    request: SurfaceFileModelRequest,
    signal: AbortSignal,
  ): Promise<FileModelAnswer> => {
    if (!ours(request.surfaceId) || !UUID.test(request.fileId)) {
      return { kind: "unavailable" };
    }
    const body = record(
      await read(`${base}/files/${request.fileId.toLowerCase()}/model`),
    );
    aborted(signal);
    if (body?.kind === "model" && body.format === "glb") {
      const bytes = bytesOf(body.base64);
      // The renderer reads the GLB itself with its checked reader.
      return bytes
        ? { kind: "model", format: "glb", bytes: bytes.slice().buffer }
        : { kind: "unavailable" };
    }
    return plainAnswer(body);
  };

  const readWorkView = async (
    source: WorkViewSource,
    signal: AbortSignal,
  ): Promise<WorkViewAnswer> => {
    // Task trees are not served on Buzz; the host refuses another agent's.
    if (source.kind !== "thread" || !UUID.test(source.threadId)) {
      return { kind: "unavailable" };
    }
    const body = record(
      await read(`${base}/workview/threads/${source.threadId.toLowerCase()}`),
    );
    aborted(signal);
    if (body?.kind === "json") return { kind: "json", body: body.body };
    if (body?.kind === "missing") return { kind: "missing" };
    return { kind: "unavailable" };
  };

  /** The agent's Files in the Kiingo app (the viewer's own session there). */
  const openFile = (_request: SurfaceFileOpen) => {
    const agentId = params.agentId();
    const origin = params.apiOrigin();
    const app = origin ? appOriginFor(new URL(origin).host) : null;
    if (!app || !agentId || !UUID.test(agentId)) {
      toast.error("Couldn’t open that file.");
      return;
    }
    void openUrl(`${app}/team/agents/${agentId.toLowerCase()}?tab=files`).catch(
      () => toast.error("Couldn’t open that file."),
    );
  };

  return { fileCard, readFileImage, readFileModel, readWorkView, openFile };
}

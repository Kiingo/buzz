import { invokeTauri } from "@/shared/api/tauri";

import {
  offSurfaceApi,
  type Result,
  type Surface,
  SurfaceApiError,
  SurfaceStore,
  surfaceResult,
} from "../core";

/**
 * Agent surfaces on Buzz desktop (docs/agent-dm-markers.md §7): one store
 * per community, so every card for one surface shares one controller.
 * Reads go through the native `agent_ui_request` command (NIP-98 signed by
 * the signed-in user; the key never enters the webview), and the host serves
 * a surface only to the person it belongs to.
 *
 * View only for now: the store's controllers send no edits or taps
 * (`viewOnly`), run buttons stay off (no run gate), and the API answers only
 * reads. Links open, and "send message" buttons send the person's own DM
 * message.
 */

type Raw = { status: number; body: unknown; origin?: unknown };
type Read = (surfaceId: string) => Promise<Raw>;

const nativeRead: Read = (surfaceId) =>
  invokeTauri<Raw>("agent_ui_request", {
    method: "GET",
    path: `surfaces/${surfaceId}`,
  });

let read: Read = nativeRead;
let store: SurfaceStore | null = null;
let apiOrigin: string | null = null;

/** Test seam: replace the native read. Returns a restore function. */
export function setSurfaceReadForTests(next: Read) {
  const previous = read;
  read = next;
  resetSurfaceStore();
  return () => {
    read = previous;
    resetSurfaceStore();
  };
}

async function readSurface(surfaceId: string): Promise<Result<Surface>> {
  const raw = await read(surfaceId);
  if (typeof raw.origin === "string" && raw.origin.startsWith("https://")) {
    apiOrigin = raw.origin;
  }
  const result = surfaceResult(raw.status, raw.body);
  if (!result) throw new SurfaceApiError(raw.status);
  return result;
}

export function surfaceStore(): SurfaceStore {
  store ??= new SurfaceStore({
    api: { ...offSurfaceApi, surface: readSurface },
    client: "buzz",
    viewOnly: true,
  });
  return store;
}

/** The host the surfaces' images load from (its media proxy), once known. */
export function surfaceApiOrigin(): string | null {
  return apiOrigin;
}

/** Community switch: drop every controller and the host origin. */
export function resetSurfaceStore() {
  store = null;
  apiOrigin = null;
}

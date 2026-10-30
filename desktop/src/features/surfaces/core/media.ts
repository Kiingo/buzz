// Generated from the Kiingo surface renderer packages at f674e04ba1130af309f8d467ccc7fc5a2efeba01; do not edit here.
// Surface images and media only through the Kiingo proxy (§3.1, §10):
// `GET /api/ui/media?token=<token>` on the API host the client already
// calls. The token is opaque: clients never parse, build or edit it. Any
// other URL shows its alt text instead.

export const MEDIA_PROXY_PATH = "/api/ui/media";

/** Raster images only (never SVG, PDF or anything else), as the Swift client. */
export const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/heic",
  "image/webp",
]);

/**
 * The proxy URL to load, or undefined. `raw` must be the proxy path with
 * exactly one non-empty `token` and nothing else: relative to the API
 * (`/api/ui/media?token=`) or absolute https on `apiOrigin`'s host.
 * Relative URLs resolve against `apiOrigin` (e.g. https://api.kiingo.com).
 */
export const proxiedMediaUrl = (
  raw: unknown,
  apiOrigin: string,
): string | undefined => {
  if (typeof raw !== "string" || raw.length > 2048 || /\s/u.test(raw)) {
    return undefined;
  }
  let api: URL;
  try {
    api = new URL(apiOrigin);
  } catch {
    return undefined;
  }
  if (raw.startsWith("//")) {
    return undefined;
  }
  let url: URL;
  try {
    url = raw.startsWith("/") ? new URL(raw, api.origin) : new URL(raw);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      api.protocol === "http:" &&
      url.host === api.host
    )
  ) {
    return undefined;
  }
  if (
    url.host.toLowerCase() !== api.host.toLowerCase() ||
    url.username ||
    url.password ||
    url.hash
  ) {
    return undefined;
  }
  if (url.pathname !== MEDIA_PROXY_PATH) {
    return undefined;
  }
  const params = [...url.searchParams.entries()];
  if (
    params.length !== 1 ||
    params[0]![0] !== "token" ||
    !/^[A-Za-z0-9._~-]{1,2048}$/u.test(params[0]![1])
  ) {
    return undefined;
  }
  return url.href;
};

/** The signature expired: read the surface again (every URL is re-signed) and load once more. */
export const isExpiredMediaStatus = (status: number): boolean =>
  status === 401 || status === 410;

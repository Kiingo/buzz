// Generated from the Kiingo surface renderer packages at cec9eff8903c0d5f3d7dd58145c4f4dfdf28fb98; do not edit here.
import { asInt, asString, field, isObject, type JsonValue } from "./json";
import {
  decodeSurface,
  type EntityKey,
  type EntityType,
  type Surface,
  type SurfaceState,
} from "./model";
import { surfaceMessage } from "./messages";
import type { PatchOp } from "./patch";
import type { RunAuthorization } from "./run-gate";
import { plainId, plainText, sentence } from "./text";

// The surface routes (§11, §3.1, §10.1): read, list, edit, tap, confirm,
// dismiss and the lookups, with the answers mapped the same way on every
// client (UiSurfaceAPI.swift `UiSurfaceWire`). Taps, confirms and edits go
// only through a human's own interactive session (R5).

export type Result<T> =
  | { kind: "done"; value: T }
  | { kind: "refused"; code: string; message?: string }
  /** No such route here. */
  | { kind: "off" };

export type ConfirmationRecipient = {
  role: string;
  address: string;
  name?: string;
  /** The server's flag: outside the requester's domain. */
  outside: boolean;
};

/** The server's confirmation for a `run` (§5, R3–R5). Drawn as sent; nothing is derived. */
export type Confirmation = {
  surfaceId: string;
  actionId: string;
  revision: number;
  /** Single use, about 2 minutes (R5); sent back exactly. */
  nonce: string;
  text: string;
  account?: string;
  recipients: ConfirmationRecipient[];
  attachments: string[];
  fields: Array<{ label: string; value: string; changed?: string }>;
  confirmLabel: string;
  destructive: boolean;
  expiresAt?: string;
  outsideCount?: number;
};

export type TapOutcome =
  | { kind: "done"; surface?: Surface }
  | { kind: "confirm"; confirmation: Confirmation }
  | { kind: "stale"; surface?: Surface }
  | { kind: "refused"; code: string; message?: string }
  | { kind: "off" };

export type SurfaceListItem = {
  surfaceId: string;
  revision: number;
  state: SurfaceState;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
};
export type SurfaceList = { items: SurfaceListItem[]; nextBefore?: string };

export type LookupItem = {
  id: string;
  title: string;
  subtitle?: string;
  /** Entities: the type; recipients: "person" or "group". */
  type?: string;
  /** Recipients: the address. */
  address?: string;
};

export type SurfaceApi = {
  surface(id: string): Promise<Result<Surface>>;
  surfaces(
    conversationId: string,
    limit: number,
    before?: string,
  ): Promise<Result<SurfaceList>>;
  editSurface(
    id: string,
    baseRevision: number,
    patch: PatchOp[],
    client: string,
  ): Promise<Result<Surface>>;
  /** `extra` is only ever a run gate's authorization (run-gate.ts). */
  tap(
    id: string,
    actionId: string,
    revision: number,
    client: string,
    extra?: RunAuthorization,
  ): Promise<TapOutcome>;
  confirm(
    id: string,
    actionId: string,
    revision: number,
    nonce: string,
    client: string,
    extra?: RunAuthorization,
  ): Promise<TapOutcome>;
  dismiss(id: string, revision: number, client: string): Promise<TapOutcome>;
  lookupRecipients(query: string): Promise<Result<LookupItem[]>>;
  lookupEntities(
    type: EntityType | undefined,
    query: string,
  ): Promise<Result<LookupItem[]>>;
  resolveRefs(keys: EntityKey[]): Promise<Result<LookupItem[]>>;
  lookupFiles(query: string): Promise<Result<LookupItem[]>>;
};

/** No surface routes (demos, previews, a read-only host). */
export const offSurfaceApi: SurfaceApi = {
  surface: async () => ({ kind: "off" }),
  surfaces: async () => ({ kind: "off" }),
  editSurface: async () => ({ kind: "off" }),
  tap: async () => ({ kind: "off" }),
  confirm: async () => ({ kind: "off" }),
  dismiss: async () => ({ kind: "off" }),
  lookupRecipients: async () => ({ kind: "off" }),
  lookupEntities: async () => ({ kind: "off" }),
  resolveRefs: async () => ({ kind: "off" }),
  lookupFiles: async () => ({ kind: "off" }),
};

/** `ui:<surfaceId>:<actionId>:<revision>` (§5): a double tap or a retry never runs twice. */
export const idempotencyKey = (
  surfaceId: string,
  actionId: string,
  revision: number,
): string => `ui:${surfaceId}:${actionId}:${revision}`;

// --- Answers ------------------------------------------------------------------

const codeOf = (body: unknown): string | undefined =>
  asString(field(body, "code")) ??
  asString(field(field(body, "error"), "code")) ??
  asString(field(body, "error"));

const messageOf = (body: unknown): string | undefined => {
  const text = plainText(
    field(body, "message") ?? field(field(body, "error"), "message"),
    300,
  );
  return text ? sentence(text) : undefined;
};

export const decodeConfirmation = (
  value: unknown,
  surfaceId: string,
  actionId: string,
  tapped?: number,
): Confirmation | undefined => {
  const body = isObject(field(value, "confirmation"))
    ? field(value, "confirmation")
    : value;
  if (!isObject(body)) {
    return undefined;
  }
  const nonce = plainId(body.nonce ?? body.confirmToken);
  const text = plainText(body.text ?? body.summary, 4000, true);
  const revision =
    asInt(body.revision) ?? asInt(field(value, "revision")) ?? tapped;
  if (!nonce || !text || revision === undefined) {
    return undefined;
  }
  const list = (key: string): JsonValue[] =>
    Array.isArray(body[key]) ? (body[key] as JsonValue[]).slice(0, 200) : [];
  const recipients = list("recipients")
    .map((item): ConfirmationRecipient | undefined => {
      const address = plainText(
        field(item, "address") ?? field(item, "email"),
        320,
      );
      if (!address) {
        return undefined;
      }
      const name = plainText(field(item, "name"), 120);
      return {
        role: (plainText(field(item, "role"), 10) ?? "to").toLowerCase(),
        address,
        ...(name ? { name } : {}),
        outside: field(item, "outside") === true,
      };
    })
    .filter((item): item is ConfirmationRecipient => Boolean(item));
  const attachments = list("attachments")
    .map((item) => plainText(field(item, "name") ?? item, 200))
    .filter((item): item is string => Boolean(item));
  const fields = list("fields")
    .map((item) => {
      const label = plainText(field(item, "label"), 80);
      if (!label) {
        return undefined;
      }
      const changed = plainText(
        field(item, "changed") ?? field(item, "changedText"),
        200,
      );
      return {
        label,
        value: plainText(field(item, "value"), 2000, true) ?? "",
        ...(changed ? { changed } : {}),
      };
    })
    .filter(
      (item): item is { label: string; value: string; changed?: string } =>
        Boolean(item),
    );
  const account = plainText(field(body.account, "label") ?? body.account, 200);
  const expiresAt = asString(body.expiresAt);
  const outsideCount = asInt(body.outsideRecipients ?? body.outsideCount);
  return {
    surfaceId,
    actionId,
    revision,
    nonce,
    text,
    ...(account ? { account } : {}),
    recipients,
    attachments,
    fields,
    confirmLabel: plainText(body.confirmLabel, 30) ?? "Confirm",
    destructive: body.destructive === true,
    ...(expiresAt ? { expiresAt } : {}),
    ...(outsideCount !== undefined
      ? { outsideCount: Math.max(0, outsideCount) }
      : {}),
  };
};

/** Outside recipients: the server's count, else its per-recipient flags counted. */
export const outsideLine = (confirmation: Confirmation): string | undefined => {
  const count =
    confirmation.outsideCount ??
    confirmation.recipients.filter((item) => item.outside).length;
  if (count <= 0 || /outside recipient/iu.test(confirmation.text)) {
    return undefined;
  }
  return count === 1
    ? "1 recipient outside your organization"
    : `${count} recipients outside your organization`;
};

/** The server's "changed by …" notes, one line each, unless the summary already says them. */
export const changedFlags = (confirmation: Confirmation): string[] =>
  confirmation.fields
    .filter((item) => item.changed && !confirmation.text.includes(item.changed))
    .map((item) => `${item.label}: ${item.changed}`);

const refusedOrOff = <T>(
  status: number,
  body: unknown,
  codes: number[],
): Result<T> | undefined => {
  const code = codeOf(body) ?? "";
  if ((status === 404 && !code) || status === 405 || status === 501) {
    return { kind: "off" };
  }
  if (codes.includes(status) || (status === 503 && code)) {
    const message =
      messageOf(body) ?? (code ? surfaceMessage(code) : undefined);
    return {
      kind: "refused",
      code: code || "refused",
      ...(message ? { message } : {}),
    };
  }
  return undefined;
};

export const surfaceResult = (
  status: number,
  body: unknown,
): Result<Surface> | undefined => {
  if (status >= 200 && status < 300) {
    const surface = decodeSurface(body);
    return surface ? { kind: "done", value: surface } : undefined;
  }
  return refusedOrOff(status, body, [400, 403, 404, 409, 410, 413, 422, 429]);
};

/** A 2xx edit answers `{revision, state, lastEdit}`, not the surface: read it again. */
export const isEditAck = (status: number, body: unknown): boolean =>
  status >= 200 && status < 300 && !decodeSurface(body);

export const listResult = (
  status: number,
  body: unknown,
): Result<SurfaceList> | undefined => {
  if (status >= 200 && status < 300) {
    const raw = field(body, "surfaces");
    const items = (Array.isArray(raw) ? raw : [])
      .slice(0, 50)
      .map((item): SurfaceListItem | undefined => {
        const surfaceId = plainId(
          field(item, "surfaceId") ?? field(item, "id"),
        );
        const revision = asInt(field(item, "revision"));
        if (!surfaceId || revision === undefined) {
          return undefined;
        }
        const state = asString(field(item, "state"));
        const title = plainText(field(item, "title"), 200);
        const createdAt = asString(field(item, "createdAt"));
        const updatedAt = asString(field(item, "updatedAt"));
        return {
          surfaceId,
          revision,
          state:
            state === "submitted" || state === "dismissed" || state === "closed"
              ? state
              : "active",
          ...(title ? { title } : {}),
          ...(createdAt ? { createdAt } : {}),
          ...(updatedAt ? { updatedAt } : {}),
        };
      })
      .filter((item): item is SurfaceListItem => Boolean(item));
    const next = asString(field(body, "nextBefore"));
    return {
      kind: "done",
      value: { items, ...(next ? { nextBefore: next.slice(0, 40) } : {}) },
    };
  }
  return refusedOrOff(status, body, [400, 403, 404, 409, 422, 429]);
};

export const tapResult = (
  status: number,
  body: unknown,
  surfaceId: string,
  actionId: string,
  revision?: number,
): TapOutcome | undefined => {
  const code = codeOf(body) ?? "";
  if (status >= 200 && status < 300) {
    if (
      isObject(body) &&
      (body.confirmation !== undefined || body.outcome === "confirm")
    ) {
      const confirmation = decodeConfirmation(
        body,
        surfaceId,
        actionId,
        revision,
      );
      if (confirmation) {
        return { kind: "confirm", confirmation };
      }
    }
    const run = field(body, "run");
    if (isObject(run)) {
      if (run.status === "failed") {
        return {
          kind: "refused",
          code: "ui_action_failed",
          message:
            plainText(run.error, 1000) ?? surfaceMessage("ui_action_failed"),
        };
      }
      return { kind: "done" };
    }
    const surface = decodeSurface(body);
    return surface ? { kind: "done", surface } : { kind: "done" };
  }
  if (code === "ui_surface_revision_stale") {
    const surface = decodeSurface(body);
    return surface ? { kind: "stale", surface } : { kind: "stale" };
  }
  return refusedOrOff(status, body, [400, 403, 404, 409, 410, 422, 429]) as
    | TapOutcome
    | undefined;
};

export const lookupItems = (value: unknown): LookupItem[] => {
  const raw =
    field(value, "items") ??
    field(value, "results") ??
    field(value, "recipients") ??
    field(value, "entities") ??
    field(value, "files") ??
    field(value, "refs") ??
    value;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .slice(0, 100)
    .map((item): LookupItem | undefined => {
      const address = plainText(
        field(item, "address") ?? field(item, "email"),
        320,
      );
      const id = plainId(field(item, "id")) ?? address;
      const title =
        plainText(
          field(item, "title") ?? field(item, "name") ?? field(item, "label"),
          200,
        ) ?? address;
      if (!id || !title) {
        return undefined;
      }
      const subtitle = plainText(
        field(item, "subtitle") ?? field(item, "detail"),
        200,
      );
      const type = plainText(
        field(item, "type") ?? field(item, "entityType"),
        40,
      );
      return {
        id,
        title,
        ...(subtitle ? { subtitle } : {}),
        ...(type ? { type } : {}),
        ...(address ? { address } : {}),
      };
    })
    .filter((item): item is LookupItem => Boolean(item));
};

export const lookupResult = (
  status: number,
  body: unknown,
): Result<LookupItem[]> | undefined => {
  if (status >= 200 && status < 300) {
    return { kind: "done", value: lookupItems(body) };
  }
  return refusedOrOff(status, body, [400, 403, 404, 409, 422, 429]);
};

// --- A fetch client -------------------------------------------------------------

export type HttpRequest = {
  method: "GET" | "POST" | "PATCH";
  /** Path under the API base, e.g. `/ui/surfaces/<id>` (the base ends in `/api`). */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
};
export type HttpAnswer = { status: number; body: unknown };
/** Sends one request with the host's own credentials; throws when unreachable. */
export type HttpSend = (request: HttpRequest) => Promise<HttpAnswer>;

export class SurfaceApiError extends Error {
  constructor(readonly status: number) {
    super(`surface route answered ${status}`);
    this.name = "SurfaceApiError";
  }
}

/**
 * One path segment. encodeURIComponent leaves "." and ".." as they are, and
 * the URL parser resolves them, so an agent-chosen id like ".." would reach
 * another route with the host's credentials. Those and the empty id are
 * refused (79 L4); the methods below reject, never throw synchronously.
 */
const segment = (value: string) => {
  if (value === "" || value === "." || value === "..") {
    throw new Error("surface_path_segment_invalid");
  }
  return encodeURIComponent(value);
};
const base = (id: string) => `/ui/surfaces/${segment(id)}`;

/** The routes over a host's HTTP sender. Unexpected answers throw (the controller treats them as unreachable). */
export const createSurfaceApi = (send: HttpSend): SurfaceApi => {
  const answer = async <T>(
    request: HttpRequest,
    map: (status: number, body: unknown) => T | undefined,
  ): Promise<T> => {
    const response = await send(request);
    const value = map(response.status, response.body);
    if (value === undefined) {
      throw new SurfaceApiError(response.status);
    }
    return value;
  };
  const read = async (id: string) =>
    await answer({ method: "GET", path: base(id) }, surfaceResult);
  return {
    surface: read,
    surfaces: (conversationId, limit, before) =>
      answer(
        {
          method: "GET",
          path: "/ui/surfaces",
          query: {
            conversationId,
            limit: String(Math.min(Math.max(limit, 1), 50)),
            ...(before ? { before: before.slice(0, 40) } : {}),
          },
        },
        listResult,
      ),
    editSurface: async (id, baseRevision, patch, client) => {
      const response = await send({
        method: "PATCH",
        path: base(id),
        body: { baseRevision, client, patch },
      });
      if (isEditAck(response.status, response.body)) {
        return read(id);
      }
      const value = surfaceResult(response.status, response.body);
      if (!value) {
        throw new SurfaceApiError(response.status);
      }
      return value;
    },
    tap: async (id, actionId, revision, client, extra) =>
      await answer(
        {
          method: "POST",
          path: `${base(id)}/actions/${segment(actionId)}`,
          body: { ...(extra?.body ?? {}), revision, client },
          ...(extra?.headers ? { headers: extra.headers } : {}),
        },
        (status, body) => tapResult(status, body, id, actionId, revision),
      ),
    confirm: async (id, actionId, revision, nonce, client, extra) => {
      const key = idempotencyKey(id, actionId, revision);
      return await answer(
        {
          method: "POST",
          path: `${base(id)}/actions/${segment(actionId)}/confirm`,
          body: {
            ...(extra?.body ?? {}),
            revision,
            nonce,
            client,
            idempotencyKey: key,
          },
          headers: { ...(extra?.headers ?? {}), "Idempotency-Key": key },
        },
        (status, body) => tapResult(status, body, id, actionId, revision),
      );
    },
    dismiss: async (id, revision, client) =>
      await answer(
        {
          method: "POST",
          path: `${base(id)}/dismiss`,
          body: { revision, client },
        },
        (status, body) => tapResult(status, body, id, "dismiss"),
      ),
    lookupRecipients: (query) =>
      answer(
        {
          method: "GET",
          path: "/ui/lookup/recipients",
          query: { q: query.slice(0, 100) },
        },
        lookupResult,
      ),
    lookupEntities: (type, query) =>
      answer(
        {
          method: "GET",
          path: "/ui/lookup/entities",
          query: { q: query.slice(0, 100), ...(type ? { type } : {}) },
        },
        lookupResult,
      ),
    resolveRefs: (keys) =>
      answer(
        {
          method: "POST",
          path: "/ui/lookup/refs",
          body: {
            refs: keys
              .slice(0, 50)
              .map((key) => ({ type: key.type, id: key.id })),
          },
        },
        lookupResult,
      ),
    lookupFiles: (query) =>
      answer(
        {
          method: "GET",
          path: "/ui/lookup/files",
          query: { q: query.slice(0, 100) },
        },
        lookupResult,
      ),
  };
};

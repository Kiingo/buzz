// Generated from the Kiingo surface renderer packages at cfa0fd8c3def901ec65658b6199e22b760f44b57; do not edit here.
import { isObject, type JsonValue } from "./json";

/**
 * A JSON Pointer (RFC 6901) into a surface's data, as tokens. Inside a
 * repeated child a relative path (`.` or `./a`) is joined to the item's
 * pointer (`scope`). Outside a repeat a relative path reads nothing, as the
 * catalog resolves it.
 */
export type Pointer = readonly string[];

export const ROOT: Pointer = [];

const MAX_POINTER_LENGTH = 512;
const MAX_TOKENS = 32;

/** "/a/b~1c" → ["a", "b/c"]; "" is the root. Undefined when malformed. */
export const parsePointer = (raw: string): Pointer | undefined => {
  if (raw === "") {
    return ROOT;
  }
  if (!raw.startsWith("/") || raw.length > MAX_POINTER_LENGTH) {
    return undefined;
  }
  const parts = raw.slice(1).split("/");
  if (parts.length > MAX_TOKENS) {
    return undefined;
  }
  return parts.map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"));
};

/** A binding path read in `scope`: absolute stays, relative joins. */
export const resolvePointer = (
  raw: string,
  scope: Pointer,
): Pointer | undefined => {
  if (raw === "" || raw.startsWith("/")) {
    return parsePointer(raw);
  }
  if (scope.length === 0) {
    return undefined;
  }
  if (raw === ".") {
    return scope;
  }
  const tail = parsePointer(`/${raw.startsWith("./") ? raw.slice(2) : raw}`);
  return tail ? [...scope, ...tail] : undefined;
};

export const formatPointer = (pointer: Pointer): string =>
  pointer
    .map((token) => `/${token.replace(/~/gu, "~0").replace(/\//gu, "~1")}`)
    .join("");

export const appendPointer = (
  pointer: Pointer,
  token: string | number,
): Pointer => [...pointer, String(token)];

export const isPointerPrefix = (prefix: Pointer, of: Pointer): boolean =>
  of.length >= prefix.length && prefix.every((token, i) => of[i] === token);

/**
 * Whether one pointer contains the other, either way (79 W6 MUST 4): a read
 * of `/mail` covers a mark on `/mail/0/subject`, and a read of
 * `/mail/0/subject` is covered by a mark on `/mail`. The one trust test every
 * renderer uses.
 */
export const pointersOverlap = (a: Pointer, b: Pointer): boolean =>
  isPointerPrefix(a, b) || isPointerPrefix(b, a);

export const pointerKey = (pointer: Pointer): string => formatPointer(pointer);

/** The value at `pointer`, undefined when any step is missing. */
export const readAt = (
  data: unknown,
  pointer: Pointer,
): JsonValue | undefined => {
  let current: unknown = data;
  for (const token of pointer) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) {
        return undefined;
      }
      const index = Number(token);
      if (index >= current.length) {
        return undefined;
      }
      current = current[index];
    } else if (isObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        return undefined;
      }
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current as JsonValue | undefined;
};

// Generated from the Kiingo surface renderer packages at c6609e08a498bb4161d453f1ac533d04f66d8bbc; do not edit here.
/** A JSON value as it comes off the wire. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isArray = (value: unknown): value is JsonValue[] =>
  Array.isArray(value);

/** `value[key]` for objects, else undefined. */
export const field = (value: unknown, key: string): JsonValue | undefined =>
  isObject(value) && Object.prototype.hasOwnProperty.call(value, key)
    ? value[key]
    : undefined;

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

export const asInt = (value: unknown): number | undefined => {
  const number = asNumber(value);
  return number === undefined ? undefined : Math.trunc(number);
};

export const asBool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

/** A deep copy through JSON (values are JSON already). */
export const cloneJson = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

/** Deep equality for JSON values. */
export const jsonEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(b, key) &&
          jsonEqual(a[key], b[key]),
      )
    );
  }
  return false;
};

/**
 * Empty for required checks and `notEmpty`: undefined, null, "" (after
 * trimming), [], {}, false, and rich text `{format: "markdown", text: ""}`.
 */
export const isEmptyValue = (value: unknown): boolean => {
  if (value === undefined || value === null || value === false) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim() === "";
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (isObject(value)) {
    if (value.format === "markdown" && typeof value.text === "string") {
      return value.text.trim() === "";
    }
    return Object.keys(value).length === 0;
  }
  return false;
};

/**
 * `table[key]` only for the table's own keys (79 W4): an agent string such
 * as "constructor" or "__proto__" never reaches the prototype.
 */
export const ownEntry = <T>(
  table: Readonly<Record<string, T>>,
  key: string | number | undefined | null,
): T | undefined =>
  key !== undefined &&
  key !== null &&
  Object.prototype.hasOwnProperty.call(table, String(key))
    ? table[String(key)]
    : undefined;

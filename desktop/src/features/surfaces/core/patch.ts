// Generated from the Kiingo surface renderer packages at 0d7eecf6d3b78f4c52514554faa33adb7a1fe131; do not edit here.
import { cloneJson, isObject, type JsonObject, type JsonValue } from "./json";
import {
  formatPointer,
  isPointerPrefix,
  parsePointer,
  readAt,
  type Pointer,
} from "./pointer";

/** One JSON Patch operation (RFC 6902 add, replace, remove) of a user edit (§11 PATCH). */
export type PatchOp =
  | { op: "add"; path: string; value: JsonValue }
  | { op: "replace"; path: string; value: JsonValue }
  | { op: "remove"; path: string };

/** The server takes 1 to 200 ops per edit (`ZUiSurfaceUserPatch`). */
export const MAX_PATCH_OPS = 200;

/**
 * Applies `op` to `data` in place, with the server's rules
 * (`applyUiDataPatch`): add needs an existing parent, replace and remove
 * need an existing value. False when it doesn't apply.
 */
export const applyPatchOp = (data: JsonObject, op: PatchOp): boolean => {
  const pointer = parsePointer(op.path);
  if (!pointer || pointer.length === 0) {
    return false;
  }
  const parent = readAt(data, pointer.slice(0, -1));
  const key = pointer[pointer.length - 1]!;
  if (Array.isArray(parent)) {
    const position = key === "-" ? parent.length : Number(key);
    if (!Number.isInteger(position) || position < 0) {
      return false;
    }
    if (op.op === "add") {
      if (position > parent.length) {
        return false;
      }
      parent.splice(position, 0, cloneJson(op.value));
      return true;
    }
    if (position >= parent.length) {
      return false;
    }
    if (op.op === "replace") {
      parent[position] = cloneJson(op.value);
    } else {
      parent.splice(position, 1);
    }
    return true;
  }
  if (!isObject(parent)) {
    return false;
  }
  const exists = Object.prototype.hasOwnProperty.call(parent, key);
  if (op.op === "add") {
    parent[key] = cloneJson(op.value);
    return true;
  }
  if (!exists) {
    return false;
  }
  if (op.op === "replace") {
    parent[key] = cloneJson(op.value);
  } else {
    delete parent[key];
  }
  return true;
};

/** `ops` applied to a copy of `data`; the ops that don't apply are skipped. */
export const applyPatch = (
  data: JsonObject,
  ops: readonly PatchOp[],
): JsonObject => {
  const next = cloneJson(data ?? {});
  for (const op of ops) {
    applyPatchOp(next, op);
  }
  return next;
};

/**
 * The op that sets `pointer` to `value` (undefined removes it) on `data`:
 * replace when a value is there, add when the parent exists, else one add of
 * the first missing step holding the nested value. Undefined when nothing
 * can hold it (a missing array index, a scalar parent) or nothing changes.
 */
export const opForEdit = (
  data: JsonObject,
  pointer: Pointer,
  value: JsonValue | undefined,
): PatchOp | undefined => {
  if (pointer.length === 0) {
    return undefined;
  }
  const path = formatPointer(pointer);
  const current = readAt(data, pointer);
  if (value === undefined) {
    return current === undefined ? undefined : { op: "remove", path };
  }
  if (current !== undefined) {
    return { op: "replace", path, value };
  }
  // Walk down to the deepest existing ancestor.
  let depth = 0;
  let node: unknown = data;
  while (depth < pointer.length - 1) {
    const next = readAt(node, [pointer[depth]!]);
    if (next === undefined) {
      break;
    }
    node = next;
    depth += 1;
  }
  if (Array.isArray(node)) {
    // Arrays don't grow by index; only an exact append position.
    const index = Number(pointer[depth]);
    if (depth !== pointer.length - 1 || index !== node.length) {
      return undefined;
    }
    return { op: "add", path, value };
  }
  if (!isObject(node)) {
    return undefined;
  }
  let nested: JsonValue = value;
  for (let i = pointer.length - 1; i > depth; i -= 1) {
    nested = { [pointer[i]!]: nested };
  }
  return {
    op: "add",
    path: formatPointer(pointer.slice(0, depth + 1)),
    value: nested,
  };
};

/** The newest op per path wins; a parent's op swallows its children's (as the Swift client). */
export const coalescePatch = (ops: readonly PatchOp[]): PatchOp[] => {
  const result: PatchOp[] = [];
  for (const op of ops) {
    const pointer = parsePointer(op.path);
    if (!pointer) {
      continue;
    }
    for (let i = result.length - 1; i >= 0; i -= 1) {
      const other = parsePointer(result[i]!.path);
      if (!other || isPointerPrefix(pointer, other)) {
        result.splice(i, 1);
      }
    }
    result.push(op);
  }
  return result;
};

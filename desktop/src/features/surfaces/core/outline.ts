// Generated from the Kiingo surface renderer packages at 8a4382a01c1d2046b63e7c78a1220c2c33e419a3; do not edit here.
import { isObject } from "./json";
import { plainText } from "./text";

// Tree and SplitView (GENUI-TREE, 2026-11-05): the logic every web renderer
// shares (surface-react, the MCP App page) and the Swift kit ports
// (UiTreeModel). Walks are iterative, so a deeply nested tree from bound
// data never runs out of stack; the surface's data limit bounds its size.

export type TreeBadge = { text: string; tone?: string };

export type TreeNode = {
  id: string;
  label: string;
  detail?: string;
  icon?: string;
  tone?: string;
  badge?: TreeBadge;
  trailing?: string;
  done: boolean;
  selectable: boolean;
  /** The node's own `open`, else undefined (then `expand` decides). */
  open?: boolean;
  children: TreeNode[];
};

export type TreeExpand = "top" | "all" | "none";

const TONES = new Set(["default", "muted", "success", "warning", "danger"]);

const toneOf = (value: unknown): string | undefined =>
  typeof value === "string" && TONES.has(value) ? value : undefined;

const readNode = (item: Record<string, unknown>, id: string): TreeNode => {
  const node: TreeNode = {
    id,
    label: plainText(item.label, 300) ?? id,
    done: item.done === true,
    selectable: item.selectable !== false,
    children: [],
  };
  const detail = plainText(item.detail, 500);
  const icon = plainText(item.icon, 40);
  const tone = toneOf(item.tone);
  const trailing = plainText(item.trailing, 100);
  if (detail) {
    node.detail = detail;
  }
  if (icon) {
    node.icon = icon;
  }
  if (tone) {
    node.tone = tone;
  }
  if (trailing) {
    node.trailing = trailing;
  }
  if (isObject(item.badge)) {
    const text = plainText(item.badge.text, 60);
    if (text) {
      const badgeTone = toneOf(item.badge.tone);
      node.badge = badgeTone ? { text, tone: badgeTone } : { text };
    }
  }
  if (typeof item.open === "boolean") {
    node.open = item.open;
  }
  return node;
};

/**
 * Tree nodes from the bound or literal array: each id once across the
 * whole tree (the shallower, then earlier, copy wins; the other is dropped
 * with its branch), a number id
 * as its digits, a missing label shown as the id.
 */
export const readTree = (raw: unknown): TreeNode[] => {
  const roots: TreeNode[] = [];
  const seen = new Set<string>();
  // Breadth-first, as the Swift kit (UiTreeModel.read), so the same
  // duplicate wins everywhere.
  const queue: Array<{ items: unknown; into: TreeNode[] }> = [
    { items: raw, into: roots },
  ];
  for (let head = 0; head < queue.length; head += 1) {
    const { items, into } = queue[head]!;
    if (!Array.isArray(items)) {
      continue;
    }
    for (const item of items) {
      if (!isObject(item)) {
        continue;
      }
      const id = plainText(item.id, 64);
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const node = readNode(item, id);
      into.push(node);
      if (Array.isArray(item.children)) {
        queue.push({ items: item.children, into: node.children });
      }
    }
  }
  return roots;
};

export const treeExpandOf = (value: unknown): TreeExpand =>
  value === "all" || value === "none" ? value : "top";

/** The branches open at first: a node's own `open`, else `expand`. */
export const initialTreeOpen = (
  nodes: TreeNode[],
  expand: TreeExpand,
): Set<string> => {
  const open = new Set<string>();
  const stack = nodes.map((node) => ({ node, level: 0 }));
  while (stack.length > 0) {
    const { node, level } = stack.pop()!;
    if (node.children.length === 0) {
      continue;
    }
    const byExpand = expand === "all" || (expand === "top" && level === 0);
    if (node.open ?? byExpand) {
      open.add(node.id);
    }
    for (const child of node.children) {
      stack.push({ node: child, level: level + 1 });
    }
  }
  return open;
};

/**
 * The branches open now: the first rule (`initialTreeOpen`) with the
 * viewer's own folds over it, so a branch that arrives later in bound data
 * still opens by `expand`. Folds stay on the device and are never saved.
 */
export const treeOpenWith = (
  nodes: TreeNode[],
  expand: TreeExpand,
  folds: ReadonlyMap<string, boolean>,
): Set<string> => {
  const open = initialTreeOpen(nodes, expand);
  for (const [id, isOpen] of folds) {
    if (isOpen) {
      open.add(id);
    } else {
      open.delete(id);
    }
  }
  return open;
};

export type TreeRow = {
  node: TreeNode;
  /** 1 for a top-level node (aria-level). */
  level: number;
  parentId?: string;
  /** 1-based place among its siblings, and their count (aria-posinset/setsize). */
  position: number;
  siblings: number;
  open: boolean;
};

/** The rows on screen, in order: every node whose ancestors are all open. */
export const visibleTreeRows = (
  nodes: TreeNode[],
  open: ReadonlySet<string>,
): TreeRow[] => {
  const rows: TreeRow[] = [];
  const stack: Array<{
    list: TreeNode[];
    index: number;
    level: number;
    parentId?: string;
  }> = [{ list: nodes, index: 0, level: 1 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.index >= top.list.length) {
      stack.pop();
      continue;
    }
    const node = top.list[top.index]!;
    top.index += 1;
    const isOpen = node.children.length > 0 && open.has(node.id);
    rows.push({
      node,
      level: top.level,
      ...(top.parentId !== undefined ? { parentId: top.parentId } : {}),
      position: top.index,
      siblings: top.list.length,
      open: isOpen,
    });
    if (isOpen) {
      stack.push({
        list: node.children,
        index: 0,
        level: top.level + 1,
        parentId: node.id,
      });
    }
  }
  return rows;
};

/**
 * What a key does on the focused row (the WAI-ARIA tree pattern): Up and
 * Down move, Home and End jump, Right opens a closed branch or moves into
 * an open one, Left closes an open branch or moves to the parent. Return
 * and Space select (the renderer's own handler).
 */
export const treeKeyStep = (
  rows: TreeRow[],
  focusId: string | undefined,
  key: string,
): { focus?: string; toggle?: string } | undefined => {
  if (rows.length === 0) {
    return undefined;
  }
  const at = rows.findIndex((row) => row.node.id === focusId);
  const row = at >= 0 ? rows[at] : undefined;
  switch (key) {
    case "ArrowDown":
      return { focus: rows[Math.min(at + 1, rows.length - 1)]!.node.id };
    case "ArrowUp":
      return { focus: rows[Math.max(at - 1, 0)]!.node.id };
    case "Home":
      return { focus: rows[0]!.node.id };
    case "End":
      return { focus: rows[rows.length - 1]!.node.id };
    case "ArrowRight":
      if (!row || row.node.children.length === 0) {
        return undefined;
      }
      return row.open
        ? { focus: row.node.children[0]!.id }
        : { toggle: row.node.id };
    case "ArrowLeft":
      if (!row) {
        return undefined;
      }
      if (row.open) {
        return { toggle: row.node.id };
      }
      return row.parentId ? { focus: row.parentId } : undefined;
    default:
      return undefined;
  }
};

/** What VoiceOver and a screen reader say for a row, after its label. */
export const treeRowStatus = (row: TreeRow): string =>
  [
    row.node.done ? "done" : "",
    `level ${row.level}`,
    row.node.children.length > 0 ? (row.open ? "expanded" : "collapsed") : "",
  ]
    .filter(Boolean)
    .join(", ");

/** Every node as an indented outline line (two spaces a level), for copy and text. */
export const treeOutline = (nodes: TreeNode[]): string[] => {
  const all = new Set<string>();
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    all.add(node.id);
    stack.push(...node.children);
  }
  return visibleTreeRows(nodes, all).map((row) => {
    const extra = [row.node.detail, row.node.trailing]
      .filter(Boolean)
      .join(", ");
    return `${"  ".repeat(row.level - 1)}- ${row.node.done ? "[x] " : ""}${row.node.label}${extra ? ` (${extra})` : ""}`;
  });
};

/** A SplitView's selected row: a whole-number index inside the list, else none. */
export const splitSelectedIndex = (
  value: unknown,
  count: number,
): number | undefined =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value < count
    ? value
    : undefined;

/** The width (CSS px) from which a SplitView shows list and detail side by side: Tailwind's @xl container (36rem), as the Swift kit. */
export const SPLIT_VIEW_WIDE_MIN = 576;

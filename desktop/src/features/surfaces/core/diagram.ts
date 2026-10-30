// Generated from the Kiingo surface renderer packages at 7bc569bf4968cc5b06bdc6a9ea3b371d7d21efc7; do not edit here.
import { isObject } from "./json";
import { plainText } from "./text";

// Diagram (§4.2, GU-A): flowcharts, org charts and dependency graphs from a
// structured nodes-and-edges spec (never Mermaid or HTML), with a layered
// auto-layout shared by the web renderers. The Swift renderer ports the
// same steps (UiDiagramLayout), so a diagram lays out alike everywhere.

export type DiagramNode = {
  id: string;
  label: string;
  detail?: string;
  shape: "box" | "rounded" | "pill" | "diamond" | "circle";
  tone?: string;
  icon?: string;
};

export type DiagramEdge = {
  from: string;
  to: string;
  label?: string;
  style: "solid" | "dashed";
};

export type PlacedNode = DiagramNode & {
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
};

export type PlacedEdge = DiagramEdge & {
  points: Array<{ x: number; y: number }>;
  /** Where its label sits: the middle of the elbow's middle segment. */
  labelAt: { x: number; y: number };
  /** Drawn against the flow (it closes a cycle). */
  back: boolean;
};

export type DiagramLayout = {
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
};

const SHAPES = new Set(["box", "rounded", "pill", "diamond", "circle"]);
const TONES = new Set(["default", "muted", "success", "warning", "danger"]);

export const readDiagram = (
  rawNodes: unknown[],
  rawEdges: unknown[],
): { nodes: DiagramNode[]; edges: DiagramEdge[] } => {
  const seen = new Set<string>();
  const nodes = rawNodes
    .slice(0, DIAGRAM_MAX_NODES)
    .flatMap((item): DiagramNode[] => {
      if (!isObject(item)) {
        return [];
      }
      const id = plainText(item.id, 64);
      if (!id || seen.has(id)) {
        return [];
      }
      seen.add(id);
      const detail = plainText(item.detail, 200);
      const tone =
        typeof item.tone === "string" && TONES.has(item.tone)
          ? item.tone
          : undefined;
      const icon = plainText(item.icon, 40);
      return [
        {
          id,
          label: plainText(item.label, 80) ?? id,
          shape:
            typeof item.shape === "string" && SHAPES.has(item.shape)
              ? (item.shape as DiagramNode["shape"])
              : "rounded",
          ...(detail ? { detail } : {}),
          ...(tone ? { tone } : {}),
          ...(icon ? { icon } : {}),
        },
      ];
    });
  const edges = rawEdges
    .slice(0, DIAGRAM_MAX_EDGES)
    .flatMap((item): DiagramEdge[] => {
      if (!isObject(item)) {
        return [];
      }
      const from = plainText(item.from, 64);
      const to = plainText(item.to, 64);
      if (!from || !to || !seen.has(from) || !seen.has(to) || from === to) {
        return [];
      }
      const label = plainText(item.label, 60);
      return [
        {
          from,
          to,
          style: item.style === "dashed" ? "dashed" : "solid",
          ...(label ? { label } : {}),
        },
      ];
    });
  return { nodes, edges };
};

/** Node and edge limits: the catalog's, and what every renderer draws. */
export const DIAGRAM_MAX_NODES = 60;
export const DIAGRAM_MAX_EDGES = 120;

/**
 * Edges that close a cycle (depth-first in node order); the layout draws
 * them against the flow so every other edge points forward.
 */
const backEdges = (nodes: DiagramNode[], edges: DiagramEdge[]): Set<number> => {
  const out = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    out.set(edge.from, [...(out.get(edge.from) ?? []), index]);
  });
  const state = new Map<string, 1 | 2>();
  const back = new Set<number>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const index of out.get(id) ?? []) {
      const next = edges[index]!.to;
      const seen = state.get(next);
      if (seen === 1) {
        back.add(index);
      } else if (seen === undefined) {
        visit(next);
      }
    }
    state.set(id, 2);
  };
  for (const node of nodes) {
    if (!state.has(node.id)) {
      visit(node.id);
    }
  }
  return back;
};

export type DiagramDirection = "down" | "right";

/**
 * Layered layout: longest-path layers over the forward edges, then four
 * barycentre sweeps to cut crossings, then even spacing per layer, centred.
 */
export const layoutDiagram = (
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  direction: DiagramDirection = "down",
): DiagramLayout => {
  const back = backEdges(nodes, edges);
  const forward = edges.filter((_, index) => !back.has(index));
  const layer = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  // Longest path: relax forward edges until stable (a DAG settles in n passes).
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const edge of forward) {
      const next = (layer.get(edge.from) ?? 0) + 1;
      if (next > (layer.get(edge.to) ?? 0)) {
        layer.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  const layers: string[][] = [];
  for (const node of nodes) {
    const at = layer.get(node.id) ?? 0;
    const row = layers[at] ?? [];
    row.push(node.id);
    layers[at] = row;
  }
  const position = new Map<string, number>();
  for (const row of layers) {
    row.forEach((id, i) => {
      position.set(id, i);
    });
  }
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const edge of forward) {
    parents.set(edge.to, [...(parents.get(edge.to) ?? []), edge.from]);
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
  }
  const centre = (ids: string[] | undefined, fallback: number) =>
    ids?.length
      ? ids.reduce((sum, id) => sum + (position.get(id) ?? 0), 0) / ids.length
      : fallback;
  for (let sweep = 0; sweep < 4; sweep += 1) {
    const down = sweep % 2 === 0;
    const order = down
      ? layers.map((_, i) => i)
      : layers.map((_, i) => layers.length - 1 - i);
    for (const at of order) {
      const row = layers[at];
      if (!row) {
        continue;
      }
      const weights = new Map(
        row.map((id, i) => [
          id,
          centre(down ? parents.get(id) : children.get(id), i),
        ]),
      );
      // Stable (ES2019): ties keep their order, as Swift's sort here does.
      row.sort((a, b) => weights.get(a)! - weights.get(b)!);
      row.forEach((id, i) => {
        position.set(id, i);
      });
    }
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const across = direction === "down";
  const w = across ? 136 : 152;
  const h = 44;
  const gapAcross = across ? 24 : 18;
  const gapAlong = across ? 52 : 64;
  const widest = Math.max(1, ...layers.map((row) => row?.length ?? 0));
  const spanAcross = widest * (across ? w : h) + (widest - 1) * gapAcross;
  const placed: PlacedNode[] = [];
  layers.forEach((row, at) => {
    if (!row) {
      return;
    }
    const size = row.length * (across ? w : h) + (row.length - 1) * gapAcross;
    const start = (spanAcross - size) / 2;
    row.forEach((id, i) => {
      const node = byId.get(id)!;
      const offset = start + i * ((across ? w : h) + gapAcross);
      const along = at * ((across ? h : w) + gapAlong);
      placed.push({
        ...node,
        layer: at,
        w,
        h,
        x: across ? offset : along,
        y: across ? along : offset,
      });
    });
  });
  const at = new Map(placed.map((node) => [node.id, node]));
  const placedEdges: PlacedEdge[] = edges.map((edge, i) => {
    const a = at.get(edge.from)!;
    const b = at.get(edge.to)!;
    const isBack = back.has(i);
    const exit = across
      ? { x: a.x + a.w / 2, y: isBack ? a.y : a.y + a.h }
      : { x: isBack ? a.x : a.x + a.w, y: a.y + a.h / 2 };
    const entry = across
      ? { x: b.x + b.w / 2, y: isBack ? b.y + b.h : b.y }
      : { x: isBack ? b.x + b.w : b.x, y: b.y + b.h / 2 };
    // An orthogonal elbow halfway along the flow.
    const points = across
      ? [
          exit,
          { x: exit.x, y: (exit.y + entry.y) / 2 },
          { x: entry.x, y: (exit.y + entry.y) / 2 },
          entry,
        ]
      : [
          exit,
          { x: (exit.x + entry.x) / 2, y: exit.y },
          { x: (exit.x + entry.x) / 2, y: entry.y },
          entry,
        ];
    const p1 = points[1]!;
    const p2 = points[2]!;
    return {
      ...edge,
      points,
      labelAt: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
      back: isBack,
    };
  });
  const width = Math.max(w, ...placed.map((node) => node.x + node.w));
  const height = Math.max(h, ...placed.map((node) => node.y + node.h));
  return { width, height, nodes: placed, edges: placedEdges };
};

/**
 * The diagram as text, for screen readers and the plain-text fallback: each
 * node in layout order with where it leads ("Review → Approve (yes), Reject
 * (no)").
 */
export const diagramOutline = (
  nodes: DiagramNode[],
  edges: DiagramEdge[],
): string[] => {
  const names = new Map(nodes.map((node) => [node.id, node.label]));
  return nodes.map((node) => {
    const next = edges
      .filter((edge) => edge.from === node.id)
      .map(
        (edge) =>
          `${names.get(edge.to) ?? edge.to}${edge.label ? ` (${edge.label})` : ""}`,
      );
    const head = node.detail ? `${node.label}: ${node.detail}` : node.label;
    return next.length ? `${head} → ${next.join(", ")}` : head;
  });
};

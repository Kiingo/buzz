// Generated from the Kiingo surface renderer packages at cfa0fd8c3def901ec65658b6199e22b760f44b57; do not edit here.
// Word- or line-level diff for the Diff component (§4.2): an LCS over
// tokens, capped so huge inputs degrade to a whole replace instead of
// hanging the page.

export type DiffPart = { kind: "same" | "added" | "removed"; text: string };

const MAX_CELLS = 4_000_000;

export const tokenize = (
  text: string,
  granularity: "word" | "line",
): string[] =>
  granularity === "line"
    ? text.split(/(?<=\n)/u)
    : (text.match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_]/gu) ?? []);

/** The two token lists with their common head and tail trimmed. */
const diffMiddle = (
  before: string,
  after: string,
  granularity: "word" | "line",
) => {
  const a = tokenize(before, granularity);
  const b = tokenize(after, granularity);
  // Trim the common head and tail first: most edits are local.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return {
    head: a.slice(0, start).join(""),
    tail: a.slice(endA).join(""),
    midA: a.slice(start, endA),
    midB: b.slice(start, endB),
  };
};

/**
 * The comparison cells {@link diffText} would spend on these inputs: what a
 * renderer charges against its per-surface Diff budget (79 W6).
 */
export const diffCellCount = (
  before: string,
  after: string,
  granularity: "word" | "line" = "word",
): number => {
  const { midA, midB } = diffMiddle(before, after, granularity);
  return midA.length * midB.length;
};

export const diffText = (
  before: string,
  after: string,
  granularity: "word" | "line" = "word",
  /** At most this many comparison cells; past it, a whole replace. */
  maxCells = MAX_CELLS,
): DiffPart[] => {
  const { head, tail, midA, midB } = diffMiddle(before, after, granularity);
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    if (!text) {
      return;
    }
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) {
      last.text += text;
    } else {
      parts.push({ kind, text });
    }
  };
  push("same", head);
  if (midA.length * midB.length > Math.min(maxCells, MAX_CELLS)) {
    push("removed", midA.join(""));
    push("added", midB.join(""));
  } else {
    const n = midA.length;
    const m = midB.length;
    const table: Uint32Array[] = Array.from(
      { length: n + 1 },
      () => new Uint32Array(m + 1),
    );
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i]![j] =
          midA[i] === midB[j]
            ? table[i + 1]![j + 1]! + 1
            : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        push("same", midA[i]!);
        i += 1;
        j += 1;
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
        push("removed", midA[i]!);
        i += 1;
      } else {
        push("added", midB[j]!);
        j += 1;
      }
    }
    while (i < n) {
      push("removed", midA[i++]!);
    }
    while (j < m) {
      push("added", midB[j++]!);
    }
  }
  push("same", tail);
  return parts;
};

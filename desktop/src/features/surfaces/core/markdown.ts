// Generated from the Kiingo surface renderer packages at 7bc569bf4968cc5b06bdc6a9ea3b371d7d21efc7; do not edit here.
import { openableUrl } from "./text";

// The safe Markdown subset surfaces carry (§3: emphasis, lists, links, code,
// quotes, GFM tables; no raw HTML). Parsed to a small tree that each renderer draws with
// its own elements, so nothing is ever injected as markup. Raw HTML stays
// literal text; links open only https and Kiingo deep links (R10), anything
// else is shown as its text. Bare URLs are not auto-linked.

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "del"; children: MdInline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: MdInline[] }
  | { kind: "break" };

export type MdBlock =
  | { kind: "paragraph"; children: MdInline[] }
  | { kind: "heading"; level: 1 | 2 | 3; children: MdInline[] }
  | { kind: "list"; ordered: boolean; start: number; items: MdBlock[][] }
  | { kind: "quote"; children: MdBlock[] }
  | { kind: "code"; language?: string; text: string }
  | { kind: "rule" }
  | {
      kind: "table";
      /** One per column; null is the default (left in most renderers). */
      align: MdAlign[];
      header: MdInline[][];
      /** Every row has exactly `header.length` cells. */
      rows: MdInline[][][];
    };

export type MdAlign = "left" | "center" | "right" | null;

/** GFM table bounds (79 W5/S2): wider or longer input is not a table. */
export const MD_TABLE_MAX_COLUMNS = 20;
export const MD_TABLE_MAX_ROWS = 300;

const MAX_INPUT = 100_000;
const MAX_NESTING = 6;
/**
 * How far one marker, backtick or bracket looks for its partner (79 W5/S2):
 * every scan is bounded, so parsing is linear in the text.
 */
const SCAN_MAX = 1000;

/** The first `char` in `text[from, from + SCAN_MAX)`, else -1. */
const findNear = (text: string, char: string, from: number): number => {
  const limit = Math.min(text.length, from + SCAN_MAX);
  for (let i = from; i < limit; i += 1) {
    if (text[i] === char) {
      return i;
    }
  }
  return -1;
};

// --- Inline -------------------------------------------------------------------

const findClosing = (text: string, from: number, marker: string): number => {
  let i = from;
  const limit = Math.min(text.length, from + SCAN_MAX);
  while (i < limit) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "`") {
      const end = findNear(text, "`", i + 1);
      i = end < 0 ? i + 1 : end + 1;
      continue;
    }
    if (text.startsWith(marker, i) && i > from && text[i - 1] !== " ") {
      return i;
    }
    i += 1;
  }
  return -1;
};

export const parseInline = (text: string, depth = 0): MdInline[] => {
  const out: MdInline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) {
      out.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (
      char === "\\" &&
      i + 1 < text.length &&
      /[\\`*_{}[\]()#+\-.!~>|]/u.test(text[i + 1]!)
    ) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (char === "\n") {
      flush();
      out.push({ kind: "break" });
      i += 1;
      continue;
    }
    if (char === "`") {
      const end = findNear(text, "`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (depth < MAX_NESTING && (char === "*" || char === "_" || char === "~")) {
      const emphasis = readEmphasis(text, i, depth);
      if (emphasis) {
        flush();
        out.push(emphasis.node);
        i = emphasis.next;
        continue;
      }
    }
    if (char === "[" && depth < MAX_NESTING) {
      const close = findBracket(text, i);
      if (close > i && text[close + 1] === "(") {
        const end = findNear(text, ")", close + 2);
        if (end > close + 1) {
          const target =
            text
              .slice(close + 2, end)
              .trim()
              .split(/\s+/u)[0] ?? "";
          const href = openableUrl(target.replace(/^<|>$/gu, ""));
          const label = parseInline(text.slice(i + 1, close), depth + 1);
          flush();
          if (href) {
            out.push({ kind: "link", href, children: label });
          } else {
            out.push(...label);
          }
          i = end + 1;
          continue;
        }
      }
    }
    buffer += char;
    i += 1;
  }
  flush();
  return out;
};

const EMPHASIS = [
  ["**", "strong"],
  ["__", "strong"],
  ["~~", "del"],
  ["*", "em"],
  ["_", "em"],
] as const;

const WORD = /[\p{L}\p{N}]/u;

/** `**x**`, `__x__`, `~~x~~`, `*x*` or `_x_` starting at `i`, if it closes. */
const readEmphasis = (
  text: string,
  i: number,
  depth: number,
): { node: MdInline; next: number } | undefined => {
  for (const [marker, kind] of EMPHASIS) {
    if (!text.startsWith(marker, i)) {
      continue;
    }
    const first = text[i + marker.length];
    if (!first || first === " " || first === "\n") {
      continue;
    }
    // Underscores inside words are literal (snake_case).
    if (marker[0] === "_" && i > 0 && WORD.test(text[i - 1]!)) {
      continue;
    }
    const end = findClosing(text, i + marker.length, marker);
    if (end < 0) {
      continue;
    }
    if (marker[0] === "_" && WORD.test(text[end + marker.length] ?? "")) {
      continue;
    }
    return {
      node: {
        kind,
        children: parseInline(text.slice(i + marker.length, end), depth + 1),
      },
      next: end + marker.length,
    };
  }
  return undefined;
};

const findBracket = (text: string, open: number): number => {
  let level = 0;
  const limit = Math.min(text.length, open + SCAN_MAX);
  for (let i = open; i < limit; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === "[") {
      level += 1;
    }
    if (text[i] === "]") {
      level -= 1;
      if (level === 0) {
        return i;
      }
    }
  }
  return -1;
};

// --- Blocks -------------------------------------------------------------------

const LIST_ITEM = /^(\s{0,3})([-*+]|\d{1,9}[.)])\s+(.*)$/u;

/** Up to three leading spaces off, else undefined (an indented line). */
const unindent = (line: string): string | undefined => {
  let at = 0;
  while (at < line.length && at < 4 && line[at] === " ") {
    at += 1;
  }
  return at > 3 ? undefined : line.slice(at);
};

const FENCE_INFO = /^[\w+#.-]{0,30}$/u;

/** "```lang" or "~~~lang" (no backtracking patterns; 79 W5). */
const readFence = (
  line: string,
): { marker: string; language: string } | undefined => {
  const rest = unindent(line);
  const marker = rest?.startsWith("```")
    ? "```"
    : rest?.startsWith("~~~")
      ? "~~~"
      : undefined;
  if (!rest || !marker) {
    return undefined;
  }
  const info = rest.slice(3).trim();
  return FENCE_INFO.test(info) ? { marker, language: info } : undefined;
};

/** "# Title #" as level and text, trimmed in code (79 W5). */
const readHeading = (
  line: string,
): { level: number; text: string } | undefined => {
  const rest = unindent(line);
  if (!rest?.startsWith("#")) {
    return undefined;
  }
  let level = 0;
  while (level < rest.length && rest[level] === "#") {
    level += 1;
  }
  if (level > 6 || (level < rest.length && !/\s/u.test(rest[level]!))) {
    return undefined;
  }
  let text = rest.slice(level).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") {
    end -= 1;
  }
  // A closing run of #s counts only after a space (or alone).
  if (end < text.length && (end === 0 || /\s/u.test(text[end - 1]!))) {
    text = text.slice(0, end).trim();
  }
  return { level, text };
};

/** "---", "* * *", "___": three or more of one of -*_ and spaces. */
const isRule = (line: string): boolean => {
  const rest = unindent(line);
  const mark = rest?.trim()[0];
  if (!rest || (mark !== "-" && mark !== "*" && mark !== "_")) {
    return false;
  }
  let count = 0;
  for (const char of rest) {
    if (char === mark) {
      count += 1;
    } else if (char !== " " && char !== "\t") {
      return false;
    }
  }
  return count >= 3;
};

/**
 * The cells of a GFM table row: outer pipes off, split on unescaped pipes
 * (an escaped `\\|` stays in the cell for parseInline to unescape). One
 * linear pass; undefined past MD_TABLE_MAX_COLUMNS.
 */
const splitTableRow = (line: string): string[] | undefined => {
  let row = line.trim();
  if (row.startsWith("|")) {
    row = row.slice(1);
  }
  if (row.endsWith("|") && !row.endsWith("\\|")) {
    row = row.slice(0, -1);
  }
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i]!;
    if (char === "\\" && row[i + 1] === "|") {
      cell += "\\|";
      i += 1;
      continue;
    }
    if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      if (cells.length > MD_TABLE_MAX_COLUMNS) {
        return undefined;
      }
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells.length > MD_TABLE_MAX_COLUMNS ? undefined : cells;
};

const DELIMITER_CELL = /^:?-+:?$/u;

/** "| :--- | ---: |" as column alignments, else undefined. */
const readTableDelimiter = (line: string): MdAlign[] | undefined => {
  if (
    !line.includes("-") ||
    !line.includes("|") ||
    unindent(line) === undefined
  ) {
    return undefined;
  }
  const cells = splitTableRow(line);
  if (!cells?.length || !cells.every((cell) => DELIMITER_CELL.test(cell))) {
    return undefined;
  }
  return cells.map((cell) =>
    cell.startsWith(":") && cell.endsWith(":")
      ? "center"
      : cell.endsWith(":")
        ? "right"
        : cell.startsWith(":")
          ? "left"
          : null,
  );
};

/**
 * A GFM table at `lines[at]`: a header row with a pipe, then a delimiter row
 * with the same number of cells. Body rows run to the first blank or
 * pipe-less line, at most MD_TABLE_MAX_ROWS; each is padded or cut to the
 * header's width.
 */
const readTable = (
  lines: readonly string[],
  at: number,
): { block: MdBlock; next: number } | undefined => {
  const headerLine = lines[at]!;
  const delimiterLine = lines[at + 1];
  if (
    delimiterLine === undefined ||
    !headerLine.includes("|") ||
    unindent(headerLine) === undefined
  ) {
    return undefined;
  }
  const header = splitTableRow(headerLine);
  const align = readTableDelimiter(delimiterLine);
  if (!header || !align || align.length !== header.length) {
    return undefined;
  }
  const width = header.length;
  const fit = (cells: string[]): MdInline[][] =>
    Array.from({ length: width }, (_, index) =>
      parseInline(cells[index] ?? "", 1),
    );
  const rows: MdInline[][][] = [];
  let i = at + 2;
  while (
    i < lines.length &&
    rows.length < MD_TABLE_MAX_ROWS &&
    lines[i]!.trim() !== "" &&
    lines[i]!.includes("|")
  ) {
    rows.push(fit(splitTableRow(lines[i]!) ?? [lines[i]!.trim()]));
    i += 1;
  }
  return {
    block: { kind: "table", align, header: fit(header), rows },
    next: i,
  };
};

const parseBlocks = (input: string, depth = 0): MdBlock[] => {
  // Every line break counts as one (79 W6 parity #1), as in cleanText.
  const text = (input ?? "")
    .slice(0, MAX_INPUT)
    .replace(/\r\n|[\r\v\f\u0085\u2028\u2029]/gu, "\n");
  const lines = text.split("\n");
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({
        kind: "paragraph",
        children: parseInline(paragraph.join("\n"), 0),
      });
      paragraph = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = readFence(line);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence.marker)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      blocks.push({
        kind: "code",
        ...(fence.language ? { language: fence.language } : {}),
        text: body.join("\n"),
      });
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      i += 1;
      continue;
    }
    const heading = readHeading(line);
    if (heading) {
      flushParagraph();
      const level = Math.min(3, heading.level) as 1 | 2 | 3;
      blocks.push({
        kind: "heading",
        level,
        children: parseInline(heading.text),
      });
      i += 1;
      continue;
    }
    if (isRule(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }
    if (/^\s{0,3}>/u.test(line) && depth < MAX_NESTING) {
      flushParagraph();
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>/u.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(/^\s{0,3}>\s?/u, ""));
        i += 1;
      }
      blocks.push({
        kind: "quote",
        children: parseBlocks(quoted.join("\n"), depth + 1),
      });
      continue;
    }
    // A table may interrupt a paragraph (GFM).
    const table = line.includes("|") ? readTable(lines, i) : undefined;
    if (table) {
      flushParagraph();
      blocks.push(table.block);
      i = table.next;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (
      item &&
      depth < MAX_NESTING &&
      (paragraph.length === 0 || item[2] === "-" || item[2] === "*")
    ) {
      flushParagraph();
      const ordered = /\d/u.test(item[2]!);
      const start = ordered ? Number.parseInt(item[2]!, 10) : 1;
      const items: string[][] = [];
      while (i < lines.length) {
        const current = LIST_ITEM.exec(lines[i]!);
        if (
          current &&
          current[1]!.length <= 1 &&
          /\d/u.test(current[2]!) === ordered
        ) {
          items.push([current[3]!]);
          i += 1;
          continue;
        }
        if (
          items.length &&
          lines[i]!.trim() !== "" &&
          /^\s{2,}/u.test(lines[i]!)
        ) {
          items[items.length - 1]!.push(lines[i]!.replace(/^\s{2,4}/u, ""));
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({
        kind: "list",
        ordered,
        start,
        items: items.map((body) => parseBlocks(body.join("\n"), depth + 1)),
      });
      continue;
    }
    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
  return blocks;
};

/** Parsed trees by text (they are immutable): a redraw never parses again. */
const PARSED = new Map<string, MdBlock[]>();
const PARSED_MAX = 256;

/**
 * Markdown characters one surface may parse per render (79 S2): past it,
 * text is drawn as plain paragraphs. Make one per surface render pass.
 */
export const MARKDOWN_SURFACE_BUDGET = 60_000;

export type MarkdownBudget = { remaining: number };

export const markdownBudget = (): MarkdownBudget => ({
  remaining: MARKDOWN_SURFACE_BUDGET,
});

const plainBlocks = (text: string): MdBlock[] =>
  text
    .slice(0, MAX_INPUT)
    .split(/\n{2,}/u)
    .filter((part) => part.trim() !== "")
    .map((part) => ({
      kind: "paragraph" as const,
      children: [{ kind: "text" as const, text: part }],
    }));

/**
 * The safe Markdown tree of `input`, memoized by text. With a `budget`, a
 * text past what is left of it is plain paragraphs instead.
 */
export const parseMarkdown = (
  input: string,
  budget?: MarkdownBudget,
): MdBlock[] => {
  const text = input ?? "";
  const cached = PARSED.get(text);
  if (cached) {
    return cached;
  }
  if (budget) {
    if (text.length > budget.remaining) {
      budget.remaining = 0;
      return plainBlocks(text);
    }
    budget.remaining -= text.length;
  }
  const blocks = parseBlocks(text, 0);
  if (PARSED.size >= PARSED_MAX) {
    const oldest = PARSED.keys().next().value;
    if (oldest !== undefined) {
      PARSED.delete(oldest);
    }
  }
  PARSED.set(text, blocks);
  return blocks;
};

/** The plain text of inline nodes (for labels and summaries). */
export const inlineText = (nodes: MdInline[]): string =>
  nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
        case "code":
          return node.text;
        case "break":
          return "\n";
        default:
          return inlineText(node.children);
      }
    })
    .join("");

/**
 * The plain text a person sees drawn from `markdown`, one line per block:
 * list items as "•"/"◦"/"1." lines, table rows tab-separated, rules empty.
 * What Copy gives for a RichTextEditor on every renderer (79 parity),
 * as Swift `CallMarkdown.plainText`.
 */
export const markdownPlainText = (markdown: string): string => {
  const lines: string[] = [];
  const walk = (blocks: MdBlock[], depth: number) => {
    for (const block of blocks) {
      switch (block.kind) {
        case "paragraph":
        case "heading":
          lines.push(inlineText(block.children));
          break;
        case "code":
          lines.push(block.text);
          break;
        case "rule":
          lines.push("");
          break;
        case "quote":
          walk(block.children, depth);
          break;
        case "table":
          for (const row of [block.header, ...block.rows]) {
            lines.push(row.map(inlineText).join("\t"));
          }
          break;
        case "list":
          block.items.forEach((item, index) => {
            const marker = block.ordered
              ? `${block.start + index}.`
              : depth > 0
                ? "◦"
                : "•";
            item.forEach((child, at) => {
              if (
                at === 0 &&
                (child.kind === "paragraph" || child.kind === "heading")
              ) {
                lines.push(`${marker} ${inlineText(child.children)}`);
              } else {
                walk([child], depth + 1);
              }
            });
          });
          break;
      }
    }
  };
  walk(parseMarkdown(markdown ?? ""), 0);
  return lines.join("\n");
};

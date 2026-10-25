// Generated from the Kiingo surface renderer packages; do not edit here.
import { openableUrl } from "./text";

// The safe Markdown subset surfaces carry (§3: emphasis, lists, links, code,
// quotes; no raw HTML). Parsed to a small tree that each renderer draws with
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
  | { kind: "rule" };

const MAX_INPUT = 100_000;
const MAX_NESTING = 6;

// --- Inline -------------------------------------------------------------------

const findClosing = (text: string, from: number, marker: string): number => {
  let i = from;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
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
      const end = text.indexOf("`", i + 1);
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
        const end = text.indexOf(")", close + 2);
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
  for (let i = open; i < text.length; i += 1) {
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

export const parseMarkdown = (input: string, depth = 0): MdBlock[] => {
  const text = (input ?? "").slice(0, MAX_INPUT).replace(/\r\n?/gu, "\n");
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
    const fence = /^\s{0,3}(```|~~~)\s*([\w+#.-]{0,30})\s*$/u.exec(line);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      blocks.push({
        kind: "code",
        ...(fence[2] ? { language: fence[2] } : {}),
        text: body.join("\n"),
      });
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      i += 1;
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line);
    if (heading) {
      flushParagraph();
      const level = Math.min(3, heading[1]!.length) as 1 | 2 | 3;
      blocks.push({
        kind: "heading",
        level,
        children: parseInline(heading[2]!),
      });
      i += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/u.test(line)) {
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
        children: parseMarkdown(quoted.join("\n"), depth + 1),
      });
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
        items: items.map((body) => parseMarkdown(body.join("\n"), depth + 1)),
      });
      continue;
    }
    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
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

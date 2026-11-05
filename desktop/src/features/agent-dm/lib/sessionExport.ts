import { AgentCallApiError } from "@/features/agent-call/lib/agentCallApi";

import { loadActivityPage } from "./sessionViews";

/**
 * `/export` from the reader's own DM (BUZZPARITY E4, 79 2026-11-05 item 10):
 * the session's whole conversation as one Markdown file, in the apps' format
 * (Kiingo `harness-session-export.ts`), from the host's Buzz activity pages,
 * newest first. Any failed page means no file, never a partial one: a page
 * over the 2 MiB answer cap, a bad page or a repeated cursor. Every word is the
 * session's: it goes to the person's file and nowhere else.
 */

type Entry = {
  role: string;
  at: string;
  text: string;
  truncated: boolean;
  images: number;
};
type Item = {
  type: string;
  name: string | null;
  action: string | null;
  line: string;
  text: string | null;
};
export type ExportTurn = {
  id: string;
  prompt: Entry | null;
  reply: Entry | null;
  omitted: number;
  items: Item[];
};
type Page = {
  harness: string | null;
  turns: ExportTurn[];
  hasMore: boolean;
  olderCursor: string | null;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const textOf = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

function parseEntry(value: unknown): Entry | null {
  const entry = record(value);
  if (!entry || typeof entry.text !== "string") return null;
  return {
    role: textOf(entry.role) ?? "",
    at: textOf(entry.at) ?? "",
    text: entry.text,
    truncated: entry.truncated === true,
    images: Array.isArray(entry.images) ? entry.images.length : 0,
  };
}

/** One page, or null when it isn't one: that fails the export. */
export function parseExportPage(body: unknown): Page | null {
  const data = record(record(body)?.data);
  const page = record(data?.page);
  if (!data || !page || !Array.isArray(data.turns)) return null;
  const turns: ExportTurn[] = [];
  for (const raw of data.turns) {
    const turn = record(raw);
    const id = textOf(turn?.id);
    if (!turn || !id || !Array.isArray(turn.items)) return null;
    turns.push({
      id,
      prompt: parseEntry(turn.prompt),
      reply: parseEntry(turn.reply),
      omitted:
        typeof turn.omitted === "number" && turn.omitted > 0
          ? Math.floor(turn.omitted)
          : 0,
      items: turn.items.flatMap((rawItem): Item[] => {
        const item = record(rawItem);
        return item
          ? [
              {
                type: textOf(item.type) ?? "",
                name: textOf(item.name),
                action: textOf(item.action),
                line: typeof item.line === "string" ? item.line : "",
                text: textOf(item.text),
              },
            ]
          : [];
      }),
    });
  }
  return {
    harness: textOf(data.harness),
    turns,
    hasMore: page.hasMore === true,
    olderCursor: textOf(page.olderCursor),
  };
}

const stamp = (at: string | Date): string | null => {
  const date = at instanceof Date ? at : new Date(at);
  return Number.isNaN(date.getTime())
    ? null
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

const oneLine = (text: string): string => text.split(/[\r\n]+/).join(" ");

function stepLine(item: Item): string | null {
  if (item.type === "reasoning") return null;
  if (item.type === "note") {
    const text = (item.text ?? item.line).trim();
    return text ? `- Note: ${oneLine(text)}` : null;
  }
  const name = item.action ?? item.name;
  const line = oneLine(item.line);
  if (name && name !== line) {
    return line ? `- Tool: ${name} · ${line}` : `- Tool: ${name}`;
  }
  return `- Tool: ${line || "unnamed"}`;
}

function entryLines(entry: Entry, agent: string): string[] {
  const who =
    entry.role === "you" ? "You" : entry.role === "agent" ? agent : "Kiingo";
  const at = stamp(entry.at);
  const lines = ["", `## ${who}${at ? ` · ${at}` : ""}`, "", entry.text];
  if (entry.images > 0) {
    lines.push(
      "",
      entry.images === 1
        ? "(1 image not included)"
        : `(${entry.images} images not included)`,
    );
  }
  if (entry.truncated) {
    lines.push("", "(Kiingo cut this message at 32 KB.)");
  }
  return lines;
}

const HARNESS_NAME: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
};

/** The file: a heading per prompt and reply, a line per tool call and note. */
export function sessionExportMarkdown(input: {
  turns: readonly ExportTurn[];
  harness: string | null;
  now: Date;
}): string {
  const agent = (input.harness && HARNESS_NAME[input.harness]) || "Session";
  const count = input.turns.length;
  const out = [
    "# Session",
    "",
    `Exported from Buzz ${stamp(input.now)}. ${count} ${
      count === 1 ? "turn" : "turns"
    }.`,
  ];
  for (const turn of input.turns) {
    if (turn.prompt) out.push(...entryLines(turn.prompt, agent));
    const steps = turn.items.flatMap((item) => {
      const step = stepLine(item);
      return step ? [step] : [];
    });
    if (turn.omitted > 0 || steps.length > 0) {
      out.push("");
      if (turn.omitted > 0) {
        out.push(`- (${turn.omitted} earlier steps not included)`);
      }
      out.push(...steps);
    }
    if (turn.reply) out.push(...entryLines(turn.reply, agent));
  }
  out.push("");
  return out.join("\n");
}

export function sessionExportFileName(now: Date): string {
  return `session-${now.toISOString().slice(0, 10)}.md`;
}

export type SessionExport = {
  markdown: string;
  turns: number;
  fileName: string;
};

/**
 * Read every page and build the file. Throws `session_export_incomplete`
 * for a bad page or a repeated cursor, and the host's own refusal otherwise.
 */
export async function readSessionExport(
  agentPublicKey: string,
  now: Date = new Date(),
): Promise<SessionExport> {
  const pages: Page[] = [];
  const cursors = new Set<string>();
  let before: string | null = null;
  for (;;) {
    const page = parseExportPage(
      await loadActivityPage(agentPublicKey, before),
    );
    if (!page) throw new AgentCallApiError(null, "session_export_incomplete");
    pages.push(page);
    if (!page.hasMore) break;
    const next = page.olderCursor;
    if (!next || cursors.has(next)) {
      throw new AgentCallApiError(null, "session_export_incomplete");
    }
    cursors.add(next);
    before = next;
  }
  // Pages come newest first, each oldest first inside; one turn once.
  const seen = new Set<string>();
  const turns = [...pages]
    .reverse()
    .flatMap((page) => page.turns)
    .filter((turn) => {
      if (seen.has(turn.id)) return false;
      seen.add(turn.id);
      return true;
    });
  return {
    markdown: sessionExportMarkdown({
      turns,
      harness: pages[0]?.harness ?? null,
      now,
    }),
    turns: turns.length,
    fileName: sessionExportFileName(now),
  };
}

import type { Channel } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

import {
  MAX_AGENT_COMMANDS,
  type AgentSkillCommand,
  type AgentSlashCommand,
} from "./slashCommands";

/** Skill arguments sent in the `buzz-skill` tag are at most this long. */
export const MAX_SKILL_ARGS = 4_000;
/** The menu lists every match (it scrolls): a shorter cut made a plain "/"
 * look as if skills past the first screenful were never loaded. */
const MAX_MENU_ITEMS = MAX_AGENT_COMMANDS;

export type SlashQuery = {
  /** Text typed after "/" up to the caret. */
  query: string;
  /** Offset of the "/" (the start of the text replaced on choose). */
  tokenStart: number;
  /** End offset of the command token (the text replaced on choose). */
  tokenEnd: number;
};

/** A "/" command token in a text: `/` and the word after it. */
export type SlashToken = {
  /** Offset of the "/". */
  start: number;
  /** End offset of the token (the next whitespace, or the end). */
  end: number;
  /** The word after "/" (may be empty). */
  name: string;
};

/**
 * Every "/" command token in a text. A token opens a word, like an `@`
 * mention or a `#channel`: the "/" is at the start of the text or right
 * after whitespace or an opening bracket, and the word after it runs to the
 * next whitespace without another "/". So `hi /rev` has a token, while a
 * URL (`https://x/y`), a path (`~/a`, `/usr/bin`) or `a/b` never does.
 */
export function slashTokens(text: string): SlashToken[] {
  const tokens: SlashToken[] = [];
  const pattern = /(^|[\s([{])\/([^\s/]*)(?=\s|$)/g;
  for (const match of text.matchAll(pattern)) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const name = match[2] ?? "";
    tokens.push({ start, end: start + 1 + name.length, name });
  }
  return tokens;
}

/**
 * The "/" query being typed at the caret: the caret is at the end of a "/"
 * token anywhere in the text (`/`, `/rev`, `hi /rev`), not inside a word
 * (`a/rev`), a URL or a path, and not past the token (`/review the PR`).
 */
export function detectSlashQuery(
  text: string,
  cursor: number,
): SlashQuery | null {
  if (cursor < 1) return null;
  const token = slashTokens(text).find(
    (candidate) => candidate.end === cursor && candidate.start < cursor,
  );
  if (!token) return null;
  return {
    query: text.slice(token.start + 1, cursor),
    tokenStart: token.start,
    tokenEnd: token.end,
  };
}

export type SlashCommandSection = "commands" | "agent-skills" | "skills";

/** The menu section a command is listed under. */
export function slashCommandSection(
  command: AgentSlashCommand,
): SlashCommandSection {
  if (command.kind === "session") return "commands";
  return command.source === "registry" ? "skills" : "agent-skills";
}

export const SLASH_SECTION_LABELS: Record<SlashCommandSection, string> = {
  commands: "Commands",
  "agent-skills": "This agent's skills",
  skills: "Skills",
};

const SECTION_ORDER: Record<SlashCommandSection, number> = {
  commands: 0,
  "agent-skills": 1,
  skills: 2,
};

/**
 * How well a command matches the typed query (higher is better, 0 is no
 * match): the name itself, then a name prefix, a word prefix, a substring,
 * and from three letters on the letters in order, then a description match.
 */
export function slashMatchScore(
  command: AgentSlashCommand,
  query: string,
): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 1;
  const name = command.name.toLowerCase();
  const display =
    command.kind === "skill" ? (command.displayName ?? "").toLowerCase() : "";
  if (name === needle) return 100;
  if (name.startsWith(needle)) return 90;
  if (
    `${name} ${display}`
      .split(/[\s._:-]+/)
      .some((word) => word.startsWith(needle))
  )
    return 80;
  if (name.includes(needle) || display.includes(needle)) return 70;
  // Short queries match names only: two letters in order, or inside a
  // description, match almost everything.
  if (needle.length < 3) return 0;
  let at = 0;
  for (const letter of name) {
    if (letter === needle[at]) {
      at += 1;
      if (at === needle.length) return 50;
    }
  }
  return (command.description ?? "").toLowerCase().includes(needle) ? 30 : 0;
}

/**
 * The menu's commands for a query, grouped by section (commands, this
 * agent's skills, other skills) and best match first within each; ties
 * keep the server's order.
 */
export function filterSlashCommands(
  commands: readonly AgentSlashCommand[],
  query: string,
): AgentSlashCommand[] {
  return commands
    .map((command, index) => ({
      command,
      index,
      score: slashMatchScore(command, query),
      section: SECTION_ORDER[slashCommandSection(command)],
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        left.section - right.section ||
        right.score - left.score ||
        left.index - right.index,
    )
    .slice(0, MAX_MENU_ITEMS)
    .map((entry) => entry.command);
}

/**
 * What choosing a command puts in the composer: a skill leaves `/<name> `
 * for its arguments; a session command is the exact command it sends.
 */
export function slashCommandText(command: AgentSlashCommand) {
  return command.kind === "skill" ? `/${command.name} ` : `/${command.name}`;
}

/**
 * Whether choosing the command asks first. Only `/new` does: it ends the
 * agent's current session. `/sessions` is a harmless listing request.
 */
export function slashCommandNeedsConfirm(command: AgentSlashCommand) {
  return command.kind === "session" && command.name === "new";
}

export type SkillInvocation = {
  command: AgentSkillCommand;
  /** The skill's input: the message without the skill's token, trimmed. */
  args: string;
  /** The whole message as typed, trimmed. */
  text: string;
  /** Whether the token opens the message (`/<name> args`). */
  leading: boolean;
};

/**
 * The skill invocation for a token: its arguments are the rest of the
 * message, the words before the token, then the words after it.
 */
export function skillInvocationAt(
  text: string,
  token: SlashToken,
  command: AgentSkillCommand,
  leadingStart = 0,
): SkillInvocation {
  const leading = token.start === leadingStart;
  const before = leading ? "" : text.slice(0, token.start).trim();
  const after = text.slice(token.end).trim();
  return {
    command,
    args: before && after ? `${before} ${after}` : before || after,
    text,
    leading,
  };
}

/**
 * The listed skill a composer text invokes, with its arguments, or null.
 * A leading `/<name>` invokes any listed skill (typed or picked). A skill
 * token later in the message counts only when it was picked from the menu
 * (`picked`), so a message that merely mentions `/review` stays a message.
 * One skill per message: with several tokens the last one counts.
 */
export function parseSkillInvocation(
  text: string,
  commands: readonly AgentSlashCommand[],
  picked: ReadonlySet<string> = new Set(),
  leadingStart = 0,
): SkillInvocation | null {
  const trimmed = text.trim();
  let found: { token: SlashToken; command: AgentSkillCommand } | null = null;
  for (const token of slashTokens(trimmed)) {
    if (token.start !== leadingStart && !picked.has(token.name)) continue;
    const command = commands.find(
      (candidate): candidate is AgentSkillCommand =>
        candidate.kind === "skill" && candidate.name === token.name,
    );
    if (command) found = { token, command };
  }
  return found
    ? skillInvocationAt(trimmed, found.token, found.command, leadingStart)
    : null;
}

export type SkillMessage =
  | { ok: true; content: string; tags: string[][] }
  | { ok: false; reason: "args_too_long" };

/**
 * The event for a skill invocation, with exactly one `buzz-skill` tag. A
 * leading skill sends `/<name> <args>` (just `/<name>` without arguments);
 * a skill picked later in a message keeps the message as typed.
 */
export function buildSkillMessage(invocation: SkillInvocation): SkillMessage {
  const { command, args } = invocation;
  if (args.length > MAX_SKILL_ARGS)
    return { ok: false, reason: "args_too_long" };
  const content = invocation.leading
    ? args
      ? `/${command.name} ${args}`
      : `/${command.name}`
    : invocation.text;
  return {
    ok: true,
    content,
    tags: [["buzz-skill", command.skillId, args]],
  };
}

/**
 * The skill's argument hint while the composer holds just `/<name>` (with
 * or without the trailing space), so it can show where arguments go.
 */
export function argumentHintFor(
  text: string,
  commands: readonly AgentSlashCommand[],
): string | null {
  const invocation = parseSkillInvocation(text, commands);
  if (!invocation || invocation.args) return null;
  return invocation.command.argumentHint;
}

/** The agent on the other side of a 1:1 DM, or null. */
export function agentDmPeer(
  channel: Pick<Channel, "channelType" | "participantPubkeys"> | undefined,
  selfPubkey: string | undefined,
  isAgent: (pubkey: string) => boolean,
): string | null {
  if (channel?.channelType !== "dm" || !selfPubkey) return null;
  const self = normalizePubkey(selfPubkey);
  const others = [
    ...new Set(
      channel.participantPubkeys.map((pubkey) => normalizePubkey(pubkey)),
    ),
  ].filter((pubkey) => pubkey && pubkey !== self);
  const [peer] = others;
  return others.length === 1 && peer && isAgent(peer) ? peer : null;
}

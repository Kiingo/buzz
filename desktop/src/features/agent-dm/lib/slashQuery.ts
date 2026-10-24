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
  /** End offset of the command token (the text replaced on choose). */
  tokenEnd: number;
};

/**
 * A "/" query at the very start of the composer while the caret is still in
 * the first token: `/`, `/rev`, but not `/review the PR` or `hi /x`.
 */
export function detectSlashQuery(
  text: string,
  cursor: number,
): SlashQuery | null {
  if (!text.startsWith("/")) return null;
  const whitespace = text.search(/\s/);
  const tokenEnd = whitespace === -1 ? text.length : whitespace;
  if (cursor < 1 || cursor !== tokenEnd) return null;
  const query = text.slice(1, cursor);
  if (query.includes("/")) return null;
  return { query, tokenEnd };
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

export type SkillInvocation = { command: AgentSkillCommand; args: string };

/**
 * The listed skill a composer text invokes (`/<name>` then optional
 * arguments), with the arguments trimmed, or null.
 */
export function parseSkillInvocation(
  text: string,
  commands: readonly AgentSlashCommand[],
): SkillInvocation | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const whitespace = trimmed.search(/\s/);
  const name = trimmed.slice(1, whitespace === -1 ? undefined : whitespace);
  const command = commands.find(
    (candidate): candidate is AgentSkillCommand =>
      candidate.kind === "skill" && candidate.name === name,
  );
  if (!command) return null;
  const args = whitespace === -1 ? "" : trimmed.slice(whitespace).trim();
  return { command, args };
}

export type SkillMessage =
  | { ok: true; content: string; tags: string[][] }
  | { ok: false; reason: "args_too_long" };

/**
 * The event for a skill invocation: content `/<name> <args>` (just
 * `/<name>` without arguments) and exactly one `buzz-skill` tag.
 */
export function buildSkillMessage(invocation: SkillInvocation): SkillMessage {
  const { command, args } = invocation;
  if (args.length > MAX_SKILL_ARGS)
    return { ok: false, reason: "args_too_long" };
  return {
    ok: true,
    content: args ? `/${command.name} ${args}` : `/${command.name}`,
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

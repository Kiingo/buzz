import type { Channel } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

import type { AgentSkillCommand, AgentSlashCommand } from "./slashCommands";

/** Skill arguments sent in the `buzz-skill` tag are at most this long. */
export const MAX_SKILL_ARGS = 4_000;
const MAX_MENU_ITEMS = 50;

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

/** Prefix matches first, then substring matches, in server order. */
export function filterSlashCommands(
  commands: readonly AgentSlashCommand[],
  query: string,
): AgentSlashCommand[] {
  const needle = query.toLowerCase();
  const prefix: AgentSlashCommand[] = [];
  const inner: AgentSlashCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) prefix.push(command);
    else if (needle && name.includes(needle)) inner.push(command);
  }
  return [...prefix, ...inner].slice(0, MAX_MENU_ITEMS);
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

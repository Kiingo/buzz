import { normalizePubkey } from "@/shared/lib/pubkey";

import type { AgentSlashCommand } from "./slashCommands";
import {
  detectSlashQuery,
  MAX_SKILL_ARGS,
  parseSkillInvocation,
  type SkillInvocation,
  type SlashQuery,
} from "./slashQuery";

/**
 * The "/" menu in a channel or thread. Unlike a 1:1 DM the conversation has
 * no single agent, so the command token may follow a leading mention of the
 * agent it is for (`@Scout /rev`), and the menu needs a target agent.
 */

/** Agents listed to choose from when the target is ambiguous. */
export const MAX_SLASH_AGENT_CHOICES = 20;

export type GroupSlashQuery = SlashQuery & {
  /** Offset of the "/" (0, or just after a leading mention). */
  tokenStart: number;
  /** The text before the "/" (empty, or `@Name `). */
  prefix: string;
};

/**
 * Where the "/" of a command starts: at the very start, or right after a
 * leading `@…` mention on the first line (`@Scout /x`). Null otherwise.
 */
export function slashTokenStart(text: string): number | null {
  if (text.startsWith("/")) return 0;
  if (!text.startsWith("@")) return null;
  const at = text.indexOf(" /");
  if (at < 2) return null;
  const prefix = text.slice(0, at);
  return prefix.includes("\n") ? null : at + 1;
}

/** A "/" query while the caret is still in the command token. */
export function detectGroupSlashQuery(
  text: string,
  cursor: number,
): GroupSlashQuery | null {
  const tokenStart = slashTokenStart(text);
  if (tokenStart === null) return null;
  const query = detectSlashQuery(text.slice(tokenStart), cursor - tokenStart);
  if (!query) return null;
  return {
    query: query.query,
    tokenStart,
    tokenEnd: tokenStart + query.tokenEnd,
    prefix: text.slice(0, tokenStart),
  };
}

export type SlashTarget =
  | { kind: "agent"; pubkey: string }
  | { kind: "choose"; pubkeys: string[] };

function unique(pubkeys: readonly string[]): string[] {
  return [...new Set(pubkeys.map(normalizePubkey))].filter(Boolean);
}

/**
 * The agent a "/" is for: the agent mentioned before it; else the agent the
 * conversation is already addressed to (a thread with an agent); else the
 * conversation's only agent. Several candidates are offered as a choice; a
 * mention of someone who is not an agent, or no agent at all, means no menu.
 */
export function resolveSlashTarget(input: {
  hasPrefix: boolean;
  prefixAgents: readonly string[];
  addressedAgents: readonly string[];
  channelAgents: readonly string[];
}): SlashTarget | null {
  if (input.hasPrefix) {
    const [first] = unique(input.prefixAgents);
    return first ? { kind: "agent", pubkey: first } : null;
  }
  for (const candidates of [input.addressedAgents, input.channelAgents]) {
    const pubkeys = unique(candidates);
    if (pubkeys.length === 1 && pubkeys[0]) {
      return { kind: "agent", pubkey: pubkeys[0] };
    }
    if (pubkeys.length > 1) {
      return {
        kind: "choose",
        pubkeys: pubkeys.slice(0, MAX_SLASH_AGENT_CHOICES),
      };
    }
  }
  return null;
}

/** The skill a channel or thread message invokes (`[@Name ]/<skill> args`). */
export function parseGroupSkillInvocation(
  text: string,
  commands: readonly AgentSlashCommand[],
): SkillInvocation | null {
  const trimmed = text.trim();
  const tokenStart = slashTokenStart(trimmed);
  if (tokenStart === null) return null;
  return parseSkillInvocation(trimmed.slice(tokenStart), commands);
}

/** The `buzz-skill` tag for a group skill pick, or null when its arguments
 * are too long. The message text stays as typed (`@Name /skill args`). */
export function groupSkillTag(invocation: SkillInvocation): string[] | null {
  if (invocation.args.length > MAX_SKILL_ARGS) return null;
  return ["buzz-skill", invocation.command.skillId, invocation.args];
}

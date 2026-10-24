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
 * no single agent, so the menu needs a target agent: one mentioned before
 * the "/" (`@Scout /rev`, `ask @Scout to /rev`), else the agent the
 * conversation addresses or its only agent.
 */

/** Agents listed to choose from when the target is ambiguous. */
export const MAX_SLASH_AGENT_CHOICES = 20;

export type GroupSlashQuery = SlashQuery & {
  /** The text before the "/" (empty, `@Name `, or any words). */
  prefix: string;
};

/**
 * Where a leading "/" command starts: at the very start, or right after a
 * leading `@…` mention on the first line (`@Scout /x`). Null otherwise. Only
 * a leading command can be a session command (`/new`), and only a leading
 * skill name may be typed by hand instead of picked.
 */
export function slashTokenStart(text: string): number | null {
  if (text.startsWith("/")) return 0;
  if (!text.startsWith("@")) return null;
  const at = text.indexOf(" /");
  if (at < 2) return null;
  const prefix = text.slice(0, at);
  return prefix.includes("\n") ? null : at + 1;
}

/** A "/" query while the caret is at the end of a "/" token, anywhere. */
export function detectGroupSlashQuery(
  text: string,
  cursor: number,
): GroupSlashQuery | null {
  const query = detectSlashQuery(text, cursor);
  if (!query) return null;
  return { ...query, prefix: text.slice(0, query.tokenStart) };
}

/** Whether a text before a "/" mentions someone (`@…` opening a word). */
export function mentionsSomeone(prefix: string): boolean {
  return /(^|[\s([{])@\S/.test(prefix);
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

/** What is known of an agent's "/" list here. */
export type SlashListState = "unknown" | "empty" | "some";

/**
 * Narrow a choice of several agents by what each offers: an agent whose list
 * came back empty (nothing the viewer may use with it) is no choice, and once
 * every other list is known to be empty the "/" is for the one left. Agents
 * still loading stay on offer. Null when none is left.
 */
export function narrowSlashChoice(
  target: SlashTarget | null,
  listState: (pubkey: string) => SlashListState,
): SlashTarget | null {
  if (target?.kind !== "choose") return target;
  const open = target.pubkeys.filter((pubkey) => listState(pubkey) !== "empty");
  const [only] = open;
  if (open.length === 1 && only && listState(only) === "some") {
    return { kind: "agent", pubkey: only };
  }
  return open.length > 0 ? { kind: "choose", pubkeys: open } : null;
}

/**
 * The skill a channel or thread message invokes: `[@Name ]/<skill> args`,
 * or a picked skill anywhere in the message (see `parseSkillInvocation`).
 */
export function parseGroupSkillInvocation(
  text: string,
  commands: readonly AgentSlashCommand[],
  picked: ReadonlySet<string> = new Set(),
): SkillInvocation | null {
  const trimmed = text.trim();
  return parseSkillInvocation(
    trimmed,
    commands,
    picked,
    slashTokenStart(trimmed) ?? -1,
  );
}

/** The `buzz-skill` tag for a group skill pick, or null when its arguments
 * are too long. The message text stays as typed (`@Name /skill args`, or
 * the whole message around a picked skill). */
export function groupSkillTag(invocation: SkillInvocation): string[] | null {
  if (invocation.args.length > MAX_SKILL_ARGS) return null;
  return ["buzz-skill", invocation.command.skillId, invocation.args];
}

import * as React from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useKnownAgentPubkeys } from "@/features/agents/useKnownAgentPubkeys";
import { channelsQueryKey } from "@/features/channels/hooks";
import type { AutocompleteEdit } from "@/features/messages/lib/useRichTextEditor";
import {
  resolveUserLabel,
  type UserProfileLookup,
} from "@/features/profile/lib/identity";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { Channel } from "@/shared/api/types";

import {
  detectGroupSlashQuery,
  groupSkillTag,
  narrowSlashChoice,
  parseGroupSkillInvocation,
  resolveSlashTarget,
  slashTokenStart,
  type GroupSlashQuery,
  type SlashListState,
  type SlashTarget,
} from "../lib/groupSlash";
import { sendAgentDmTaggedMessage } from "../lib/send";
import {
  getAgentCommands,
  getAgentCommandSearch,
  getAgentCommandsVersion,
  hasAgentCommands,
  refreshAgentCommands,
  refreshAgentCommandSearch,
  subscribeAgentCommands,
  type AgentSkillCommand,
  type AgentSlashCommand,
  type SlashAudience,
} from "../lib/slashCommands";
import {
  agentDmPeer,
  argumentHintFor,
  buildSkillMessage,
  detectSlashQuery,
  filterSlashCommands,
  MAX_SKILL_ARGS,
  parseSkillInvocation,
  slashCommandNeedsConfirm,
  slashCommandText,
} from "../lib/slashQuery";

/** An agent to pick when a channel's "/" could be for several. */
export type SlashAgentChoice = { kind: "agent"; pubkey: string; label: string };
export type SlashMenuItem = AgentSlashCommand | SlashAgentChoice;

const NO_ITEMS: SlashMenuItem[] = [];
const NO_COMMANDS: AgentSlashCommand[] = [];

type ChooseActions = {
  applyEdit: (edit: AutocompleteEdit) => void;
  submit: () => void;
};

/**
 * What a channel or thread composer tells the menu: which agents a draft
 * mentions, which agents the conversation already addresses (a thread with
 * an agent), the channel's agent members, and how to insert a real mention.
 * `isAgent` is the composer's widest "this key is an agent" signal (directory,
 * channel roles, profiles); the server decides what each agent offers.
 */
export type GroupSlashContext = {
  isAgent?: (pubkey: string) => boolean;
  agentMentionsIn: (text: string) => string[];
  addressedAgents: readonly string[];
  channelAgents: readonly string[];
  mentionEdit: (input: {
    pubkey: string;
    label: string;
    replaceFromOffset: number;
    replaceToOffset: number;
  }) => AutocompleteEdit;
};

/** Extra addressing and tags for a channel or thread send. */
export type GroupSlashSend =
  | { ok: true; addressedAgents: string[]; markerTags: string[][] }
  | { ok: false; message: string };

function agentChoiceMatches(choice: SlashAgentChoice, query: string) {
  const q = query.trim().toLowerCase();
  return !q || choice.label.toLowerCase().includes(q);
}

/** Whether an agent's group list is still loading, empty or has items. */
function groupListState(pubkey: string): SlashListState {
  if (!hasAgentCommands(pubkey, "group")) return "unknown";
  return getAgentCommands(pubkey, "group").length > 0 ? "some" : "empty";
}

function mergeCommands(
  first: readonly AgentSlashCommand[],
  second: readonly AgentSlashCommand[],
): AgentSlashCommand[] {
  const seen = new Set<string>();
  const merged: AgentSlashCommand[] = [];
  for (const command of [...first, ...second]) {
    const key = `${command.kind}:${command.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(command);
  }
  return merged;
}

/**
 * The composer's "/" menu. In a 1:1 agent DM it lists that agent's session
 * commands and skills and sends a chosen skill with its `buzz-skill` tag. In
 * a channel or thread (with `group`) the "/" may follow a mention of the
 * agent it is for; otherwise it is for the agent the conversation addresses
 * or its only agent, and with several the menu first offers them. A group
 * pick keeps its text (`@Name /skill args`), adds the tag and addresses the
 * agent; the list is the group one, so it never offers personal skills.
 */
export function useAgentSlashCommands({
  channelId,
  enabled,
  group = null,
  inThread = false,
  profiles,
}: {
  channelId: string | null;
  enabled: boolean;
  group?: GroupSlashContext | null;
  inThread?: boolean;
  profiles?: UserProfileLookup;
}) {
  const queryClient = useQueryClient();
  const selfPubkey = useIdentityQuery().data?.pubkey;
  const knownAgents = useKnownAgentPubkeys();
  const channel = useQuery<Channel[]>({
    queryKey: channelsQueryKey,
    queryFn: skipToken,
  }).data?.find((candidate) => candidate.id === channelId);
  const dmPeer = enabled
    ? agentDmPeer(
        channel,
        selfPubkey,
        (pubkey) =>
          knownAgents.has(pubkey) ||
          profiles?.[pubkey]?.isAgent === true ||
          group?.isAgent?.(pubkey) === true,
      )
    : null;
  // A thread inside a 1:1 DM has no menu: the DM send path is top-level only.
  const mode: "dm" | "group" | null = dmPeer
    ? inThread
      ? null
      : "dm"
    : enabled && group && channel && channel.channelType !== "forum"
      ? "group"
      : null;
  const audience: SlashAudience = mode === "dm" ? "private" : "group";
  const groupRef = React.useRef(group);
  groupRef.current = group;
  /** Skills picked from the menu, so a pick found by a server search (and
   * not in the cached list) is still sent as that skill. */
  const pickedSkillsRef = React.useRef(new Map<string, AgentSkillCommand>());
  /** The agent a chosen channel session command is for: its text drops the
   * mention, so the send cannot read the agent back from it. */
  const sessionTargetRef = React.useRef<{
    text: string;
    pubkey: string;
  } | null>(null);

  React.useSyncExternalStore(
    subscribeAgentCommands,
    getAgentCommandsVersion,
    getAgentCommandsVersion,
  );

  const [slashQuery, setSlashQuery] = React.useState<GroupSlashQuery | null>(
    null,
  );
  const [text, setText] = React.useState("");
  const [dismissed, setDismissed] = React.useState(false);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [pendingConfirm, setPendingConfirm] = React.useState<{
    command: AgentSlashCommand;
    edit: AutocompleteEdit;
    actions: ChooseActions;
  } | null>(null);

  /** The agent a group draft's "/" is for (see `resolveSlashTarget`). */
  const groupTargetFor = React.useCallback(
    (draft: string): SlashTarget | null => {
      const context = groupRef.current;
      if (!context) return null;
      const trimmed = draft.trimStart();
      const start = slashTokenStart(trimmed);
      const prefix = start === null ? "" : trimmed.slice(0, start);
      return narrowSlashChoice(
        resolveSlashTarget({
          hasPrefix: prefix.length > 0,
          prefixAgents: prefix ? context.agentMentionsIn(prefix) : [],
          addressedAgents: context.addressedAgents,
          channelAgents: context.channelAgents,
        }),
        groupListState,
      );
    },
    [],
  );

  const target: SlashTarget | null =
    mode === "dm" && dmPeer
      ? { kind: "agent", pubkey: dmPeer }
      : mode === "group"
        ? groupTargetFor(text)
        : null;
  const agentPubkey = target?.kind === "agent" ? target.pubkey : null;
  const listed = agentPubkey
    ? getAgentCommands(agentPubkey, audience)
    : NO_COMMANDS;
  // A list the server cut short: what is typed is searched on the server
  // too, so every skill the user may use can be found.
  const searched =
    agentPubkey && slashQuery?.query.trim()
      ? getAgentCommandSearch(agentPubkey, audience, slashQuery.query)
      : null;
  const commands = React.useMemo(
    () => (searched ? mergeCommands(searched, listed) : listed),
    [listed, searched],
  );
  /** What a send is checked against: the list, plus skills picked from a
   * search. */
  const sendable = React.useCallback(
    (list: readonly AgentSlashCommand[]) =>
      pickedSkillsRef.current.size > 0
        ? mergeCommands(list, [...pickedSkillsRef.current.values()])
        : [...list],
    [],
  );
  const labelFor = React.useCallback(
    (pubkey: string) => resolveUserLabel({ pubkey, profiles }),
    [profiles],
  );

  const suggestions = React.useMemo<SlashMenuItem[]>(() => {
    if (!slashQuery || dismissed || !target) return NO_ITEMS;
    if (target.kind === "choose") {
      const choices = target.pubkeys.map<SlashAgentChoice>((pubkey) => ({
        kind: "agent",
        pubkey,
        label: labelFor(pubkey),
      }));
      // Typing a command name before choosing keeps the agents on offer;
      // the choice then opens that agent's matches for what was typed.
      const matching = choices.filter((choice) =>
        agentChoiceMatches(choice, slashQuery.query),
      );
      return matching.length > 0 ? matching : choices;
    }
    return filterSlashCommands(commands, slashQuery.query);
  }, [commands, dismissed, labelFor, slashQuery, target]);
  const isOpen = mode !== null && suggestions.length > 0;
  const commandText =
    mode === "group" ? text.slice(slashTokenStart(text) ?? 0) : text;
  const argumentHint = agentPubkey
    ? argumentHintFor(commandText, commands)
    : null;
  /** Names the agent in a channel's menu ("Skills for @Scout"). */
  const targetLabel =
    mode === "group" && agentPubkey ? labelFor(agentPubkey) : null;

  const updateQuery = React.useCallback(
    (nextText: string, cursor: number) => {
      // Outside a menu-capable composer every setter below is a no-op bail-out.
      setText(mode ? nextText : "");
      if (!nextText.trim()) pickedSkillsRef.current.clear();
      const next: GroupSlashQuery | null =
        mode === "dm"
          ? (() => {
              const query = detectSlashQuery(nextText, cursor);
              return query ? { ...query, tokenStart: 0, prefix: "" } : null;
            })()
          : mode === "group"
            ? detectGroupSlashQuery(nextText, cursor)
            : null;
      setSlashQuery((current) =>
        current?.query === next?.query &&
        current?.tokenEnd === next?.tokenEnd &&
        current?.tokenStart === next?.tokenStart
          ? current
          : next,
      );
      setSelectedIndex(0);
      if (!next) {
        setDismissed(false);
        return;
      }
      // Lazy: the first "/" for an agent loads its commands.
      const nextTarget =
        mode === "dm" && dmPeer
          ? ({ kind: "agent", pubkey: dmPeer } as const)
          : groupTargetFor(nextText);
      if (nextTarget?.kind === "agent") {
        void refreshAgentCommands(nextTarget.pubkey, audience).then(() =>
          refreshAgentCommandSearch(nextTarget.pubkey, audience, next.query),
        );
      } else if (nextTarget?.kind === "choose") {
        // Load each candidate's list, so agents that offer nothing drop out.
        for (const pubkey of nextTarget.pubkeys) {
          void refreshAgentCommands(pubkey, "group");
        }
      }
    },
    [audience, dmPeer, groupTargetFor, mode],
  );

  const handleKeyDown = React.useCallback(
    (
      event: React.KeyboardEvent,
    ): { handled: boolean; choice?: SlashMenuItem } => {
      if (!isOpen) return { handled: false };
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSelectedIndex(
          (current) =>
            (current + step + suggestions.length) % suggestions.length,
        );
        return { handled: true };
      }
      if (
        (event.key === "Tab" && !event.shiftKey) ||
        (event.key === "Enter" &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.shiftKey)
      ) {
        event.preventDefault();
        return { handled: true, choice: suggestions[selectedIndex] };
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return { handled: true };
      }
      return { handled: false };
    },
    [isOpen, selectedIndex, suggestions],
  );

  /**
   * Put the chosen item in the composer. An agent choice inserts its mention
   * and reopens the menu for it. A session command is then sent as the plain
   * message it has always been (`/new` only after the person confirms; in a
   * channel without the mention, so the server reads it as the command); a
   * skill waits for arguments, after the agent's mention in a channel.
   */
  const choose = React.useCallback(
    (item: SlashMenuItem, actions: ChooseActions) => {
      const query = slashQuery;
      setSlashQuery(null);
      setSelectedIndex(0);
      if (!query) return;
      const context = groupRef.current;
      if (item.kind === "agent") {
        if (!context) return;
        const edit = context.mentionEdit({
          pubkey: item.pubkey,
          label: item.label,
          replaceFromOffset: 0,
          replaceToOffset: query.tokenEnd,
        });
        // Keep what was typed after "/": the agent's menu opens on it.
        actions.applyEdit({
          ...edit,
          insertText: `${edit.insertText}/${query.query}`,
        });
        void refreshAgentCommands(item.pubkey, "group");
        return;
      }
      if (item.kind === "skill") {
        pickedSkillsRef.current.set(item.name, item);
      }
      let edit: AutocompleteEdit = {
        replaceFromOffset: mode === "group" ? 0 : query.tokenStart,
        replaceToOffset: query.tokenEnd,
        insertText: slashCommandText(item),
      };
      if (mode === "group" && item.kind === "session" && agentPubkey) {
        sessionTargetRef.current = {
          text: slashCommandText(item),
          pubkey: agentPubkey,
        };
      }
      if (mode === "group" && item.kind === "skill") {
        if (query.prefix) {
          edit = { ...edit, replaceFromOffset: query.tokenStart };
        } else if (context && agentPubkey) {
          const mention = context.mentionEdit({
            pubkey: agentPubkey,
            label: labelFor(agentPubkey),
            replaceFromOffset: 0,
            replaceToOffset: query.tokenEnd,
          });
          edit = {
            ...mention,
            insertText: `${mention.insertText}${slashCommandText(item)}`,
          };
        }
      }
      if (slashCommandNeedsConfirm(item)) {
        setPendingConfirm({ command: item, edit, actions });
        return;
      }
      actions.applyEdit(edit);
      if (item.kind === "session") actions.submit();
    },
    [agentPubkey, labelFor, mode, slashQuery],
  );

  const confirmPending = React.useCallback(() => {
    if (!pendingConfirm) return;
    setPendingConfirm(null);
    pendingConfirm.actions.applyEdit(pendingConfirm.edit);
    if (pendingConfirm.command.kind === "session") {
      pendingConfirm.actions.submit();
    }
  }, [pendingConfirm]);

  const cancelPending = React.useCallback(() => {
    setPendingConfirm(null);
    setDismissed(true);
  }, []);

  /**
   * Send the composer text as a skill invocation when it starts with a
   * listed skill. Returns true when it handled the send (sent, or refused
   * with a visible reason); false sends the text as an ordinary message.
   * 1:1 DM only; a channel or thread send uses `groupSend`.
   */
  const sendSkillIfInvoked = React.useCallback(
    async (plainText: string, onSent: () => void): Promise<boolean> => {
      if (mode !== "dm" || !dmPeer || !channelId) return false;
      const invocation = parseSkillInvocation(plainText, sendable(commands));
      if (!invocation) return false;
      const message = buildSkillMessage(invocation);
      if (!message.ok) {
        toast.error(
          `Skill arguments can be at most ${MAX_SKILL_ARGS.toLocaleString()} characters.`,
        );
        return true;
      }
      try {
        await sendAgentDmTaggedMessage({
          queryClient,
          channelId,
          senderPubkey: selfPubkey,
          content: message.content,
          markerTags: message.tags,
        });
        pickedSkillsRef.current.clear();
        onSent();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to send the skill.",
        );
      }
      return true;
    },
    [channelId, commands, dmPeer, mode, queryClient, selfPubkey, sendable],
  );

  /**
   * For a channel or thread send: a listed skill (`[@Name ]/skill args`)
   * adds its `buzz-skill` tag; a listed session command (`/new`) is kept as
   * its plain text. Either addresses the target agent. Null for anything
   * else, which sends as an ordinary message.
   */
  const groupSend = React.useCallback(
    (plainText: string): GroupSlashSend | null => {
      if (mode !== "group") return null;
      const trimmed = plainText.trim();
      const chosenSession = sessionTargetRef.current;
      sessionTargetRef.current = null;
      const sendTarget: SlashTarget | null =
        chosenSession && chosenSession.text === trimmed
          ? { kind: "agent", pubkey: chosenSession.pubkey }
          : groupTargetFor(plainText);
      if (sendTarget?.kind !== "agent") return null;
      const listed = sendable(getAgentCommands(sendTarget.pubkey, "group"));
      const invocation = parseGroupSkillInvocation(plainText, listed);
      if (invocation) {
        const tag = groupSkillTag(invocation);
        return tag
          ? {
              ok: true,
              addressedAgents: [sendTarget.pubkey],
              markerTags: [tag],
            }
          : {
              ok: false,
              message: `Skill arguments can be at most ${MAX_SKILL_ARGS.toLocaleString()} characters.`,
            };
      }
      const session = listed.find(
        (command) =>
          command.kind === "session" && trimmed === `/${command.name}`,
      );
      return session
        ? { ok: true, addressedAgents: [sendTarget.pubkey], markerTags: [] }
        : null;
    },
    [groupTargetFor, mode, sendable],
  );

  return {
    argumentHint,
    cancelPending,
    choose,
    confirmPending,
    pendingConfirm: pendingConfirm?.command ?? null,
    groupSend,
    handleKeyDown,
    isOpen,
    mode,
    selectedIndex,
    sendSkillIfInvoked,
    suggestions,
    targetLabel,
    updateQuery,
  };
}

export type UseAgentSlashCommandsResult = ReturnType<
  typeof useAgentSlashCommands
>;

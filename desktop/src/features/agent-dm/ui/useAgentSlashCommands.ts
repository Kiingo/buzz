import * as React from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useKnownAgentPubkeys } from "@/features/agents/useKnownAgentPubkeys";
import { channelsQueryKey } from "@/features/channels/hooks";
import type { AutocompleteEdit } from "@/features/messages/lib/useRichTextEditor";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { Channel } from "@/shared/api/types";

import { sendAgentDmTaggedMessage } from "../lib/send";
import {
  getAgentCommands,
  getAgentCommandsVersion,
  refreshAgentCommands,
  subscribeAgentCommands,
  type AgentSlashCommand,
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
  type SlashQuery,
} from "../lib/slashQuery";

const NO_COMMANDS: AgentSlashCommand[] = [];

type ChooseActions = {
  applyEdit: (edit: AutocompleteEdit) => void;
  submit: () => void;
};

function applyChoice(
  command: AgentSlashCommand,
  tokenEnd: number,
  actions: ChooseActions,
) {
  actions.applyEdit({
    replaceFromOffset: 0,
    replaceToOffset: tokenEnd,
    insertText: slashCommandText(command),
  });
  if (command.kind === "session") actions.submit();
}

/**
 * The DM composer's "/" menu for an agent DM: lists the agent's session
 * commands and skills while the composer starts with "/", and sends a
 * chosen skill with its `buzz-skill` tag.
 */
export function useAgentSlashCommands({
  channelId,
  enabled,
  profiles,
}: {
  channelId: string | null;
  enabled: boolean;
  profiles?: UserProfileLookup;
}) {
  const queryClient = useQueryClient();
  const selfPubkey = useIdentityQuery().data?.pubkey;
  const knownAgents = useKnownAgentPubkeys();
  const channel = useQuery<Channel[]>({
    queryKey: channelsQueryKey,
    queryFn: skipToken,
  }).data?.find((candidate) => candidate.id === channelId);
  const agentPubkey = enabled
    ? agentDmPeer(
        channel,
        selfPubkey,
        (pubkey) =>
          knownAgents.has(pubkey) || profiles?.[pubkey]?.isAgent === true,
      )
    : null;

  React.useSyncExternalStore(
    subscribeAgentCommands,
    getAgentCommandsVersion,
    getAgentCommandsVersion,
  );
  const commands = agentPubkey ? getAgentCommands(agentPubkey) : NO_COMMANDS;

  const [slashQuery, setSlashQuery] = React.useState<SlashQuery | null>(null);
  const [text, setText] = React.useState("");
  const [dismissed, setDismissed] = React.useState(false);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [pendingConfirm, setPendingConfirm] = React.useState<{
    command: AgentSlashCommand;
    tokenEnd: number;
    actions: ChooseActions;
  } | null>(null);

  const suggestions = React.useMemo(
    () =>
      slashQuery && !dismissed
        ? filterSlashCommands(commands, slashQuery.query)
        : NO_COMMANDS,
    [commands, dismissed, slashQuery],
  );
  const isOpen = agentPubkey !== null && suggestions.length > 0;
  const argumentHint = agentPubkey ? argumentHintFor(text, commands) : null;

  const updateQuery = React.useCallback(
    (nextText: string, cursor: number) => {
      // Outside an agent DM every setter below is a no-op bail-out.
      setText(agentPubkey ? nextText : "");
      const next = agentPubkey ? detectSlashQuery(nextText, cursor) : null;
      setSlashQuery((current) =>
        current?.query === next?.query && current?.tokenEnd === next?.tokenEnd
          ? current
          : next,
      );
      setSelectedIndex(0);
      if (!next) {
        setDismissed(false);
        return;
      }
      // Lazy: the first "/" for this agent loads its commands.
      if (agentPubkey) void refreshAgentCommands(agentPubkey);
    },
    [agentPubkey],
  );

  const handleKeyDown = React.useCallback(
    (
      event: React.KeyboardEvent,
    ): { handled: boolean; choice?: AgentSlashCommand } => {
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
   * Put the chosen command in the composer. A session command is then sent
   * as the plain message it has always been (`/new` only after the person
   * confirms); a skill waits for arguments.
   */
  const choose = React.useCallback(
    (command: AgentSlashCommand, actions: ChooseActions) => {
      const tokenEnd = slashQuery?.tokenEnd ?? 0;
      setSlashQuery(null);
      setSelectedIndex(0);
      if (slashCommandNeedsConfirm(command)) {
        setPendingConfirm({ command, tokenEnd, actions });
        return;
      }
      applyChoice(command, tokenEnd, actions);
    },
    [slashQuery],
  );

  const confirmPending = React.useCallback(() => {
    if (!pendingConfirm) return;
    setPendingConfirm(null);
    applyChoice(
      pendingConfirm.command,
      pendingConfirm.tokenEnd,
      pendingConfirm.actions,
    );
  }, [pendingConfirm]);

  const cancelPending = React.useCallback(() => {
    setPendingConfirm(null);
    setDismissed(true);
  }, []);

  /**
   * Send the composer text as a skill invocation when it starts with a
   * listed skill. Returns true when it handled the send (sent, or refused
   * with a visible reason); false sends the text as an ordinary message.
   */
  const sendSkillIfInvoked = React.useCallback(
    async (plainText: string, onSent: () => void): Promise<boolean> => {
      if (!agentPubkey || !channelId) return false;
      const invocation = parseSkillInvocation(plainText, commands);
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
        onSent();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to send the skill.",
        );
      }
      return true;
    },
    [agentPubkey, channelId, commands, queryClient, selfPubkey],
  );

  return {
    argumentHint,
    cancelPending,
    choose,
    confirmPending,
    pendingConfirm: pendingConfirm?.command ?? null,
    handleKeyDown,
    isOpen,
    selectedIndex,
    sendSkillIfInvoked,
    suggestions,
    updateQuery,
  };
}

export type UseAgentSlashCommandsResult = ReturnType<
  typeof useAgentSlashCommands
>;

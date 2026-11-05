import * as React from "react";

import { KIND_SYSTEM_MESSAGE } from "@/shared/constants/kinds";
import type { TimelineMessage } from "@/features/messages/types";

import { delegationDmAgent } from "../lib/delegations";
import { sentPrompts } from "../lib/promptRecall";

/**
 * What the reader sent in their 1:1 DM with an agent, for the composer's ↑ ↓
 * and Ctrl-R. Undefined anywhere else, where ↑ keeps its usual meaning.
 */
export function usePromptHistory(
  channel: Parameters<typeof delegationDmAgent>[0],
  agentPubkeys: ReadonlySet<string> | undefined,
  currentPubkey: string | null | undefined,
  entries: readonly { message: TimelineMessage }[],
): readonly string[] | undefined {
  const agent = delegationDmAgent(channel, currentPubkey);
  const isAgent =
    agent !== null &&
    [...(agentPubkeys ?? [])].some((key) => key.toLowerCase() === agent);
  return React.useMemo(
    () =>
      isAgent && currentPubkey
        ? sentPrompts(
            entries.map((entry) => entry.message),
            currentPubkey,
            KIND_SYSTEM_MESSAGE,
          )
        : undefined,
    [currentPubkey, entries, isAgent],
  );
}

import { skipToken, useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";

import { channelsQueryKey } from "@/features/channels/hooks";
import {
  type ProfileField,
  ProfileFieldRows,
  ProfileSectionGroup,
} from "@/features/profile/ui/UserProfilePanelFields";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { Channel } from "@/shared/api/types";

import {
  agentSummaryRows,
  hasAgentDm,
  useAgentSummary,
} from "../lib/agentSummary";

/**
 * The "Agent" section of an agent's profile panel for someone with a 1:1 DM
 * with it: what it runs on, for you, where, your session, owner, skills and
 * tools, plus an "Edit agent" link when the server offers one. Renders
 * nothing while loading or after any failure, so the panel never waits on it.
 */
export function AgentSummarySection({ agentPubkey }: { agentPubkey: string }) {
  const selfPubkey = useIdentityQuery().data?.pubkey;
  const channels =
    useQuery<Channel[]>({ queryKey: channelsQueryKey, queryFn: skipToken })
      .data ?? [];
  const eligible = hasAgentDm(channels, selfPubkey, agentPubkey);
  const summary = useAgentSummary(eligible ? agentPubkey : null);
  if (!summary) return null;

  const fields: ProfileField[] = agentSummaryRows(summary).map((row) => ({
    label: row.label,
    displayValue: row.value,
    testId: `agent-summary-${row.label.toLowerCase().replace(/\s+/g, "-")}`,
  }));
  const editUrl = summary.editUrl;
  if (editUrl) {
    fields.push({
      label: "Edit agent",
      displayValue: "Opens in your browser",
      onClick: () => {
        void openUrl(editUrl).catch(() => {});
      },
      testId: "agent-summary-edit",
    });
  }
  return (
    <ProfileSectionGroup testId="agent-summary-section" title="Agent">
      <ProfileFieldRows fields={fields} />
    </ProfileSectionGroup>
  );
}

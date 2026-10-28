import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
  describeAgentVoiceSettingsError,
  getAgentVoiceSettings,
  setAgentVoiceDefault,
  setAgentVoiceOverride,
} from "../lib/agentCallApi";
import type { VoiceProviderId, VoiceSettings } from "../lib/voice-stream";

const KEY = "agent-voice-settings";

/**
 * The caller's voice settings for one agent (voice-provider-neutral §9.1),
 * cached 60 s like the host's availability read. Null while loading, when
 * disabled, or from a host without the route (then there's no chooser).
 */
export function useAgentVoiceSettings(agentPubkey: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const query = useQuery({
    queryKey: [KEY, agentPubkey],
    queryFn: () => getAgentVoiceSettings(agentPubkey),
    enabled,
    staleTime: 60_000,
    retry: 1,
  });
  const settings = enabled ? (query.data ?? null) : null;

  const write = async (run: () => Promise<VoiceSettings | null>) => {
    setSaving(true);
    setNotice(null);
    try {
      const next = await run();
      // The default write answers without this agent's `effective`.
      if (next?.effective) {
        queryClient.setQueryData([KEY, agentPubkey], next);
      }
    } catch (error) {
      setNotice(describeAgentVoiceSettingsError(error));
    } finally {
      await queryClient.invalidateQueries({ queryKey: [KEY] });
      setSaving(false);
    }
  };

  return {
    settings,
    saving,
    notice,
    clearNotice: () => setNotice(null),
    /** "Always use … for <agent>"; the checked one again clears it. */
    setAgentProvider: (provider: VoiceProviderId | null) => {
      const agentId = settings?.effective?.agentId;
      if (!agentId) return Promise.resolve();
      return write(() =>
        setAgentVoiceOverride(
          agentId,
          provider,
          settings?.effective?.revision ?? 0,
        ),
      );
    },
    /** "Make … my default"; the checked one again clears it. */
    setDefaultProvider: (provider: VoiceProviderId | null) =>
      write(() => setAgentVoiceDefault(provider, settings?.revision ?? 0)),
  };
}

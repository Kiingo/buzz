import { Check, Phone } from "lucide-react";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useKnownAgentPubkeys } from "@/features/agents/useKnownAgentPubkeys";
import type { Channel } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";

import {
  agentCallController,
  canRunAgentCallStream,
} from "../lib/agentCallController";
import {
  type VoiceProviderId,
  voiceAgentOverride,
  voiceProviderUnavailableSentence,
} from "../lib/voice-stream";
import { useAgentCall } from "./useAgentCall";
import { useAgentVoiceSettings } from "./useAgentVoiceSettings";

/**
 * "Call <agent>" in a 1:1 agent DM header: a proper voice call with the
 * agent (its host's voice core), not a huddle. The host checks that this is
 * the caller's own private DM with the agent before it answers.
 *
 * Only hosted agents take calls: an agent this app runs locally (a managed
 * agent on this device) has no voice host, so it gets no Call button. The
 * host stays the authority for everything else and refuses with a reason.
 */
export function AgentCallButton({
  agentName,
  agentPubkey,
  channel,
  isAgentHint,
}: {
  agentName: string;
  agentPubkey: string;
  channel: Channel;
  isAgentHint: boolean;
}) {
  const knownAgents = useKnownAgentPubkeys();
  const managedAgents = useManagedAgentsQuery();
  const call = useAgentCall();
  const key = normalizePubkey(agentPubkey);
  // The voice chooser is macOS only: Gemini's stream doesn't run elsewhere
  // (Windows is frozen).
  const chooserPlatform = canRunAgentCallStream();
  const isAgent = isAgentHint || knownAgents.has(key);
  // Wait for the local inventory so the button never flashes for a local
  // agent; a failed inventory read still shows it (the host decides).
  const runsOnThisDevice =
    managedAgents.isPending ||
    (managedAgents.data ?? []).some(
      (agent) => normalizePubkey(agent.pubkey) === key,
    );
  const showsButton =
    channel.channelType === "dm" && isAgent && !runsOnThisDevice;
  const voice = useAgentVoiceSettings(key, chooserPlatform && showsButton);
  if (!showsButton) {
    return null;
  }

  const busy =
    call.phase === "requesting_mic" ||
    call.phase === "connecting" ||
    call.phase === "live" ||
    call.phase === "ending";
  const withThisAgent = busy && call.agentPubkey === key;
  const label = withThisAgent
    ? `On a call with ${agentName}`
    : busy
      ? "You're already on a call"
      : `Call ${agentName}`;

  const settings = voice.settings;
  const place = (provider: VoiceProviderId | null) => {
    void agentCallController.start({
      agentPubkey: key,
      channelId: channel.id,
      agentName,
      provider,
      expectedProvider: settings?.effective?.provider ?? null,
    });
  };
  const chooser = Boolean(settings && settings.providers.length > 1);
  const button = (
    <Button
      aria-label={label}
      disabled={busy}
      onClick={() => place(null)}
      size="icon"
      title={
        chooser && !busy ? `${label} (right-click to choose the voice)` : label
      }
      type="button"
      variant={withThisAgent ? "secondary" : "outline"}
    >
      <Phone />
    </Button>
  );
  if (!settings || !chooser || busy) {
    return button;
  }
  const override = settings.effective
    ? voiceAgentOverride(settings, settings.effective.agentId)
    : null;
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) voice.clearNotice();
      }}
    >
      <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
      <ContextMenuContent aria-label={`Call ${agentName}`} className="w-72">
        {settings.providers.map((option) => (
          <ContextMenuItem
            disabled={!option.available}
            key={`call-${option.id}`}
            onSelect={() => place(option.id)}
          >
            <Phone />
            <span className="min-w-0">
              <span className="block">Call with {option.label}</span>
              {option.available ? null : (
                <span className="block text-xs text-muted-foreground">
                  {voiceProviderUnavailableSentence(
                    option.unavailableReason,
                    option.label,
                  )}
                </span>
              )}
            </span>
          </ContextMenuItem>
        ))}
        {settings.effective ? (
          <>
            <ContextMenuSeparator />
            {settings.providers.map((option) => (
              <ContextMenuItem
                disabled={voice.saving}
                key={`always-${option.id}`}
                onSelect={() =>
                  void voice.setAgentProvider(
                    override === option.id ? null : option.id,
                  )
                }
              >
                <CheckSlot checked={override === option.id} />
                Always use {option.label} for {agentName}
              </ContextMenuItem>
            ))}
          </>
        ) : null}
        <ContextMenuSeparator />
        {settings.providers.map((option) => (
          <ContextMenuItem
            disabled={voice.saving}
            key={`default-${option.id}`}
            onSelect={() =>
              void voice.setDefaultProvider(
                settings.userDefault === option.id ? null : option.id,
              )
            }
          >
            <CheckSlot checked={settings.userDefault === option.id} />
            Make {option.label} my default
          </ContextMenuItem>
        ))}
        {voice.notice ? (
          <p
            className="px-2 py-1.5 text-xs text-muted-foreground"
            role="status"
          >
            {voice.notice}
          </p>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CheckSlot({ checked }: { checked: boolean }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {checked ? <Check aria-label="Selected" /> : null}
    </span>
  );
}

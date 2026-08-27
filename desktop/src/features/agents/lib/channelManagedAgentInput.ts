import type {
  AcpRuntime,
  CreateManagedAgentInput,
  ManagedAgentBackend,
  RespondToMode,
} from "@/shared/api/types";

import { buildProviderOwnedInstanceInput } from "./providerOwnedInstanceInput";
import { resolveManagedAgentAvatarUrl } from "../ui/managedAgentAvatar";

type ChannelAgentRuntime = Pick<
  AcpRuntime,
  "id" | "label" | "command" | "defaultArgs" | "mcpCommand"
>;

export type ChannelManagedAgentCreateInput = {
  runtime?: ChannelAgentRuntime;
  name: string;
  systemPrompt?: string;
  avatarUrl?: string;
  personaId?: string | null;
  teamId?: string | null;
  harnessOverride?: boolean;
  model?: string;
  backend?: ManagedAgentBackend;
  respondTo?: RespondToMode;
  respondToAllowlist?: string[];
};

/**
 * Build the provider-neutral instance projection used by channel, team,
 * template, and mention placement. A provider that owns the execution profile
 * receives no desktop runtime, model, or provider fields. Local placement keeps
 * the upstream ACP projection and requires an installed runtime.
 */
export async function buildChannelManagedAgentCreateInput(
  input: ChannelManagedAgentCreateInput,
): Promise<CreateManagedAgentInput> {
  const trimmedName = input.name.trim();
  if (input.backend?.type === "provider") {
    const providerInput = await buildProviderOwnedInstanceInput(
      {
        id: input.personaId ?? undefined,
        displayName: trimmedName,
        systemPrompt: input.systemPrompt?.trim() ?? "",
        avatarUrl: input.avatarUrl,
      },
      {
        type: "provider",
        id: input.backend.id,
        config: input.backend.config,
      },
    );
    return {
      ...providerInput,
      teamId: input.teamId ?? undefined,
      respondTo: input.respondTo,
      respondToAllowlist: input.respondToAllowlist,
    };
  }

  if (!input.runtime) {
    throw new Error(
      "Choose where this agent runs, or install a local agent runtime.",
    );
  }

  const resolvedAvatarUrl = await resolveManagedAgentAvatarUrl(input.avatarUrl);
  return {
    name: trimmedName,
    acpCommand: "buzz-acp",
    agentCommand: input.runtime.command,
    harnessOverride: input.harnessOverride ?? false,
    agentArgs: [],
    mcpCommand: input.runtime.mcpCommand ?? "",
    personaId: input.personaId ?? undefined,
    teamId: input.teamId ?? undefined,
    systemPrompt: input.systemPrompt?.trim() || undefined,
    avatarUrl: resolvedAvatarUrl,
    model: input.model?.trim() || undefined,
    spawnAfterCreate: false,
    backend: { type: "local" },
    respondTo: input.respondTo,
    respondToAllowlist: input.respondToAllowlist,
  };
}

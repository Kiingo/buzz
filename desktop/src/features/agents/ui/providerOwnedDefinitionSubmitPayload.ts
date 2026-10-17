import type { CreatePersonaInput } from "@/shared/api/types";
import { buildRuntimeModelProviderPayload } from "./agentDefinitionSubmitPayload";
import { parsePersonaNamePoolText } from "./personaDialogState";

/** Build a definition without leaking desktop execution fields to a provider. */
export function buildAgentDefinitionSubmitPayload({
  acpCommand,
  avatarUrl,
  behavior,
  description,
  displayName,
  envVars,
  execution,
  namePoolText,
  preserveEmptyNamePool,
  providerOwnsExecutionProfile,
  systemPrompt,
}: {
  /** The ACP transport command; a provider-owned profile never carries one. */
  acpCommand?: string;
  avatarUrl: string;
  behavior: CreatePersonaInput["behavior"];
  /** Public description draft; empty string → null in the API wrapper. */
  description?: string | null;
  displayName: string;
  envVars: Record<string, string>;
  execution: Parameters<typeof buildRuntimeModelProviderPayload>[0];
  namePoolText: string;
  preserveEmptyNamePool: boolean;
  providerOwnsExecutionProfile: boolean;
  systemPrompt: string;
}): CreatePersonaInput {
  const executionFields = providerOwnsExecutionProfile
    ? { runtime: undefined, model: undefined, provider: undefined }
    : buildRuntimeModelProviderPayload(execution);
  const namePool = parsePersonaNamePoolText(namePoolText);
  return {
    displayName: displayName.trim(),
    description,
    avatarUrl: avatarUrl.trim() || undefined,
    systemPrompt,
    acpCommand: providerOwnsExecutionProfile
      ? undefined
      : acpCommand?.trim() || "buzz-acp",
    ...executionFields,
    namePool:
      namePool.length > 0 ? namePool : preserveEmptyNamePool ? [] : undefined,
    envVars: providerOwnsExecutionProfile ? {} : envVars,
    behavior,
  };
}

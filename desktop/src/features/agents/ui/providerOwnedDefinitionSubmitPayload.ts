import type { CreatePersonaInput } from "@/shared/api/types";
import { buildRuntimeModelProviderPayload } from "./agentDefinitionSubmitPayload";
import { parsePersonaNamePoolText } from "./personaDialogState";

/** Build a definition without leaking desktop execution fields to a provider. */
export function buildAgentDefinitionSubmitPayload({
  avatarUrl,
  behavior,
  displayName,
  envVars,
  execution,
  namePoolText,
  preserveEmptyNamePool,
  providerOwnsExecutionProfile,
  systemPrompt,
}: {
  avatarUrl: string;
  behavior: CreatePersonaInput["behavior"];
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
    avatarUrl: avatarUrl.trim() || undefined,
    systemPrompt,
    ...executionFields,
    namePool:
      namePool.length > 0 ? namePool : preserveEmptyNamePool ? [] : undefined,
    envVars: providerOwnsExecutionProfile ? {} : envVars,
    behavior,
  };
}

import type { CreatePersonaInput } from "@/shared/api/types";
import { runtimeSupportsLlmProviderSelection } from "./agentConfigOptions";
import { parsePersonaNamePoolText } from "./personaDialogState";

/**
 * Pure helper extracted from the `handleSubmit` path of `AgentDefinitionDialog`
 * so the payload logic can be unit-tested without rendering the component.
 *
 * Computes the `runtime`, `model`, and `provider` fields for the definition
 * submit payload, resolving auto-seeded builtin-edit semantics: when the
 * runtime was auto-seeded (the user never explicitly chose one), it is omitted
 * from the payload, and model/provider edits are still persisted via the
 * `modelProviderEditableWithoutRuntime` path.
 */
export function buildRuntimeModelProviderPayload({
  runtime,
  model,
  provider,
  isEditMode,
  isAutoSeeded,
  initialPreviousRuntime,
  initialModel,
  initialProvider,
  initialModelProviderEditableWithoutRuntime,
  providerOwnsExecutionProfile = false,
}: {
  runtime: string;
  model: string;
  provider: string;
  isEditMode: boolean;
  isAutoSeeded: boolean;
  initialPreviousRuntime: string;
  initialModel: string | null | undefined;
  initialProvider: string | null | undefined;
  initialModelProviderEditableWithoutRuntime: boolean;
  providerOwnsExecutionProfile?: boolean;
}): {
  runtime: string | undefined;
  model: string | undefined;
  provider: string | undefined;
} {
  if (providerOwnsExecutionProfile) {
    return { runtime: undefined, model: undefined, provider: undefined };
  }
  const trimmedRuntime = runtime.trim();
  const previousRuntime = initialPreviousRuntime;
  const isAutoSeededRuntimeForBuiltinEdit =
    isEditMode && previousRuntime.length === 0 && isAutoSeeded;
  const runtimeForSubmit = isAutoSeededRuntimeForBuiltinEdit
    ? ""
    : trimmedRuntime;
  // An auto-seeded builtin edit is treated the same as an existing builtin with
  // a saved model/provider: the field is editable without a runtime, and the
  // user's model/provider choice is persisted in the payload.
  const modelProviderEditableWithoutRuntime =
    (initialModelProviderEditableWithoutRuntime ||
      isAutoSeededRuntimeForBuiltinEdit) &&
    runtimeForSubmit.length === 0;
  const llmProviderVisibleForSubmit =
    (runtimeForSubmit.length > 0 &&
      runtimeSupportsLlmProviderSelection(runtimeForSubmit)) ||
    modelProviderEditableWithoutRuntime;
  const shouldPreserveHiddenModelProvider =
    isEditMode &&
    previousRuntime.length === 0 &&
    runtimeForSubmit.length === 0 &&
    !modelProviderEditableWithoutRuntime;
  return {
    runtime: runtimeForSubmit || undefined,
    model:
      runtimeForSubmit || modelProviderEditableWithoutRuntime
        ? model.trim() || undefined
        : shouldPreserveHiddenModelProvider
          ? (initialModel ?? undefined)
          : undefined,
    provider: llmProviderVisibleForSubmit
      ? provider.trim() || undefined
      : shouldPreserveHiddenModelProvider
        ? (initialProvider ?? undefined)
        : undefined,
  };
}

/** Build the definition payload without leaking provider-owned desktop state. */
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
  const { runtime, model, provider } =
    buildRuntimeModelProviderPayload(execution);
  const namePool = parsePersonaNamePoolText(namePoolText);
  return {
    displayName: displayName.trim(),
    avatarUrl: avatarUrl.trim() || undefined,
    systemPrompt,
    runtime,
    model,
    provider,
    namePool:
      namePool.length > 0 ? namePool : preserveEmptyNamePool ? [] : undefined,
    envVars: providerOwnsExecutionProfile ? {} : envVars,
    behavior,
  };
}

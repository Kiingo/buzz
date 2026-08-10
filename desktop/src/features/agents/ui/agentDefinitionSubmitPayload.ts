import type {
  CreatePersonaInput,
  UpdatePersonaInput,
} from "@/shared/api/types";
import { runtimeSupportsLlmProviderSelection } from "./agentConfigOptions";

function sameStringRecord(
  left: Record<string, string> | undefined,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const rightEntries = Object.entries(right).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value,
    )
  );
}

/**
 * Allows an unrelated definition edit to preserve a legacy execution
 * configuration even when that existing configuration is not currently
 * ready. A display-only auto-seeded runtime still represents an unchanged
 * null runtime. Explicit runtime/model/provider/env changes continue through
 * the normal readiness gate.
 */
export function preservesUnchangedEditConfiguration({
  currentEnvVars,
  currentModel,
  currentProvider,
  currentRuntime,
  initialEnvVars,
  initialModel,
  initialRuntime,
  initialProvider,
  isAutoSeeded,
  isEditMode,
}: {
  currentEnvVars: Record<string, string>;
  currentModel: string;
  currentProvider: string;
  currentRuntime: string;
  initialEnvVars: Record<string, string> | undefined;
  initialModel: string | null | undefined;
  initialRuntime: string | null | undefined;
  initialProvider: string | null | undefined;
  isAutoSeeded: boolean;
  isEditMode: boolean;
}): boolean {
  const savedRuntime = initialRuntime ?? "";
  const runtimeIsUnchanged = isAutoSeeded
    ? savedRuntime.trim().length === 0
    : currentRuntime === savedRuntime;

  return (
    isEditMode &&
    runtimeIsUnchanged &&
    currentModel === (initialModel ?? "") &&
    currentProvider === (initialProvider ?? "") &&
    sameStringRecord(initialEnvVars, currentEnvVars)
  );
}

export function canPreserveUnchangedEdit(
  initialValues: CreatePersonaInput | UpdatePersonaInput | null,
  current: {
    envVars: Record<string, string>;
    model: string;
    provider: string;
    runtime: string;
  },
  isAutoSeeded: boolean,
): boolean {
  return (
    initialValues != null &&
    "id" in initialValues &&
    preservesUnchangedEditConfiguration({
      currentEnvVars: current.envVars,
      currentModel: current.model,
      currentProvider: current.provider,
      currentRuntime: current.runtime,
      initialEnvVars: initialValues.envVars,
      initialModel: initialValues.model,
      initialRuntime: initialValues.runtime,
      initialProvider: initialValues.provider,
      isAutoSeeded,
      isEditMode: true,
    })
  );
}

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
}): {
  runtime: string | undefined;
  model: string | undefined;
  provider: string | undefined;
} {
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

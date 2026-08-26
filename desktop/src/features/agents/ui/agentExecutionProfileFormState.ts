import { runtimeSupportsLlmProviderSelection } from "./agentConfigOptions";

/** Generic visibility/readiness projection for provider-owned create forms. */
export function agentExecutionProfileFormState({
  blankRuntimeModelProviderEditable,
  isCreateMode,
  providerOwnsExecutionProfile,
  runtime,
  selectedRuntimeIsAvailable,
}: {
  blankRuntimeModelProviderEditable: boolean;
  isCreateMode: boolean;
  providerOwnsExecutionProfile: boolean;
  runtime: string;
  selectedRuntimeIsAvailable: boolean;
}) {
  const showDesktopExecutionProfile = !providerOwnsExecutionProfile;
  const runtimeCanChooseLlmProvider =
    showDesktopExecutionProfile &&
    (runtimeSupportsLlmProviderSelection(runtime) ||
      blankRuntimeModelProviderEditable);
  return {
    createRuntimeReady:
      !isCreateMode ||
      providerOwnsExecutionProfile ||
      (runtime.trim().length > 0 && selectedRuntimeIsAvailable),
    modelFieldVisible:
      showDesktopExecutionProfile &&
      (runtime.trim().length > 0 || blankRuntimeModelProviderEditable),
    runtimeCanChooseLlmProvider,
    showDesktopExecutionProfile,
  };
}

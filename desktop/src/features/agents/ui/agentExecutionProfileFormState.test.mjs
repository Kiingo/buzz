import assert from "node:assert/strict";
import test from "node:test";

import { agentExecutionProfileFormState } from "./agentExecutionProfileFormState.ts";

test("provider-owned create hides and bypasses only desktop execution", () => {
  assert.deepEqual(
    agentExecutionProfileFormState({
      blankRuntimeModelProviderEditable: false,
      isCreateMode: true,
      providerOwnsExecutionProfile: true,
      runtime: "",
      selectedRuntimeIsAvailable: false,
    }),
    {
      createRuntimeReady: true,
      modelFieldVisible: false,
      runtimeCanChooseLlmProvider: false,
      showDesktopExecutionProfile: false,
    },
  );
});

test("local and non-owning create retain runtime readiness", () => {
  const local = agentExecutionProfileFormState({
    blankRuntimeModelProviderEditable: false,
    isCreateMode: true,
    providerOwnsExecutionProfile: false,
    runtime: "buzz-agent",
    selectedRuntimeIsAvailable: true,
  });
  assert.equal(local.createRuntimeReady, true);
  assert.equal(local.modelFieldVisible, true);
  assert.equal(local.runtimeCanChooseLlmProvider, true);
  assert.equal(local.showDesktopExecutionProfile, true);

  assert.equal(
    agentExecutionProfileFormState({
      blankRuntimeModelProviderEditable: false,
      isCreateMode: true,
      providerOwnsExecutionProfile: false,
      runtime: "",
      selectedRuntimeIsAvailable: false,
    }).createRuntimeReady,
    false,
  );
});

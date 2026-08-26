import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentDefinitionSubmitPayload,
  buildRuntimeModelProviderPayload,
} from "./agentDefinitionSubmitPayload.ts";

// Shared fixture for a builtin edit: previous runtime null, no saved model/provider.
const BUILTIN_EDIT_BASE = {
  isEditMode: true,
  initialPreviousRuntime: "",
  initialModel: null,
  initialProvider: null,
  initialModelProviderEditableWithoutRuntime: false,
};

test("provider-owned execution strips every desktop execution field", () => {
  assert.deepEqual(
    buildRuntimeModelProviderPayload({
      ...BUILTIN_EDIT_BASE,
      runtime: "buzz-agent",
      model: "auto",
      provider: "relay-mesh",
      isAutoSeeded: false,
      providerOwnsExecutionProfile: true,
    }),
    { runtime: undefined, model: undefined, provider: undefined },
  );
});

test("provider-owned definition payload clears local env and preserves profile fields", () => {
  assert.deepEqual(
    buildAgentDefinitionSubmitPayload({
      avatarUrl: " https://example.com/agent.png ",
      behavior: { respondTo: "owner-only" },
      displayName: " Remote Agent ",
      envVars: { LOCAL_SECRET: "fixture" },
      execution: {
        ...BUILTIN_EDIT_BASE,
        runtime: "buzz-agent",
        model: "auto",
        provider: "relay-mesh",
        isAutoSeeded: false,
        providerOwnsExecutionProfile: true,
      },
      namePoolText: "Birch, Compass",
      preserveEmptyNamePool: false,
      providerOwnsExecutionProfile: true,
      systemPrompt: "Preserve this prompt.",
    }),
    {
      avatarUrl: "https://example.com/agent.png",
      behavior: { respondTo: "owner-only" },
      displayName: "Remote Agent",
      envVars: {},
      model: undefined,
      namePool: ["Birch", "Compass"],
      provider: undefined,
      runtime: undefined,
      systemPrompt: "Preserve this prompt.",
    },
  );
});

// ── edit-untouched ─────────────────────────────────────────────────────────────
//
// User opens a null-runtime builtin, doesn't change model or provider, submits.
// Runtime was auto-seeded (isAutoSeeded=true), model/provider still empty strings.
// Expected: runtime and model and provider all omitted (undefined).

test("edit-untouched: model and provider omitted when user changes nothing on auto-seeded builtin", () => {
  const result = buildRuntimeModelProviderPayload({
    ...BUILTIN_EDIT_BASE,
    runtime: "",
    model: "",
    provider: "",
    isAutoSeeded: true,
  });
  assert.equal(result.runtime, undefined, "runtime must be omitted");
  assert.equal(result.model, undefined, "model must be omitted");
  assert.equal(result.provider, undefined, "provider must be omitted");
});

// ── edit-model-only ────────────────────────────────────────────────────────────
//
// Transport-level coverage: the serializer remains permissive for legacy and
// non-dialog callers. The separately tested AI configuration mode policy blocks
// a model-only Customize submission in AgentDefinitionDialog.
// Expected: model persisted, runtime omitted (auto-seeded, not explicit).

test("edit-model-only: chosen model persists, runtime omitted on auto-seeded builtin", () => {
  const result = buildRuntimeModelProviderPayload({
    ...BUILTIN_EDIT_BASE,
    runtime: "",
    model: "claude-opus-4-8",
    provider: "",
    isAutoSeeded: true,
  });
  assert.equal(result.runtime, undefined, "runtime must be omitted");
  assert.equal(result.model, "claude-opus-4-8", "model must be persisted");
  assert.equal(result.provider, undefined, "provider must be omitted");
});

// ── edit-provider-only ─────────────────────────────────────────────────────────
//
// Transport-level coverage: the serializer remains permissive for legacy and
// non-dialog callers. The separately tested AI configuration mode policy blocks
// a provider-only Customize submission in AgentDefinitionDialog.
// Expected: provider persisted, model and runtime omitted.

test("edit-provider-only: chosen provider persists, runtime omitted on auto-seeded builtin", () => {
  const result = buildRuntimeModelProviderPayload({
    ...BUILTIN_EDIT_BASE,
    runtime: "",
    model: "",
    provider: "anthropic",
    isAutoSeeded: true,
  });
  assert.equal(result.runtime, undefined, "runtime must be omitted");
  assert.equal(result.model, undefined, "model must be omitted");
  assert.equal(result.provider, "anthropic", "provider must be persisted");
});

// ── explicit-runtime-chosen ────────────────────────────────────────────────────
//
// User opens a null-runtime builtin, the seeded default is shown, then the user
// explicitly re-selects the same (or a different) runtime via the dropdown.
// handleRuntimeDropdownChange clears isAutoSeeded=false so the runtime is no
// longer treated as auto-seeded and MUST appear in the payload.

test("explicit-runtime-chosen: runtime and model both persisted when user explicitly selects runtime", () => {
  const result = buildRuntimeModelProviderPayload({
    ...BUILTIN_EDIT_BASE,
    runtime: "buzz-agent",
    model: "claude-opus-4-8",
    provider: "",
    isAutoSeeded: false, // user made an explicit choice
  });
  assert.equal(result.runtime, "buzz-agent", "runtime must be persisted");
  assert.equal(result.model, "claude-opus-4-8", "model must be persisted");
  assert.equal(result.provider, undefined, "empty provider must be omitted");
});

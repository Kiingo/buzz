import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProbeResult,
  canSubmitWhereToRun,
  emptyWhereToRunDraft,
  providerConfigComplete,
  resolveBackendIntent,
} from "./whereToRunIntent.ts";

const probed = {
  ok: true,
  config_schema: {
    properties: { region: { type: "string" }, size: { type: "integer" } },
    required: ["region"],
  },
};

function providerDraft(overrides = {}) {
  return {
    ...emptyWhereToRunDraft,
    runOn: "blox",
    probedProvider: probed,
    providerConfig: { region: "us", size: "3" },
    ...overrides,
  };
}

test("provider selection blocks submit until the probe completes", () => {
  assert.equal(
    canSubmitWhereToRun(providerDraft({ probedProvider: null })),
    false,
  );
});

test("provider selection blocks submit while required config is missing", () => {
  const missing = providerDraft({ providerConfig: { size: "3" } });
  assert.equal(canSubmitWhereToRun(missing), false);
  assert.equal(providerConfigComplete(missing), false);
});

test("complete provider config allows submit", () => {
  assert.equal(canSubmitWhereToRun(providerDraft()), true);
});

test("local never gates submit", () => {
  assert.equal(canSubmitWhereToRun(emptyWhereToRunDraft), true);
});

test("local draft resolves to null intent", () => {
  assert.equal(resolveBackendIntent(emptyWhereToRunDraft), null);
});

test("provider draft resolves with coerced config values", () => {
  const intent = resolveBackendIntent(providerDraft());
  assert.deepEqual(intent, {
    type: "provider",
    id: "blox",
    config: { region: "us", size: 3 },
  });
});

// ── applyProbeResult: probe resolution must merge, not overwrite ─────────────
//
// Pins the seam that fixed the "Typewriter Eraser" (agent-create dialog's
// provider config fields losing keystrokes): a probe resolution prefills
// schema defaults *beneath* the user's in-flight config, never over it. The
// effect in WhereToRunSection keys probing on the provider's binary path, so
// the only probe writes that reach providerConfig are the ones pinned here.

const probeWithDefaults = {
  ok: true,
  config_schema: {
    properties: {
      context: { type: "string", title: "Kubeconfig context" },
      namespace: { type: "string", default: "buzz-agents-x1y2z3" },
      inactivity_seconds: { type: "number", default: 1800 },
    },
    required: ["namespace"],
  },
};

const unprobedDraft = {
  ...emptyWhereToRunDraft,
  runOn: "kubernetes",
};

test("probe resolution prefills schema defaults on a fresh draft", () => {
  const next = applyProbeResult(unprobedDraft, probeWithDefaults);
  assert.equal(next.probedProvider, probeWithDefaults);
  assert.deepEqual(next.providerConfig, {
    namespace: "buzz-agents-x1y2z3",
    inactivity_seconds: "1800",
  });
});

test("probe resolution keeps user-typed values over schema defaults", () => {
  const typed = {
    ...unprobedDraft,
    providerConfig: { context: "prod-us-west", namespace: "my-ns" },
  };
  const next = applyProbeResult(typed, probeWithDefaults);
  assert.deepEqual(next.providerConfig, {
    context: "prod-us-west",
    namespace: "my-ns",
    inactivity_seconds: "1800",
  });
});

test("probe resolution keeps a user-cleared field cleared", () => {
  // "" is a deliberate user state — coerceConfigValues drops empty numerics
  // and required-gating treats "" as incomplete; the probe must not undo it.
  const cleared = { ...unprobedDraft, providerConfig: { namespace: "" } };
  const next = applyProbeResult(cleared, probeWithDefaults);
  assert.equal(next.providerConfig.namespace, "");
});

test("a schema-less probe result records the probe without touching config", () => {
  const typed = { ...unprobedDraft, providerConfig: { context: "abc" } };
  const next = applyProbeResult(typed, { ok: true });
  assert.deepEqual(next.providerConfig, { context: "abc" });
  assert.deepEqual(next.probedProvider, { ok: true });
});

test("probe resolution preserves unrelated draft fields", () => {
  assert.equal(
    applyProbeResult(unprobedDraft, probeWithDefaults).runOn,
    "kubernetes",
  );
});

test("a provider that advertises preflight blocks create until ready", () => {
  const probed = {
    ok: true,
    capabilities: { lifecycle_operations: ["delete", "preflight"] },
    config_schema: {
      type: "object",
      properties: { harness: { type: "string" } },
      required: ["harness"],
    },
  };
  const draft = {
    ...emptyWhereToRunDraft,
    runOn: "example",
    probedProvider: probed,
    providerConfig: { harness: "codex" },
  };
  assert.equal(canSubmitWhereToRun(draft), false);
  const key = JSON.stringify(["example", [["harness", "codex"]]]);
  const result = {
    supported: true,
    ready: true,
    message: null,
    actionLabel: null,
    actionUrl: null,
    notice: null,
  };
  assert.equal(
    canSubmitWhereToRun({
      ...draft,
      preflight: { status: "done", key, result },
    }),
    true,
  );
  assert.equal(
    canSubmitWhereToRun({
      ...draft,
      providerConfig: { harness: "claude-code" },
      preflight: { status: "done", key, result },
    }),
    false,
  );
});

test("a shown model choice with no valid selection blocks create", () => {
  const schema = {
    type: "object",
    properties: {
      model_mode: { type: "string", enum: ["auto", "track"], default: "auto" },
      model_selector: {
        type: "string",
        default: "",
        "x-visible-when": { field: "model_mode", not: "auto" },
        "x-options-by-field": { field: "model_mode", options: { track: [] } },
      },
    },
    required: ["model_mode"],
  };
  const draft = {
    ...emptyWhereToRunDraft,
    runOn: "example",
    probedProvider: { ok: true, config_schema: schema },
    providerConfig: { model_mode: "auto", model_selector: "" },
  };
  assert.equal(providerConfigComplete(draft), true);
  assert.equal(
    providerConfigComplete({
      ...draft,
      providerConfig: { model_mode: "track", model_selector: "" },
    }),
    false,
  );
});

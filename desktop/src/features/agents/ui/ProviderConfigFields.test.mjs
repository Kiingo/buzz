import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { coerceConfigValues } from "./ProviderConfigFields.tsx";
import { providerSchemaUsesExtendedPresentation } from "./ProviderConfigSchemaFields.tsx";
import {
  providerConfigFieldVisible,
  providerConfigOptions,
  providerConfigUnmetChoices,
  reconcileProviderConfig,
} from "./providerConfigSchema.ts";

const schema = {
  properties: {
    inactivity_seconds: { type: "integer" },
    threshold: { type: "number" },
    label: { type: "string" },
  },
};

describe("coerceConfigValues", () => {
  it("omits cleared numeric fields without losing explicit zero", () => {
    assert.deepEqual(
      coerceConfigValues(
        { inactivity_seconds: "", threshold: "0", label: "" },
        schema,
      ),
      { threshold: 0, label: "" },
    );
  });

  it("preserves nonempty invalid numeric input for provider validation", () => {
    assert.deepEqual(
      coerceConfigValues({ inactivity_seconds: "not-a-number" }, schema),
      { inactivity_seconds: "not-a-number" },
    );
  });
});

describe("providerConfigOptions", () => {
  it("renders simple enum values without provider-specific logic", () => {
    assert.deepEqual(providerConfigOptions({ enum: ["codex", "claude"] }), [
      { label: "codex", value: "codex" },
      { label: "claude", value: "claude" },
    ]);
  });

  it("uses oneOf titles as bounded option labels", () => {
    assert.deepEqual(
      providerConfigOptions({
        oneOf: [
          { const: "auto", title: "Automatic" },
          { const: "opus", title: "Claude Opus" },
        ],
      }),
      [
        { label: "Automatic", value: "auto" },
        { label: "Claude Opus", value: "opus" },
      ],
    );
  });

  it("provides a bounded boolean choice", () => {
    assert.deepEqual(providerConfigOptions({ type: "boolean" }), [
      { label: "Yes", value: "true" },
      { label: "No", value: "false" },
    ]);
  });

  it("uses provider-owned labels for enum values", () => {
    assert.deepEqual(
      providerConfigOptions({
        enum: ["codex", "claude-code"],
        "x-enum-labels": {
          codex: "Codex CLI",
          "claude-code": "Claude Code",
        },
      }),
      [
        { label: "Codex CLI", value: "codex" },
        { label: "Claude Code", value: "claude-code" },
      ],
    );
  });

  it("resolves and filters dependent provider-owned options", () => {
    const property = {
      "x-options-by-field": {
        field: "harness",
        options: {
          codex: [
            { value: "gpt", label: "GPT", selector_kind: "version" },
            { value: "stable", label: "Stable", selector_kind: "track" },
          ],
        },
      },
      "x-option-filter": {
        field: "model_mode",
        option_property: "selector_kind",
      },
    };
    assert.deepEqual(
      providerConfigOptions(property, {
        harness: "codex",
        model_mode: "track",
      }),
      [{ value: "stable", label: "Stable", selector_kind: "track" }],
    );
  });

  it("hides fields when their bounded option set is empty", () => {
    const property = {
      "x-hide-when-no-options": true,
      "x-options-by-fields": {
        fields: ["harness", "model_selector"],
        options: { "codex|": [{ value: "auto", label: "Automatic" }] },
      },
    };
    assert.equal(
      providerConfigFieldVisible(property, {
        harness: "claude-code",
        model_selector: "",
      }),
      false,
    );
  });

  it("clears a dependent value that is invalid for the new selection", () => {
    const entries = [
      ["harness", { enum: ["codex", "claude-code"] }],
      [
        "model",
        {
          default: "auto",
          "x-options-by-field": {
            field: "harness",
            options: {
              codex: [{ value: "gpt", label: "GPT" }],
              "claude-code": [{ value: "opus", label: "Opus" }],
            },
          },
        },
      ],
    ];
    assert.deepEqual(
      reconcileProviderConfig(
        entries,
        { harness: "codex", model: "gpt" },
        "harness",
        "claude-code",
      ),
      { harness: "claude-code", model: "" },
    );
  });
});

describe("providerSchemaUsesExtendedPresentation", () => {
  it("leaves upstream string-only schemas on the upstream renderer", () => {
    assert.equal(
      providerSchemaUsesExtendedPresentation({
        properties: { label: { type: "string", default: "" } },
      }),
      false,
    );
  });

  it("routes bounded and dependent schemas through the generic extension", () => {
    assert.equal(
      providerSchemaUsesExtendedPresentation({
        properties: { harness: { enum: ["codex", "claude-code"] } },
      }),
      true,
    );
    assert.equal(
      providerSchemaUsesExtendedPresentation({
        properties: {
          model: { "x-visible-when": { field: "harness", equals: "codex" } },
        },
      }),
      true,
    );
  });
});

describe("hidden provider bookkeeping fields", () => {
  it("never renders x-hidden fields and resets them to their default", () => {
    const entries = [
      ["harness", { type: "string", enum: ["codex"] }],
      ["profile_revision", { type: "integer", default: 1, "x-hidden": true }],
    ];
    assert.equal(providerConfigFieldVisible(entries[1][1], {}), false);
    assert.deepEqual(
      reconcileProviderConfig(
        entries,
        { profile_revision: "9" },
        "harness",
        "codex",
      ),
      { harness: "codex", profile_revision: "1" },
    );
  });
});

describe("conditional bounded choices", () => {
  const catalogSchema = {
    type: "object",
    properties: {
      harness: {
        type: "string",
        enum: ["codex", "claude-code"],
        default: "codex",
      },
      model_mode: {
        type: "string",
        enum: ["auto", "track", "version"],
        default: "auto",
      },
      model_selector: {
        type: "string",
        default: "",
        "x-visible-when": { field: "model_mode", not: "auto" },
        "x-options-by-field": {
          field: "harness",
          options: {
            codex: [
              {
                label: "GPT-6.1 Sol",
                value: "gpt-6.1-sol",
                selector_kind: "version",
              },
            ],
            "claude-code": [
              { label: "Opus", value: "opus", selector_kind: "track" },
              {
                label: "Opus 5.5",
                value: "claude-opus-5-5",
                selector_kind: "version",
              },
            ],
          },
        },
        "x-option-filter": {
          field: "model_mode",
          option_property: "selector_kind",
        },
      },
    },
  };

  it("needs nothing while the dependent field is hidden", () => {
    assert.deepEqual(
      providerConfigUnmetChoices(catalogSchema, {
        harness: "codex",
        model_mode: "auto",
        model_selector: "",
      }),
      [],
    );
  });

  it("needs a choice once the dependent field is shown", () => {
    assert.deepEqual(
      providerConfigUnmetChoices(catalogSchema, {
        harness: "claude-code",
        model_mode: "track",
        model_selector: "",
      }),
      ["model_selector"],
    );
    assert.deepEqual(
      providerConfigUnmetChoices(catalogSchema, {
        harness: "claude-code",
        model_mode: "track",
        model_selector: "opus",
      }),
      [],
    );
  });

  it("an empty option list for the current combination can never be satisfied", () => {
    const config = {
      harness: "codex",
      model_mode: "track",
      model_selector: "",
    };
    assert.deepEqual(
      providerConfigOptions(catalogSchema.properties.model_selector, config),
      [],
    );
    assert.deepEqual(providerConfigUnmetChoices(catalogSchema, config), [
      "model_selector",
    ]);
  });

  it("a value that is not among the current options does not count", () => {
    assert.deepEqual(
      providerConfigUnmetChoices(catalogSchema, {
        harness: "codex",
        model_mode: "version",
        model_selector: "opus",
      }),
      ["model_selector"],
    );
  });
});

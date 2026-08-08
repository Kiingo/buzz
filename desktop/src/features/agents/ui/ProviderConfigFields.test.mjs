import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  coerceConfigValues,
  providerFieldOptions,
  providerFieldVisible,
} from "./ProviderConfigFields.tsx";

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

describe("dependent provider fields", () => {
  it("supports automatic-model options and hides unsupported controls", () => {
    const property = {
      "x-hide-when-no-options": true,
      "x-options-by-field": {
        field: "model_selector",
        options: {
          "": [{ value: "auto", label: "Automatic" }],
          fast: [],
        },
      },
    };
    assert.deepEqual(providerFieldOptions(property, { model_selector: "" }), [
      { value: "auto", label: "Automatic" },
    ]);
    assert.equal(
      providerFieldVisible(property, { model_selector: "fast" }),
      false,
    );
  });

  it("resolves options from more than one provider-owned dependency", () => {
    const property = {
      "x-options-by-fields": {
        fields: ["harness", "model_selector"],
        options: {
          "codex|": [{ value: "fast", label: "Fast" }],
          "claude-code|": [],
        },
      },
    };
    assert.deepEqual(
      providerFieldOptions(property, {
        harness: "codex",
        model_selector: "",
      }),
      [{ value: "fast", label: "Fast" }],
    );
    assert.deepEqual(
      providerFieldOptions(property, {
        harness: "claude-code",
        model_selector: "",
      }),
      [],
    );
  });
});

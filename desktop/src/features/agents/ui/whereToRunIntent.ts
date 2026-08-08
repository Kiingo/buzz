import type { BackendIntent } from "../lib/instanceInputForDefinition";
import type { BackendProviderProbeResult } from "@/shared/api/types";
import {
  coerceConfigValues,
  providerFieldOptions,
  providerFieldVisible,
} from "./ProviderConfigFields";

/** Draft state of the optional remote-backend selector. */
export type WhereToRunDraft = {
  runOn: "local" | string;
  providerConfig: Record<string, string>;
  probedProvider: BackendProviderProbeResult | null;
};

export const emptyWhereToRunDraft: WhereToRunDraft = {
  runOn: "local",
  providerConfig: {},
  probedProvider: null,
};

/**
 * Fold a completed probe into the draft the user has *now* — not the draft
 * that existed when the probe started. Schema defaults prefill only the keys
 * the user has not touched: anything already in `providerConfig` (typed while
 * the probe was in flight) wins over the default. Overwriting instead of
 * merging is the "Typewriter Eraser" bug — every probe resolution silently
 * erased in-flight keystrokes.
 */
export function applyProbeResult(
  current: WhereToRunDraft,
  result: BackendProviderProbeResult,
): WhereToRunDraft {
  const defaults: Record<string, string> = {};
  const properties =
    (result.config_schema as Record<string, unknown> | undefined)?.properties ??
    {};
  for (const [key, property] of Object.entries(properties) as [
    string,
    Record<string, unknown>,
  ][]) {
    if (property.default != null) defaults[key] = String(property.default);
  }
  return {
    ...current,
    probedProvider: result,
    providerConfig: { ...defaults, ...current.providerConfig },
  };
}

export function providerConfigComplete(draft: WhereToRunDraft): boolean {
  if (draft.runOn === "local") return true;
  if (!draft.probedProvider) return false;
  const schema = draft.probedProvider.config_schema as
    | Record<string, unknown>
    | undefined;
  const required: string[] = (schema?.required as string[] | undefined) ?? [];
  const properties = (schema?.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  return Object.entries(properties).every(([key, property]) => {
    if (!providerFieldVisible(property, draft.providerConfig)) return true;
    const value =
      draft.providerConfig[key] ??
      (property.default == null ? "" : String(property.default));
    if (required.includes(key) && value.trim().length === 0) return false;
    if (value.trim().length === 0) return true;
    const options = providerFieldOptions(property, draft.providerConfig);
    if (options && !options.some((option) => option.value === value)) {
      return false;
    }
    if (property.type === "integer" || property.type === "number") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return false;
      if (property.type === "integer" && !Number.isInteger(parsed))
        return false;
      if (typeof property.minimum === "number" && parsed < property.minimum) {
        return false;
      }
      if (typeof property.maximum === "number" && parsed > property.maximum) {
        return false;
      }
    }
    return true;
  });
}

export function canSubmitWhereToRun(draft: WhereToRunDraft): boolean {
  return providerConfigComplete(draft);
}

export function resolveBackendIntent(
  draft: WhereToRunDraft,
): BackendIntent | null {
  if (draft.runOn === "local") return null;
  const presentation = draft.probedProvider?.capabilities?.presentation;
  const properties = (draft.probedProvider?.config_schema?.properties ?? {}) as
    | Record<string, Record<string, unknown>>
    | undefined;
  const summary = (presentation?.summary_fields ?? []).flatMap((field) => {
    const raw = draft.providerConfig[field.field] ?? "";
    const property = properties?.[field.field];
    const option = property
      ? providerFieldOptions(property, draft.providerConfig)?.find(
          (candidate) => candidate.value === raw,
        )
      : undefined;
    const value = option?.label ?? (raw || field.empty_label || "Not set");
    if (!value.trim()) return [];
    return [
      {
        label:
          field.label ??
          (typeof property?.title === "string" ? property.title : field.field),
        value,
      },
    ];
  });
  return {
    type: "provider",
    id: draft.runOn,
    config: coerceConfigValues(
      draft.providerConfig,
      draft.probedProvider?.config_schema,
    ),
    ...(draft.probedProvider?.name ? { name: draft.probedProvider.name } : {}),
    ...(summary.length > 0 ? { summary } : {}),
  };
}

import type { BackendIntent } from "../lib/instanceInputForDefinition";
import type { BackendProviderProbeResult } from "@/shared/api/types";
import { coerceConfigValues } from "./ProviderConfigFields";
import {
  idlePreflight,
  preflightAllowsSubmit,
  preflightKey,
  providerAdvertisesPreflight,
  type ProviderPreflightState,
} from "./providerPreflightState";

/** Draft state of the optional remote-backend selector. */
export type WhereToRunDraft = {
  runOn: "local" | string;
  providerConfig: Record<string, string>;
  probedProvider: BackendProviderProbeResult | null;
  /** Owner readiness check, for providers that advertise preflight. */
  preflight: ProviderPreflightState;
};

export const emptyWhereToRunDraft: WhereToRunDraft = {
  runOn: "local",
  providerConfig: {},
  probedProvider: null,
  preflight: idlePreflight,
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
  return required.every(
    (key) => (draft.providerConfig[key] ?? "").trim().length > 0,
  );
}

export function canSubmitWhereToRun(draft: WhereToRunDraft): boolean {
  return providerConfigComplete(draft) && preflightSatisfied(draft);
}

/** The coerced provider configuration that create would send. */
export function draftProviderConfig(
  draft: WhereToRunDraft,
): Record<string, unknown> {
  return coerceConfigValues(
    draft.providerConfig,
    draft.probedProvider?.config_schema,
  );
}

/** Whether this draft's provider needs an owner readiness check. */
export function draftNeedsPreflight(draft: WhereToRunDraft): boolean {
  return (
    draft.runOn !== "local" && providerAdvertisesPreflight(draft.probedProvider)
  );
}

/** Identity of the readiness check for the draft as it is now. */
export function draftPreflightKey(draft: WhereToRunDraft): string {
  return preflightKey(draft.runOn, draftProviderConfig(draft));
}

function preflightSatisfied(draft: WhereToRunDraft): boolean {
  return preflightAllowsSubmit({
    advertised: draftNeedsPreflight(draft),
    currentKey: draftPreflightKey(draft),
    state: draft.preflight,
  });
}

export function resolveBackendIntent(
  draft: WhereToRunDraft,
): BackendIntent | null {
  if (draft.runOn === "local") return null;
  return {
    type: "provider",
    id: draft.runOn,
    config: draftProviderConfig(draft),
  };
}

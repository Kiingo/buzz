import type { ProviderPreflight } from "../lib/providerCreateApi";

/**
 * Create-flow state of a provider's owner readiness check (protocol-v2
 * `preflight`), e.g. "is your subscription for this harness connected?".
 */
export type ProviderPreflightState =
  | { status: "idle" }
  | { status: "checking"; key: string }
  | { status: "done"; key: string; result: ProviderPreflight }
  | { status: "error"; key: string; message: string };

export const idlePreflight: ProviderPreflightState = { status: "idle" };

/** Whether a probed provider advertises the protocol-v2 preflight operation. */
export function providerAdvertisesPreflight(probe: unknown): boolean {
  if (!probe || typeof probe !== "object") return false;
  const capabilities = (probe as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== "object") return false;
  const operations = (capabilities as { lifecycle_operations?: unknown })
    .lifecycle_operations;
  return Array.isArray(operations) && operations.includes("preflight");
}

/** Stable identity of one check: the provider plus its exact configuration. */
export function preflightKey(
  providerId: string,
  config: Record<string, unknown>,
): string {
  const sorted = Object.keys(config)
    .sort()
    .map((key) => [key, config[key]]);
  return JSON.stringify([providerId, sorted]);
}

/**
 * Whether create may proceed. A provider without preflight never blocks; one
 * with preflight blocks until a check for the *current* configuration says
 * ready, and fails closed while checking or after an error.
 */
export function preflightAllowsSubmit(input: {
  advertised: boolean;
  currentKey: string;
  state: ProviderPreflightState;
}): boolean {
  if (!input.advertised) return true;
  const { state } = input;
  if (state.status !== "done" || state.key !== input.currentKey) return false;
  return !state.result.supported || state.result.ready;
}

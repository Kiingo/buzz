import type {
  BackendProviderCandidate,
  BackendProviderProbeResult,
} from "@/shared/api/types";

/**
 * Build-time "where agents run by default" seam.
 *
 * A distribution that ships its own backend provider inside the app bundle
 * sets `VITE_BUZZ_PREFERRED_RUN_ON` to that provider's id at build time. When
 * the provider is discovered, the create flow leads with "Where it runs",
 * defaults to that destination, and offers exactly two choices: this computer
 * or the preferred destination. Builds that do not set the variable keep the
 * generic "Run on" selector in Advanced, unchanged.
 */

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Normalize a configured provider id, rejecting anything not id-shaped. */
export function normalizePreferredRunOn(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return PROVIDER_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** The build's preferred run-on provider id, or null for generic builds. */
export function configuredPreferredRunOn(): string | null {
  return normalizePreferredRunOn(
    import.meta.env?.VITE_BUZZ_PREFERRED_RUN_ON as string | undefined,
  );
}

/** The preferred provider, when this build names one and it was discovered. */
export function findPreferredProvider(
  providers: readonly BackendProviderCandidate[],
  preferredId: string | null,
): BackendProviderCandidate | null {
  if (!preferredId) return null;
  return providers.find((provider) => provider.id === preferredId) ?? null;
}

/**
 * Whether a discovered provider binary sits inside a macOS app bundle, which is
 * the only place a signed build puts the provider it ships (discovery checks
 * the running app's Contents/MacOS first). Anything else is user-installed.
 */
export function isBundledProviderPath(
  binaryPath: string,
  providerId: string,
): boolean {
  return binaryPath.endsWith(`.app/Contents/MacOS/buzz-backend-${providerId}`);
}

/** Plain name for the local destination on this platform. */
export function localRunOnLabel(isMac: boolean): string {
  return isMac ? "This Mac" : "This computer";
}

/** Human label for a provider: its probed name, else a title-cased id. */
export function providerRunOnLabel(
  providerId: string,
  probe: BackendProviderProbeResult | null,
): string {
  const probedName = probe?.name?.trim();
  if (probedName && probedName !== providerId) return probedName;
  return providerId
    .split("-")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

export type RunOnOption = { label: string; value: string };

/**
 * Options for the run-on selector. With a discovered preferred provider the
 * list is exactly [preferred, local]; otherwise it is the generic list of
 * every discovered provider after the local choice.
 */
export function runOnOptions(input: {
  providers: readonly BackendProviderCandidate[];
  preferred: BackendProviderCandidate | null;
  preferredProbe: BackendProviderProbeResult | null;
  isMac: boolean;
}): RunOnOption[] {
  if (input.preferred) {
    return [
      {
        label: providerRunOnLabel(input.preferred.id, input.preferredProbe),
        value: input.preferred.id,
      },
      { label: localRunOnLabel(input.isMac), value: "local" },
    ];
  }
  return [
    { label: "This computer", value: "local" },
    ...input.providers.map((provider) => ({
      label: provider.id,
      value: provider.id,
    })),
  ];
}

/**
 * Starting name and instructions for a new agent in a build with a preferred
 * destination, so the shortest path is: pick a harness, press Create.
 */
export const preferredCreateDefaults = {
  displayName: "Assistant",
  systemPrompt:
    "You are a helpful teammate. Answer clearly and briefly, say when you are unsure, and ask before doing anything that cannot be undone.",
} as const;

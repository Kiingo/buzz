import { AlertTriangle } from "lucide-react";
import * as React from "react";

import { useBackendProvidersQuery } from "@/features/agents/hooks";
import { probeBackendProvider } from "@/shared/api/tauri";
import { isMacPlatform } from "@/shared/lib/platform";

import {
  configuredPreferredRunOn,
  findPreferredProvider,
  isBundledProviderPath,
  providerRunOnLabel,
  runOnOptions as buildRunOnOptions,
} from "../lib/preferredRunOn";

import { ProviderConfigFields } from "./ProviderConfigFields";
import {
  ProviderPreflightStatus,
  useProviderPreflight,
} from "./ProviderPreflightStatus";
import { PersonaDropdownField } from "./PersonaDropdownField";
import {
  applyProbeResult,
  emptyWhereToRunDraft,
  type WhereToRunDraft,
} from "./whereToRunIntent";
import type { WhereToRunDraftSource } from "./usePreferredWhereToRunDraft";

/**
 * Remote-backend selector. Buzz shared compute is an LLM provider, not a run
 * destination. A build with a preferred destination (see `preferredRunOn`)
 * offers exactly that destination and this computer, under "Where it runs".
 */
export function WhereToRunSection({
  draft,
  isPending,
  onDraftChange,
}: {
  draft: WhereToRunDraft;
  isPending: boolean;
  onDraftChange: (
    next: WhereToRunDraft,
    source?: WhereToRunDraftSource,
  ) => void;
}) {
  const backendProviders = useBackendProvidersQuery().data ?? [];
  const [probeError, setProbeError] = React.useState<string | null>(null);
  const preferredProvider = findPreferredProvider(
    backendProviders,
    configuredPreferredRunOn(),
  );
  const isProviderMode = draft.runOn !== "local";
  const selectedBackendProvider = React.useMemo(
    () =>
      backendProviders.find((provider) => provider.id === draft.runOn) ?? null,
    [backendProviders, draft.runOn],
  );
  const runOnOptions = buildRunOnOptions({
    providers: backendProviders,
    preferred: preferredProvider,
    preferredProbe:
      preferredProvider && draft.runOn === preferredProvider.id
        ? draft.probedProvider
        : null,
    isMac: isMacPlatform(),
  });
  // The provider this build ships inside its own signed bundle is part of the
  // app, so it gets a plain statement instead of the untrusted-binary warning.
  const selectedIsShippedProvider = Boolean(
    selectedBackendProvider &&
      preferredProvider?.id === selectedBackendProvider.id &&
      isBundledProviderPath(
        selectedBackendProvider.binaryPath,
        selectedBackendProvider.id,
      ),
  );

  const preflight = useProviderPreflight(draft, onDraftChange);

  // Latest-state seam for probe resolution: an Effect Event always sees the
  // draft as it is *now*. Without this, the probe promise closes over the
  // draft from probe start, and anything typed while the probe was in flight
  // gets thrown away when it resolves (a second, subtler Typewriter Eraser).
  const applyProbe = React.useEffectEvent(
    (result: Awaited<ReturnType<typeof probeBackendProvider>>) => {
      onDraftChange(applyProbeResult(draft, result), "app");
    },
  );

  // Probe once per provider *selection*, keyed on the provider's stable
  // path — never on the draft. Depending on the draft made every keystroke
  // refire the probe, and each resolution reset providerConfig to schema
  // defaults, which erased what the user was typing (the Typewriter Eraser)
  // and spawned the provider binary in a loop for as long as the dialog was
  // open. Keying on the path (not the provider object) also keeps a
  // providers-query refresh from reprobing an unchanged selection.
  const selectedBinaryPath = isProviderMode
    ? (selectedBackendProvider?.binaryPath ?? null)
    : null;
  React.useEffect(() => {
    if (!selectedBinaryPath || draft.probedProvider) {
      setProbeError(null);
      return;
    }
    let cancelled = false;
    setProbeError(null);
    void probeBackendProvider(selectedBinaryPath)
      .then((result) => {
        if (cancelled) return;
        applyProbe(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setProbeError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBinaryPath, draft.probedProvider]);

  if (backendProviders.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="agent-run-on">
          {preferredProvider ? "Where it runs" : "Run on"}
        </label>
        <PersonaDropdownField
          disabled={isPending}
          id="agent-run-on"
          onValueChange={(runOn) =>
            onDraftChange({
              ...emptyWhereToRunDraft,
              runOn,
            })
          }
          options={runOnOptions}
          placeholder="Choose where to run"
          value={draft.runOn}
        />
      </div>

      {isProviderMode && selectedBackendProvider ? (
        <div className="space-y-4">
          {selectedIsShippedProvider ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="agent-run-on-shipped-note"
            >
              {providerRunOnLabel(
                selectedBackendProvider.id,
                draft.probedProvider,
              )}{" "}
              is built into this app. It runs the agent for you and holds the
              agent&apos;s key while it does.
            </p>
          ) : (
            <div className="flex gap-3 rounded-2xl border border-warning/30 bg-warning-bg px-4 py-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p className="text-sm text-warning">
                This provider at{" "}
                <span className="font-mono font-medium">
                  {selectedBackendProvider.binaryPath}
                </span>{" "}
                will receive your agent&apos;s private key. Only use providers
                from trusted sources.
              </p>
            </div>
          )}
          {probeError ? (
            <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {selectedIsShippedProvider
                ? `Couldn't reach ${providerRunOnLabel(selectedBackendProvider.id, null)}: ${probeError}. Choose ${runOnOptions[1]?.label ?? "This computer"} to run it here instead.`
                : `Could not probe provider: ${probeError}`}
            </p>
          ) : null}
          {!probeError && !draft.probedProvider ? (
            <p className="text-xs text-muted-foreground">Loading options…</p>
          ) : null}
          {draft.probedProvider?.config_schema ? (
            <ProviderConfigFields
              config={draft.providerConfig}
              onChange={(providerConfig) =>
                onDraftChange({ ...draft, providerConfig })
              }
              schema={draft.probedProvider.config_schema}
            />
          ) : null}
          <ProviderPreflightStatus
            draft={draft}
            onRecheck={preflight.recheck}
          />
        </div>
      ) : null}
    </div>
  );
}

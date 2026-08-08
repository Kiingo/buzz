import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";
import * as React from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { useBackendProvidersQuery } from "@/features/agents/hooks";
import { probeBackendProvider } from "@/shared/api/tauri";

import { ProviderConfigFields } from "./ProviderConfigFields";
import { PersonaDropdownField } from "./PersonaDropdownField";
import { Button } from "@/shared/ui/button";
import {
  applyProbeResult,
  emptyWhereToRunDraft,
  type WhereToRunDraft,
} from "./whereToRunIntent";

/** Optional remote-backend selector. Buzz shared compute is an LLM provider, not a run destination. */
export function WhereToRunSection({
  draft,
  isPending,
  lockedRunOn = false,
  onDraftChange,
}: {
  draft: WhereToRunDraft;
  isPending: boolean;
  /** Existing remote identities cannot be moved to another execution boundary. */
  lockedRunOn?: boolean;
  onDraftChange: (next: WhereToRunDraft) => void;
}) {
  const backendProviders = useBackendProvidersQuery().data ?? [];
  const [probeError, setProbeError] = React.useState<string | null>(null);
  const runOnOptions = React.useMemo(
    () => [
      { label: "This computer", value: "local" },
      ...backendProviders.map((provider) => ({
        label:
          provider.id === draft.runOn && draft.probedProvider?.name
            ? draft.probedProvider.name
            : provider.id,
        value: provider.id,
      })),
    ],
    [backendProviders, draft.probedProvider?.name, draft.runOn],
  );
  const isProviderMode = draft.runOn !== "local";
  const selectedBackendProvider = React.useMemo(
    () =>
      backendProviders.find((provider) => provider.id === draft.runOn) ?? null,
    [backendProviders, draft.runOn],
  );
  const connectionStatus =
    draft.probedProvider?.capabilities?.connection_status;
  const connectionFieldValue = connectionStatus
    ? draft.providerConfig[connectionStatus.field]
    : undefined;
  const selectedConnection = connectionFieldValue
    ? connectionStatus?.states[connectionFieldValue]
    : undefined;

  // Latest-state seam for probe resolution: an Effect Event always sees the
  // draft as it is *now*. Without this, the probe promise closes over the
  // draft from probe start, and anything typed while the probe was in flight
  // gets thrown away when it resolves (a second, subtler Typewriter Eraser).
  const applyProbe = React.useEffectEvent(
    (result: Awaited<ReturnType<typeof probeBackendProvider>>) => {
      onDraftChange(applyProbeResult(draft, result));
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
    void probeBackendProvider(selectedBinaryPath, draft.runOn)
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
  }, [selectedBinaryPath, draft.probedProvider, draft.runOn]);

  if (backendProviders.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="agent-run-on">
          Run on
        </label>
        <PersonaDropdownField
          disabled={isPending || lockedRunOn}
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
        {lockedRunOn ? (
          <p className="text-xs text-muted-foreground">
            Execution location is fixed for this identity. You can change its
            hosted harness and model below.
          </p>
        ) : null}
      </div>

      {isProviderMode && selectedBackendProvider ? (
        <div className="space-y-4">
          {draft.probedProvider?.name ? (
            <div className="rounded-2xl border bg-muted/30 px-4 py-3">
              <p className="text-sm font-medium">{draft.probedProvider.name}</p>
              {draft.probedProvider.description ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  {draft.probedProvider.description}
                </p>
              ) : null}
              {draft.probedProvider.capabilities?.owns_execution_profile ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Harness and model settings come from this provider. No local
                  coding-agent CLI or adapter is required.
                </p>
              ) : null}
            </div>
          ) : null}
          {selectedConnection ? (
            <div
              className={
                selectedConnection.status === "connected"
                  ? "flex gap-3 rounded-2xl border border-success/30 bg-success/10 px-4 py-3"
                  : "flex gap-3 rounded-2xl border border-warning/30 bg-warning-bg px-4 py-3"
              }
            >
              {selectedConnection.status === "connected" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              )}
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="text-sm font-medium">
                  {selectedConnection.status === "connected"
                    ? "Connected"
                    : selectedConnection.status === "action_required"
                      ? "Action required"
                      : "Unavailable"}
                </p>
                <p className="text-sm text-muted-foreground">
                  {selectedConnection.message}
                </p>
                {selectedConnection.remediation_url ? (
                  <Button
                    className="h-8 px-2"
                    onClick={() =>
                      void openUrl(selectedConnection.remediation_url as string)
                    }
                    type="button"
                    variant="outline"
                  >
                    Open connection settings
                    <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {draft.probedProvider?.capabilities?.connection_scope_message ? (
            <p className="text-xs text-muted-foreground">
              {draft.probedProvider.capabilities.connection_scope_message}
            </p>
          ) : null}
          <div className="flex gap-3 rounded-2xl border border-warning/30 bg-warning-bg px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p className="text-sm text-warning">
              {draft.probedProvider?.name ?? "This provider"} at{" "}
              <span className="font-mono font-medium">
                {selectedBackendProvider.binaryPath}
              </span>{" "}
              will receive your agent&apos;s private key. Only use providers
              from trusted sources.
            </p>
          </div>
          {probeError ? (
            <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              Could not probe provider: {probeError}
            </p>
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
        </div>
      ) : null}
    </div>
  );
}

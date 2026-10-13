import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import * as React from "react";

import { Button } from "@/shared/ui/button";

import { checkBackendProviderPreflight } from "../lib/providerCreateApi";
import type { WhereToRunDraftSource } from "./usePreferredWhereToRunDraft";
import {
  draftNeedsPreflight,
  draftPreflightKey,
  draftProviderConfig,
  providerConfigComplete,
  type WhereToRunDraft,
} from "./whereToRunIntent";

const PREFLIGHT_DEBOUNCE_MS = 350;

/**
 * Keep the draft's owner readiness check current: run it when the provider's
 * configuration settles, again when the window regains focus (the owner may
 * have just connected their subscription in the browser), and on request.
 * Only the newest check may update the draft.
 */
export function useProviderPreflight(
  draft: WhereToRunDraft,
  onDraftChange: (
    next: WhereToRunDraft,
    source?: WhereToRunDraftSource,
  ) => void,
): { recheck: () => void } {
  const needed = draftNeedsPreflight(draft) && providerConfigComplete(draft);
  const key = needed ? draftPreflightKey(draft) : null;
  const latestRequest = React.useRef(0);
  const [nonce, setNonce] = React.useState(0);

  const apply = React.useEffectEvent(
    (request: number, preflight: WhereToRunDraft["preflight"]) => {
      if (request !== latestRequest.current) return;
      onDraftChange({ ...draft, preflight }, "app");
    },
  );
  const start = React.useEffectEvent(() => {
    if (!key) return null;
    const request = ++latestRequest.current;
    const providerId = draft.runOn;
    const config = draftProviderConfig(draft);
    apply(request, { status: "checking", key });
    return { request, providerId, config, key };
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce re-runs the check on request
  React.useEffect(() => {
    if (!key) return;
    const timer = window.setTimeout(() => {
      const started = start();
      if (!started) return;
      checkBackendProviderPreflight(started.providerId, started.config)
        .then((result) =>
          apply(started.request, { status: "done", key: started.key, result }),
        )
        .catch((error: unknown) =>
          apply(started.request, {
            status: "error",
            key: started.key,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
    }, PREFLIGHT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [key, nonce]);

  React.useEffect(() => {
    if (!key) return;
    const onFocus = () => setNonce((value) => value + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [key]);

  return { recheck: () => setNonce((value) => value + 1) };
}

/** The owner readiness line under the provider's harness and model fields. */
export function ProviderPreflightStatus({
  draft,
  onRecheck,
}: {
  draft: WhereToRunDraft;
  onRecheck: () => void;
}) {
  if (!draftNeedsPreflight(draft) || !providerConfigComplete(draft)) {
    return null;
  }
  const currentKey = draftPreflightKey(draft);
  const state =
    draft.preflight.status !== "idle" && draft.preflight.key === currentKey
      ? draft.preflight
      : { status: "checking" as const };

  if (state.status === "checking") {
    return (
      <p
        className="flex items-center gap-2 text-sm text-muted-foreground"
        data-testid="provider-preflight-checking"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking your subscription…
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div
        className="flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3"
        data-testid="provider-preflight-error"
      >
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <p className="flex-1 text-sm text-destructive">
          Couldn't check your subscription: {state.message}
        </p>
        <Button onClick={onRecheck} size="sm" type="button" variant="outline">
          Check again
        </Button>
      </div>
    );
  }

  const { result } = state;
  if (!result.supported) return null;

  return (
    <div className="space-y-2" data-testid="provider-preflight">
      {result.ready ? (
        <p
          className="flex items-center gap-2 text-sm text-foreground"
          data-testid="provider-preflight-ready"
        >
          <CheckCircle2 className="h-4 w-4 text-primary" />
          {result.message ?? "Your subscription is connected."}
        </p>
      ) : (
        <div
          className="flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning-bg px-4 py-3"
          data-testid="provider-preflight-blocked"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p className="flex-1 text-sm text-warning">
            {result.message ??
              "Connect your subscription for this harness to create the agent."}
          </p>
          <div className="flex shrink-0 gap-2">
            {result.actionUrl ? (
              <Button
                onClick={() => {
                  if (result.actionUrl) void openUrl(result.actionUrl);
                }}
                size="sm"
                type="button"
              >
                {result.actionLabel ?? "Connect"}
              </Button>
            ) : null}
            <Button
              onClick={onRecheck}
              size="sm"
              type="button"
              variant="outline"
            >
              Check again
            </Button>
          </div>
        </div>
      )}
      {result.notice ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="provider-preflight-notice"
        >
          {result.notice}
        </p>
      ) : null}
    </div>
  );
}

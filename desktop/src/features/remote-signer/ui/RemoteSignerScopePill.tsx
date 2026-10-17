import { KeyRound, X } from "lucide-react";

import { AppTopChromePortal } from "@/app/AppTopChromePortal";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";

import { SIGNER_SERVICE_NAME } from "../lib/display";
import { useRevokeRemoteSignerScopes } from "../useRemoteSigner";
import { REMOTE_SIGNER_SETTINGS_SECTION } from "./remoteSignerSettingsSection";

/**
 * Persistent indicator in the top chrome while any scope lets the service
 * sign as the user without asking, with one-click revoke of all of them.
 */
export function RemoteSignerScopePill({ count }: { count: number }) {
  const revoke = useRevokeRemoteSignerScopes();
  const { goSettings } = useAppNavigation();
  if (count === 0) return null;

  return (
    <AppTopChromePortal>
      <div
        className="ml-auto flex shrink-0 items-center gap-1 rounded-full border border-amber-500/70 bg-amber-500/15 py-0.5 pl-2.5 pr-1 text-xs font-medium text-foreground"
        data-testid="remote-signer-scope-pill"
        role="status"
      >
        <KeyRound aria-hidden className="h-3.5 w-3.5 text-amber-600" />
        <button
          className="hover:underline"
          onClick={() => void goSettings(REMOTE_SIGNER_SETTINGS_SECTION)}
          type="button"
        >
          {SIGNER_SERVICE_NAME} can sign as you · {count}{" "}
          {count === 1 ? "scope" : "scopes"}
        </button>
        <button
          aria-label="Revoke all signing scopes"
          className="ml-1 flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-destructive hover:bg-destructive/10 disabled:opacity-50"
          data-testid="remote-signer-revoke-all"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate(undefined)}
          type="button"
        >
          <X aria-hidden className="h-3 w-3" />
          Revoke all
        </button>
      </div>
    </AppTopChromePortal>
  );
}

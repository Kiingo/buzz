import { invokeTauri } from "@/shared/api/tauri";

/** Owner readiness from a provider's protocol-v2 `preflight` operation. */
export type ProviderPreflight = {
  /** False when the provider does not offer a preflight check. */
  supported: boolean;
  ready: boolean;
  message: string | null;
  actionLabel: string | null;
  actionUrl: string | null;
  notice: string | null;
};

/** Result of undoing a provider-backed create that did not start. */
export type ProviderCreateRollback =
  | { status: "removed" }
  | { status: "kept"; reason: string };

export function checkBackendProviderPreflight(
  providerId: string,
  providerConfig: Record<string, unknown>,
): Promise<ProviderPreflight> {
  return invokeTauri<ProviderPreflight>("check_backend_provider_preflight", {
    providerId,
    providerConfig,
  });
}

export function rollbackFailedProviderCreate(
  pubkey: string,
): Promise<ProviderCreateRollback> {
  return invokeTauri<ProviderCreateRollback>(
    "rollback_failed_provider_create",
    { pubkey },
  );
}

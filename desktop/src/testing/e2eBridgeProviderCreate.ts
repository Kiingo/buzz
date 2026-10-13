/**
 * Mock IPC for the remote-provider create flow: the owner readiness preflight
 * and the failed-create rollback. Commands this module does not own keep the
 * bridge's "unsupported" failure, so a spec cannot silently hit a missing mock.
 *
 * Specs opt in through extra `mock` fields:
 * - `backendProviderPreflight`: the preflight result (defaults to unsupported).
 * - `backendProviderRollback`: the rollback result (defaults to removed).
 */
type ProviderCreateMock = {
  backendProviderPreflight?: Record<string, unknown>;
  backendProviderRollback?: Record<string, unknown>;
};

export function handleProviderCreateMockCommand(
  command: string,
  _payload: unknown,
  config: { mock?: object } | null | undefined,
): unknown {
  const mock = (config?.mock ?? {}) as ProviderCreateMock;
  switch (command) {
    case "check_backend_provider_preflight":
      return (
        mock.backendProviderPreflight ?? {
          supported: false,
          ready: true,
          message: null,
          actionLabel: null,
          actionUrl: null,
          notice: null,
        }
      );
    case "rollback_failed_provider_create":
      return mock.backendProviderRollback ?? { status: "removed" };
    default:
      throw new Error(`Unsupported mocked Tauri command: ${command}`);
  }
}

export type ManagedAgentBackend =
  | { type: "local" }
  | {
      type: "provider";
      id: string;
      config: Record<string, unknown>;
      /** Provider-advertised, inert presentation metadata saved at selection. */
      name?: string;
      summary?: { label: string; value: string }[];
    };

export type ProviderLifecycleState = {
  desired_state: "active" | "paused" | "deleted";
  observed_state:
    | "provisioning"
    | "ready"
    | "updating"
    | "paused"
    | "action_required"
    | "degraded"
    | "deletion_pending"
    | "deleted";
  last_reconciled_at: string | null;
  last_ready_at: string | null;
  error_code: string | null;
  correlation_id: string;
};

export type BackendProviderProbeResult = {
  ok: boolean;
  name?: string;
  version?: string;
  protocol_version?: number;
  description?: string;
  config_schema?: Record<string, unknown>;
  capabilities?: {
    owns_execution_profile?: boolean;
    lifecycle_operations?: string[];
    connection_status?: {
      field: string;
      states: Record<
        string,
        {
          status: "connected" | "action_required" | "unavailable";
          message: string;
          remediation_url?: string | null;
        }
      >;
    };
    connection_scope_message?: string;
    self_check?: boolean;
    presentation?: {
      summary_fields: {
        field: string;
        label?: string;
        empty_label?: string;
      }[];
    };
  };
};

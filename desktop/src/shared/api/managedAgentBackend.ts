export type ManagedAgentBackend =
  | { type: "local" }
  | {
      type: "provider";
      id: string;
      config: Record<string, unknown>;
      /** Server-validated provider capability, refreshed before deployment. */
      ownsExecutionProfile?: boolean;
    };

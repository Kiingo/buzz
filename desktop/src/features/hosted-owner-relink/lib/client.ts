import { invokeTauri } from "@/shared/api/tauri";

import {
  MAX_REBIND_AGENTS,
  RelinkRequestError,
  toRelinkRequestError,
  type HostedOwnerAgent,
  type HostedOwnerAgents,
  type RebindResult,
} from "./relink";

type Transport = {
  available: () => Promise<boolean>;
  list: () => Promise<HostedOwnerAgents>;
  rebind: (
    agents: { providerAgentId: string; agentPublicKey: string }[],
  ) => Promise<RebindResult[]>;
};

const tauriTransport: Transport = {
  available: () => invokeTauri<boolean>("hosted_owner_relink_available"),
  list: () => invokeTauri<HostedOwnerAgents>("hosted_owner_relink_list"),
  rebind: (agents) =>
    invokeTauri<RebindResult[]>("hosted_owner_relink_rebind", { agents }),
};

let transport: Transport = tauriTransport;

/** Test seam: replace the native transport. Returns a restore function. */
export function setRelinkTransportForTests(next: Partial<Transport>) {
  const previous = transport;
  transport = { ...transport, ...next };
  return () => {
    transport = previous;
  };
}

export const hostedOwnerRelinkApi = {
  /** Whether this build and community can re-link hosted agents. */
  available: async () => {
    try {
      return await transport.available();
    } catch {
      return false;
    }
  },

  /** The owner's hosted agents; read-only. */
  list: async () => {
    try {
      return await transport.list();
    } catch (error) {
      throw toRelinkRequestError(error);
    }
  },

  /**
   * Re-link exactly `agents` to the current key. Only the confirm button
   * calls this; the native side signs one new request per call and never
   * retries on its own.
   */
  rebind: async (agents: HostedOwnerAgent[]) => {
    if (agents.length === 0 || agents.length > MAX_REBIND_AGENTS) {
      throw new RelinkRequestError("rebind_selection_invalid", null, null);
    }
    try {
      return await transport.rebind(
        agents.map((agent) => ({
          providerAgentId: agent.providerAgentId,
          agentPublicKey: agent.agentPublicKey,
        })),
      );
    } catch (error) {
      throw toRelinkRequestError(error);
    }
  },
};

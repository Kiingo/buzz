import { invokeTauri } from "@/shared/api/tauri";

import {
  MAX_REBIND_AGENTS,
  RelinkRequestError,
  toRelinkRequestError,
  type AttestResult,
  type HostedOwnerAgent,
  type HostedOwnerAgents,
  type RebindResult,
  type UnlinkedAgent,
} from "./relink";

type Transport = {
  available: () => Promise<boolean>;
  list: () => Promise<HostedOwnerAgents>;
  rebind: (
    agents: { providerAgentId: string; agentPublicKey: string }[],
  ) => Promise<RebindResult[]>;
  attestPending: (
    agents: { providerAgentId: string; agentPublicKey: string }[],
  ) => Promise<AttestResult[]>;
  listUnlinked: () => Promise<UnlinkedAgent[]>;
};

const tauriTransport: Transport = {
  available: () => invokeTauri<boolean>("hosted_owner_relink_available"),
  list: () => invokeTauri<HostedOwnerAgents>("hosted_owner_relink_list"),
  rebind: (agents) =>
    invokeTauri<RebindResult[]>("hosted_owner_relink_rebind", { agents }),
  attestPending: (agents) =>
    invokeTauri<AttestResult[]>("hosted_owner_relink_attest_pending", {
      agents,
    }),
  listUnlinked: () =>
    invokeTauri<UnlinkedAgent[]>("hosted_owner_relink_list_unlinked"),
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

  /**
   * Attest exactly `agents` (pending agents from the latest list) with the
   * current key: a Link tap, or an auto-link pass the owner turned on. The
   * native side signs one new request per call, only for agents its latest
   * list reported pending, and never retries on its own.
   */
  attestPending: async (agents: HostedOwnerAgent[]) => {
    if (agents.length === 0 || agents.length > MAX_REBIND_AGENTS) {
      throw new RelinkRequestError("attest_selection_invalid", null, null);
    }
    try {
      return await transport.attestPending(
        agents.map((agent) => ({
          providerAgentId: agent.providerAgentId,
          agentPublicKey: agent.agentPublicKey,
        })),
      );
    } catch (error) {
      throw toRelinkRequestError(error);
    }
  },

  /**
   * The owner's agents that have no Buzz identity yet, newest first, without
   * machine defaults; read-only. A new hosted agent may attach to one.
   */
  listUnlinked: async () => {
    try {
      return await transport.listUnlinked();
    } catch (error) {
      throw toRelinkRequestError(error);
    }
  },
};

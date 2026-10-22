import { invokeTauri } from "@/shared/api/tauri";

import {
  MAX_REBIND_AGENTS,
  RelinkRequestError,
  toRelinkRequestError,
  type AttestResult,
  type HostedOwnerAgent,
  type HostedOwnerAgents,
  type RebindResult,
  type RelinkListing,
  type UnlinkedAgent,
} from "./relink";

type Selection = { providerAgentId: string; agentPublicKey: string };

/** What a signing command sends: the agents and the list they came from. */
type SigningArgs = {
  agents: Selection[];
  expectedOwner: string;
  listId: string;
};

type Transport = {
  available: () => Promise<boolean>;
  list: (args: { background?: boolean }) => Promise<HostedOwnerAgents>;
  rebind: (args: SigningArgs) => Promise<RebindResult[]>;
  attestPending: (args: SigningArgs) => Promise<AttestResult[]>;
  listUnlinked: () => Promise<UnlinkedAgent[]>;
};

const tauriTransport: Transport = {
  available: () => invokeTauri<boolean>("hosted_owner_relink_available"),
  list: (args) =>
    invokeTauri<HostedOwnerAgents>("hosted_owner_relink_list", args),
  rebind: (args) =>
    invokeTauri<RebindResult[]>("hosted_owner_relink_rebind", args),
  attestPending: (args) =>
    invokeTauri<AttestResult[]>("hosted_owner_relink_attest_pending", args),
  listUnlinked: () =>
    invokeTauri<UnlinkedAgent[]>("hosted_owner_relink_list_unlinked"),
};

let transport: Transport = tauriTransport;

/** Only the id and key of each agent cross to the native side. */
function signingArgs(
  agents: HostedOwnerAgent[],
  listing: RelinkListing,
): SigningArgs {
  return {
    agents: agents.map((agent) => ({
      providerAgentId: agent.providerAgentId,
      agentPublicKey: agent.agentPublicKey,
    })),
    expectedOwner: listing.currentOwnerPublicKey,
    listId: listing.listId,
  };
}

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

  /**
   * The owner's hosted agents; read-only. An auto-link pass passes
   * `background`, so the native side keeps its lists apart from the ones an
   * open card or review signs against.
   */
  list: async (options: { background?: boolean } = {}) => {
    try {
      return await transport.list(
        options.background ? { background: true } : {},
      );
    } catch (error) {
      throw toRelinkRequestError(error);
    }
  },

  /**
   * Re-link exactly `agents` (live agents `listing` reported on an earlier
   * owner key) to the current key: a Link tap, the batch review's confirm
   * button, or an auto-link pass the owner turned on. The native side signs
   * one new request per call, only while the signed-in key is still
   * `listing`'s and only for agents that list reported, and never retries
   * on its own.
   */
  rebind: async (agents: HostedOwnerAgent[], listing: RelinkListing) => {
    if (agents.length === 0 || agents.length > MAX_REBIND_AGENTS) {
      throw new RelinkRequestError("rebind_selection_invalid", null, null);
    }
    try {
      return await transport.rebind(signingArgs(agents, listing));
    } catch (error) {
      throw toRelinkRequestError(error);
    }
  },

  /**
   * Attest exactly `agents` (agents `listing` reported pending) with the
   * current key: a Link tap, or an auto-link pass the owner turned on. The
   * native side signs one new request per call, only while the signed-in
   * key is still `listing`'s and only for agents that list reported
   * pending, and never retries on its own.
   */
  attestPending: async (agents: HostedOwnerAgent[], listing: RelinkListing) => {
    if (agents.length === 0 || agents.length > MAX_REBIND_AGENTS) {
      throw new RelinkRequestError("attest_selection_invalid", null, null);
    }
    try {
      return await transport.attestPending(signingArgs(agents, listing));
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

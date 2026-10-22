/** One hosted agent with the owner key its provider holds. */
export type HostedOwnerAgent = {
  providerAgentId: string;
  agentPublicKey: string;
  displayName: string;
  /** Owner key the provider holds, or null when it did not say. */
  ownerPublicKey: string | null;
  deleted: boolean;
  /**
   * `pending_attestation` while the provider holds an agent it minted until
   * its owner attests it; `active` otherwise. Older providers leave it out.
   */
  status?: "active" | "pending_attestation" | "unknown";
  /** The provider's id for the agent, when it reported one. */
  kiingoAgentId?: string | null;
};

export type HostedOwnerAgents = {
  currentOwnerPublicKey: string;
  /**
   * This list's request id. Signing commands name it, and the native side
   * signs only for agents this list reported, with the key it was listed for.
   */
  listId: string;
  agents: HostedOwnerAgent[];
};

/** The list a signing request is held to: its id and its owner key. */
export type RelinkListing = Pick<
  HostedOwnerAgents,
  "currentOwnerPublicKey" | "listId"
>;

/** A short, stable fingerprint of an agent key: its first 8 hex digits. */
export function agentFingerprint(agentPublicKey: string): string {
  return agentPublicKey.slice(0, 8).toLowerCase();
}

/**
 * An agent's name as shown: the native side already removed unprintable
 * characters; an empty name reads "Unnamed agent".
 */
export function agentName(agent: { displayName: string }): string {
  return agent.displayName.trim() || "Unnamed agent";
}

/**
 * How a note names an agent: its name and key fingerprint, so two agents
 * with the same name (or a name chosen to look like another) stay apart.
 */
export function agentLabel(agent: {
  displayName: string;
  agentPublicKey: string;
}): string {
  return `${agentName(agent)} (${agentFingerprint(agent.agentPublicKey)})`;
}

/** One agent's re-link result, as the native command returns it. */
export type RebindResult = {
  providerAgentId: string;
  outcome: "rebound" | "already_current" | "rejected";
  /** Reject code without the `buzz_hosted_` prefix. */
  code: string | null;
};

/** One agent's attest-pending result, as the native command returns it. */
export type AttestResult = {
  providerAgentId: string;
  outcome: "activated" | "already_active" | "rejected";
  /** Reject code without the `buzz_hosted_` prefix. */
  code: string | null;
  /** Whether the provider opened the owner DM as the agent. */
  dmOpened: boolean;
  kiingoAgentId: string | null;
};

/**
 * One of the owner's agents that has no Buzz identity yet. Machine defaults
 * are already left out by the native side.
 */
export type UnlinkedAgent = {
  kiingoAgentId: string;
  displayName: string;
  ownerPrincipalType: "User" | "Organization";
};

/** Most agents one re-link or attest request may name. */
export const MAX_REBIND_AGENTS = 20;

const lower = (value: string) => value.toLowerCase();

const isActive = (agent: HostedOwnerAgent) =>
  (agent.status ?? "active") === "active";

/**
 * Agents the provider minted and holds until their owner attests them.
 * Only these are ever sent to attest-pending.
 */
export function pendingAgents(view: HostedOwnerAgents): HostedOwnerAgent[] {
  return view.agents.filter(
    (agent) => !agent.deleted && agent.status === "pending_attestation",
  );
}

/**
 * Agents still linked to an earlier owner key: the provider names an owner
 * key and it is not the current one. An agent whose owner key the provider
 * did not report (null) is not offered, and neither is a deleted one.
 */
export function staleAgents(view: HostedOwnerAgents): HostedOwnerAgent[] {
  const current = lower(view.currentOwnerPublicKey);
  return view.agents.filter(
    (agent) =>
      !agent.deleted &&
      isActive(agent) &&
      agent.ownerPublicKey !== null &&
      lower(agent.ownerPublicKey) !== current,
  );
}

/** Agents the provider already holds under the current key. */
export function currentAgents(view: HostedOwnerAgents): HostedOwnerAgent[] {
  const current = lower(view.currentOwnerPublicKey);
  return view.agents.filter(
    (agent) =>
      !agent.deleted &&
      isActive(agent) &&
      agent.ownerPublicKey !== null &&
      lower(agent.ownerPublicKey) === current,
  );
}

/** Reject codes a new request (fresh id and proof) may clear. */
export function isRetryableCode(code: string | null): boolean {
  return (
    code === "profile_revision_conflict" ||
    code === "rebind_failed" ||
    code === "result_missing"
  );
}

export function isRetryable(result: RebindResult | undefined): boolean {
  return result?.outcome === "rejected" && isRetryableCode(result.code);
}

/** One short sentence for an agent that was not re-linked. */
export function describeRejection(code: string | null): string {
  switch (code) {
    case "endpoint_not_found":
      return "This agent no longer exists on the hosted service.";
    case "agent_key_mismatch":
      return "The agent's key didn't match; refresh and try again.";
    case "owner_attestation_invalid":
      return "The hosted service didn't accept your approval for this agent.";
    case "previous_owner_not_revoked":
      return "Your old key is still active, so this agent stays linked to it.";
    case "identity_unreadable":
      return "The agent's identity couldn't be read; contact support.";
    case "rotation_in_progress":
      return "A key change is still in progress; finish it, then try again.";
    case "profile_revision_conflict":
      return "The agent changed while it was being re-linked; retry.";
    case "rebind_failed":
      return "Re-linking didn't finish; retry.";
    case "result_missing":
      return "The hosted service did not report this agent; retry.";
    default:
      return "This agent couldn't be re-linked.";
  }
}

/** Plain words for one agent's result. */
export function describeOutcome(result: RebindResult): string {
  switch (result.outcome) {
    case "rebound":
      return "Re-linked";
    case "already_current":
      return "Already linked";
    default:
      return describeRejection(result.code);
  }
}

/**
 * Whether an attest result means the agent is now linked. The provider
 * reports `dm_open_failed` as a note on an activated agent (it retries the
 * DM); a rejected result with that code is treated the same way.
 */
export function isAttested(result: AttestResult | undefined): boolean {
  return (
    result?.outcome === "activated" ||
    result?.outcome === "already_active" ||
    (result?.outcome === "rejected" && result.code === "dm_open_failed")
  );
}

/** Attest reject codes a new request (fresh id and proof) may clear. */
export function isRetryableAttestCode(code: string | null): boolean {
  return code === "activate_failed" || code === "result_missing";
}

export function isRetryableAttest(result: AttestResult | undefined): boolean {
  return (
    result?.outcome === "rejected" &&
    !isAttested(result) &&
    isRetryableAttestCode(result.code)
  );
}

/** One short sentence for an agent that was not attested. */
export function describeAttestRejection(code: string | null): string {
  switch (code) {
    case "endpoint_not_found":
      return "This agent no longer exists on the hosted service.";
    case "not_pending":
      return "This agent isn't waiting to be linked any more; refresh.";
    case "agent_key_mismatch":
      return "The agent's key didn't match; refresh and try again.";
    case "owner_attestation_invalid":
      return "The hosted service didn't accept your approval for this agent.";
    case "not_agent_owner":
      return "Only this agent's owner can link it.";
    case "dm_open_failed":
      return "Linked; its chat with you opens shortly.";
    case "identity_unreadable":
      return "The agent's identity couldn't be read; contact support.";
    case "activate_failed":
      return "Linking didn't finish; retry.";
    case "result_missing":
      return "The hosted service did not report this agent; retry.";
    default:
      return "This agent couldn't be linked.";
  }
}

/** Plain words for one agent's attest result. */
export function describeAttestOutcome(result: AttestResult): string {
  if (isAttested(result) && result.code === "dm_open_failed") {
    return "Linked; its chat with you opens shortly";
  }
  if (result.outcome === "activated") return "Linked";
  if (result.outcome === "already_active") return "Already linked";
  return describeAttestRejection(result.code);
}

/** A failure of the whole request: its code and HTTP status, if any. */
export class RelinkRequestError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly correlationId: string | null;

  constructor(
    code: string,
    status: number | null,
    correlationId: string | null,
  ) {
    super(describeRequestError(code));
    this.name = "RelinkRequestError";
    this.code = code;
    this.status = status;
    this.correlationId = correlationId;
  }
}

/** One sentence for a failure of the whole request. */
export function describeRequestError(code: string): string {
  const bare = code.replace(/^buzz_hosted_/, "");
  // Every provisioning_keys_* 503 means the service isn't set up to sign.
  if (bare.startsWith("provisioning_keys_")) {
    return "The hosted service can't link agents right now; try again later.";
  }
  switch (bare) {
    case "rebind_invalid":
    case "rebind_selection_invalid":
      return "The re-link request wasn't accepted; update Buzz and try again.";
    case "attest_pending_invalid":
    case "attest_selection_invalid":
      return "The link request wasn't accepted; update Buzz and try again.";
    case "attest_selection_not_listed":
    case "rebind_selection_not_listed":
      return "That agent isn't in your latest list; refresh and try again.";
    case "owner_key_changed":
      return "You're signed in with a different key now; check your agents again.";
    case "owner_proof_invalid":
      return "Your signature wasn't accepted; check this computer's date and time, then try again.";
    case "owner_proof_replayed":
      return "That request was already used; try again.";
    case "owner_not_linked":
      return "Your current key isn't linked to your account yet; link it, then try again.";
    case "owner_ambiguous":
      return "More than one account matches your key; contact support.";
    case "not_agent_owner":
      return "Only the agent's owner can do this; sign in with that account and try again.";
    case "scope_unconfigured":
      return "Linking agents isn't available for this community yet.";
    case "database_unavailable":
      return "The hosted service is temporarily unavailable; try again in a moment.";
    case "hosted_agents_unreachable":
    case "hosted_agents_timeout":
      return "Couldn't reach the hosted service; check your connection and try again.";
    case "rate_limited":
      return "Too many requests; wait a moment and try again.";
    case "response_invalid":
    case "response_too_large":
      return "The hosted service sent an answer Buzz doesn't understand.";
    case "hosted_relink_unavailable":
      return "Linking agents isn't available in this build or community.";
    default:
      return "The hosted service couldn't complete this request; try again.";
  }
}

/** Parse a native command rejection (`{status, error, correlation_id}`). */
export function toRelinkRequestError(error: unknown): RelinkRequestError {
  if (error instanceof RelinkRequestError) return error;
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  try {
    const parsed = JSON.parse(text) as {
      status?: unknown;
      error?: unknown;
      correlation_id?: unknown;
    };
    if (parsed && typeof parsed.error === "string") {
      return new RelinkRequestError(
        parsed.error,
        typeof parsed.status === "number" ? parsed.status : null,
        typeof parsed.correlation_id === "string"
          ? parsed.correlation_id
          : null,
      );
    }
  } catch {
    // Not a structured error.
  }
  return new RelinkRequestError("request_failed", null, null);
}

/**
 * Agents the owner can still choose: not yet sent, or sent and retryable.
 * Agents already re-linked, already current, or rejected for good are not
 * offered again.
 */
export function selectableAgents(
  stale: HostedOwnerAgent[],
  results: Record<string, RebindResult>,
): HostedOwnerAgent[] {
  return stale.filter((agent) => {
    const result = results[agent.providerAgentId];
    return result === undefined || isRetryable(result);
  });
}

/** The agents the confirm button would send: selected and selectable. */
export function agentsToSend(
  stale: HostedOwnerAgent[],
  selected: ReadonlySet<string>,
  results: Record<string, RebindResult>,
): HostedOwnerAgent[] {
  return selectableAgents(stale, results).filter((agent) =>
    selected.has(agent.providerAgentId),
  );
}

/** Fold one response into the results so far. */
export function mergeResults(
  previous: Record<string, RebindResult>,
  next: RebindResult[],
): Record<string, RebindResult> {
  const merged = { ...previous };
  for (const result of next) merged[result.providerAgentId] = result;
  return merged;
}

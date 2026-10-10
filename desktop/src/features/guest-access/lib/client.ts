import { invokeTauri } from "@/shared/api/tauri";

import {
  parseAccessLog,
  parseApproval,
  parseApprovalList,
  parseBlockList,
  parseDigest,
  parseGrant,
  parseGrantList,
  parseIdentityStatus,
  parseOwnerAgents,
  parseShareableList,
  parseSuggestionList,
  type ApprovalDecision,
  type GrantScope,
  type GuestApproval,
} from "./wire";

/** Build-time route plus the community id the harness also uses. */
export type GuestAccessConfig = {
  routeUrl: string | null;
  communityId: string;
};

/** A route error: the contract's `error` code plus the HTTP status, if any. */
export class GuestAccessError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, status: number | null, message?: string | null) {
    super(message || describeGuestAccessError(code));
    this.name = "GuestAccessError";
    this.code = code;
    this.status = status;
  }
}

/** Plain-language text for the route's error codes. */
export function describeGuestAccessError(code: string): string {
  switch (code) {
    case "guest_route_unavailable":
      return "Guest access isn't available in this build.";
    case "guest_route_unreachable":
    case "guest_route_timeout":
      return "Couldn't reach the guest access service. Check your connection and try again.";
    case "owner_not_linked":
      return "Link your account to manage guest access for your agents.";
    case "approval_already_decided":
      return "This request was already decided.";
    case "approval_expired":
      return "This request expired before it was decided.";
    case "code_invalid":
      return "That code isn't valid. Check it and try again.";
    case "code_expired":
      return "That code has expired. Get a new one and try again.";
    case "key_already_claimed":
      return "This Buzz identity is already linked to another account.";
    case "user_already_bound":
      return "Your account is already linked to a different Buzz identity.";
    case "grantee_not_linked":
      return "That person hasn't linked their account yet, so a grant can't be created.";
    case "nip98_replayed":
    case "nip98_expired":
      return "The request signature expired. Check your clock and try again.";
    case "rate_limited":
      return "Too many requests. Wait a moment and try again.";
    default:
      return "Guest access request failed.";
  }
}

/** Parse a Tauri command rejection from `guest_access_request`. */
export function toGuestAccessError(error: unknown): GuestAccessError {
  if (error instanceof GuestAccessError) return error;
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  try {
    const parsed = JSON.parse(text) as {
      error?: unknown;
      status?: unknown;
      message?: unknown;
    };
    if (parsed && typeof parsed.error === "string") {
      return new GuestAccessError(
        parsed.error,
        typeof parsed.status === "number" ? parsed.status : null,
        typeof parsed.message === "string" ? parsed.message : null,
      );
    }
  } catch {
    // Not a structured route error.
  }
  return new GuestAccessError("request_failed", null, text || null);
}

type Transport = {
  config: () => Promise<GuestAccessConfig>;
  request: (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ) => Promise<unknown>;
  profileOwner: (profileEventJson: string) => Promise<string | null>;
};

const tauriTransport: Transport = {
  config: () => invokeTauri<GuestAccessConfig>("guest_access_config"),
  request: async (method, path, body) => {
    try {
      return await invokeTauri<unknown>("guest_access_request", {
        method,
        path,
        body: body === undefined ? null : body,
      });
    } catch (error) {
      throw toGuestAccessError(error);
    }
  },
  profileOwner: (profileEventJson) =>
    invokeTauri<string | null>("guest_access_profile_owner", {
      profileEventJson,
    }),
};

let transport: Transport = tauriTransport;

/** Test seam: replace the native transport. Returns a restore function. */
export function setGuestAccessTransportForTests(next: Partial<Transport>) {
  const previous = transport;
  transport = { ...transport, ...next };
  return () => {
    transport = previous;
  };
}

function query(params: Record<string, string | number | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

function idempotencyKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

export const guestAccessApi = {
  config: () => transport.config(),
  profileOwner: (profileEventJson: string) =>
    transport.profileOwner(profileEventJson),

  identityStatus: async () =>
    parseIdentityStatus(await transport.request("GET", "/identity/status")),
  linkIdentity: async (communityId: string, code: string) => {
    const result = (await transport.request("POST", "/identity/link", {
      community_id: communityId,
      code: code.trim(),
    })) as { display_name?: unknown } | null;
    return {
      displayName:
        typeof result?.display_name === "string" ? result.display_name : null,
    };
  },

  ownerAgents: async () =>
    parseOwnerAgents(await transport.request("GET", "/owner/agents")),
  setAgentEnabled: (guestEndpointId: string, enabled: boolean) =>
    transport.request("PATCH", `/owner/agents/${guestEndpointId}`, {
      enabled,
    }),

  pendingApprovals: async () =>
    parseApprovalList(
      await transport.request(
        "GET",
        `/owner/approvals${query({ state: "pending", limit: 50 })}`,
      ),
    ),
  approval: async (approvalId: string): Promise<GuestApproval> => {
    const approval = parseApproval(
      await transport.request("GET", `/owner/approvals/${approvalId}`),
    );
    if (!approval) throw new GuestAccessError("approval_invalid", null);
    return approval;
  },
  decide: async (
    approvalId: string,
    input: {
      decision: ApprovalDecision;
      editedText?: string;
      grant?: { scope: GrantScope; days?: number } | null;
      idempotencyKey?: string;
    },
  ) => {
    const result = (await transport.request(
      "POST",
      `/owner/approvals/${approvalId}/decision`,
      {
        decision: input.decision,
        ...(input.decision === "approve_edited"
          ? { edited_text: input.editedText ?? "" }
          : {}),
        ...(input.grant ? { grant: input.grant } : {}),
        idempotency_key:
          input.idempotencyKey ?? idempotencyKey(`desktop-decision`),
      },
    )) as Record<string, unknown> | null;
    return {
      approval: parseApproval(result?.approval),
      grant: parseGrant(result?.grant),
      publicationId:
        typeof result?.publication_id === "string"
          ? result.publication_id
          : null,
    };
  },

  grants: async (agent?: string | null) =>
    parseGrantList(
      await transport.request("GET", `/owner/grants${query({ agent })}`),
    ),
  createGrant: async (input: {
    guestEndpointId: string;
    granteePubkey: string;
    scope: GrantScope;
    days?: number;
    questionKind?: string | null;
    dataSources: string[];
  }) =>
    parseGrant(
      await transport.request("POST", "/owner/grants", {
        guest_endpoint_id: input.guestEndpointId,
        grantee_pubkey: input.granteePubkey,
        scope: input.scope,
        ...(input.days ? { days: input.days } : {}),
        ...(input.questionKind ? { question_kind: input.questionKind } : {}),
        data_sources: input.dataSources,
      }),
    ),
  revokeGrant: (grantId: string) =>
    transport.request("DELETE", `/owner/grants/${grantId}`),

  blocks: async () =>
    parseBlockList(await transport.request("GET", "/owner/blocks")),
  block: (input: {
    pubkey: string;
    guestEndpointId?: string | null;
    reason?: string;
  }) =>
    transport.request("POST", "/owner/blocks", {
      guest_endpoint_id: input.guestEndpointId ?? null,
      pubkey: input.pubkey,
      ...(input.reason ? { reason: input.reason } : {}),
    }),
  unblock: (blockId: string) =>
    transport.request("DELETE", `/owner/blocks/${blockId}`),

  accessLog: async (agent?: string | null, cursor?: string | null) =>
    parseAccessLog(
      await transport.request(
        "GET",
        `/owner/access-log${query({ agent, cursor, limit: 50 })}`,
      ),
    ),
  digest: async (date?: string) =>
    parseDigest(
      await transport.request("GET", `/owner/digest${query({ date })}`),
    ),

  shareables: async () =>
    parseShareableList(await transport.request("GET", "/owner/shareables")),
  addShareable: (input: {
    resourceKind: "status" | "note" | "knowledge_item";
    content?: string;
    resourceId?: string;
    guestEndpointId?: string | null;
    expiresInDays?: number;
  }) =>
    transport.request("POST", "/owner/shareables", {
      resource_kind: input.resourceKind,
      ...(input.content ? { content: input.content } : {}),
      ...(input.resourceId ? { resource_id: input.resourceId } : {}),
      ...(input.guestEndpointId
        ? { guest_endpoint_id: input.guestEndpointId }
        : {}),
      ...(input.expiresInDays ? { expires_in_days: input.expiresInDays } : {}),
    }),
  removeShareable: (shareableId: string) =>
    transport.request("DELETE", `/owner/shareables/${shareableId}`),

  suggestions: async () =>
    parseSuggestionList(await transport.request("GET", "/owner/suggestions")),
  decideSuggestion: (suggestionId: string, accept: boolean) =>
    transport.request(
      "POST",
      `/owner/suggestions/${suggestionId}/${accept ? "accept" : "dismiss"}`,
      {},
    ),
};

/**
 * Typed views of the hosted guest-access route's owner and identity records
 * (contracts §5–§9). The route speaks snake_case and may add fields at any
 * time, so every reader here tolerates missing or unknown fields and never
 * throws on a malformed record.
 */

export type GrantScope =
  | "once"
  | "thread"
  | "person_days"
  | "question_kind"
  | "always";

export type ApprovalDecision =
  | "approve"
  | "approve_edited"
  | "deny"
  | "deny_and_block";

export type ApprovalState =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled";

export type GuestRequester = {
  pubkey: string;
  displayName: string | null;
  linked: boolean;
  viaAgentPubkey: string | null;
};

export type GuestClassifier = {
  route: string | null;
  severity: string | null;
  categories: string[];
  topScores: Record<string, number>;
};

export type GuestApproval = {
  approvalId: string;
  agent: {
    guestEndpointId: string | null;
    pubkey: string | null;
    displayName: string | null;
  };
  source: string;
  guestTurnId: string | null;
  requester: GuestRequester;
  questionText: string | null;
  draftText: string | null;
  dataSources: string[];
  ownerOnlySources: string[];
  questionKind: string | null;
  classifier: GuestClassifier;
  reasonCodes: string[];
  channel: {
    id: string | null;
    type: "channel" | "dm" | null;
    name: string | null;
    audienceTotal: number | null;
  };
  state: ApprovalState;
  createdAt: string | null;
  expiresAt: string | null;
  decidedAt: string | null;
  approvalUrl: string | null;
};

export type GuestGrant = {
  grantId: string;
  guestEndpointId: string | null;
  grantee: {
    userId: string | null;
    pubkey: string | null;
    displayName: string | null;
    kind: string | null;
  };
  scope: GrantScope;
  threadRootEventId: string | null;
  questionKind: string | null;
  dataSources: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string | null;
};

export type GuestBlock = {
  blockId: string;
  guestEndpointId: string | null;
  pubkey: string;
  displayName: string | null;
  reason: string | null;
  createdAt: string | null;
};

export type GuestAccessLogEntry = {
  entryId: string;
  at: string | null;
  guestTurnId: string | null;
  guestEndpointId: string | null;
  requester: GuestRequester;
  tier: number | null;
  outcome: string;
  dataSources: string[];
  classifier: GuestClassifier;
  approvalId: string | null;
  questionText: string | null;
};

export type GuestShareable = {
  shareableId: string;
  guestEndpointId: string | null;
  resourceKind: "knowledge_item" | "status" | "note" | string;
  resourceId: string | null;
  content: string | null;
  audienceKind: string | null;
  expiresAt: string | null;
  createdAt: string | null;
};

export type GuestSuggestion = {
  suggestionId: string;
  guestEndpointId: string | null;
  grantee: { userId: string | null; displayName: string | null };
  questionKind: string | null;
  dataSources: string[];
  approvalsCount: number;
  proposedScope: GrantScope;
};

export type GuestDigest = {
  date: string;
  total: number;
  byOutcome: Record<string, number>;
  byRequester: Array<{
    pubkey: string;
    displayName: string | null;
    count: number;
  }>;
  flaggedRequests: number;
  pendingApprovals: number;
  openSuggestions: number;
};

export type GuestOwnerAgent = {
  guestEndpointId: string;
  pubkey: string;
  displayName: string | null;
  enabled: boolean;
  respondTo: string | null;
  lastSeenAt: string | null;
};

export type IdentityStatus = {
  linked: boolean;
  displayName: string | null;
  linkUrl: string | null;
};

type Raw = Record<string, unknown>;

function obj(value: unknown): Raw {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : {};
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
function items(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = obj(value);
  return Array.isArray(record.items) ? record.items : [];
}

const SCOPES: readonly GrantScope[] = [
  "once",
  "thread",
  "person_days",
  "question_kind",
  "always",
];
function scope(value: unknown): GrantScope {
  return SCOPES.includes(value as GrantScope) ? (value as GrantScope) : "once";
}

const STATES: readonly ApprovalState[] = [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
];

function requester(value: unknown): GuestRequester {
  const raw = obj(value);
  return {
    pubkey: str(raw.pubkey) ?? "",
    displayName: str(raw.display_name),
    linked: raw.linked === true,
    viaAgentPubkey: str(raw.via_agent_pubkey),
  };
}

function classifier(value: unknown): GuestClassifier {
  const raw = obj(value);
  const scores: Record<string, number> = {};
  for (const [key, score] of Object.entries(
    obj(raw.top_scores ?? raw.scores),
  )) {
    if (typeof score === "number" && Number.isFinite(score)) {
      scores[key] = score;
    }
  }
  return {
    route: str(raw.route),
    severity: str(raw.severity),
    categories: strings(raw.categories),
    topScores: scores,
  };
}

export function parseApproval(value: unknown): GuestApproval | null {
  const raw = obj(value);
  const approvalId = str(raw.approval_id);
  if (!approvalId) return null;
  const agent = obj(raw.agent);
  const channel = obj(raw.channel);
  const channelType =
    channel.type === "dm" || channel.type === "channel" ? channel.type : null;
  return {
    approvalId,
    agent: {
      guestEndpointId: str(agent.guest_endpoint_id),
      pubkey: str(agent.pubkey),
      displayName: str(agent.display_name),
    },
    source: str(raw.source) ?? "guest_turn",
    guestTurnId: str(raw.guest_turn_id),
    requester: requester(raw.requester),
    questionText:
      typeof raw.question_text === "string" ? raw.question_text : null,
    draftText: typeof raw.draft_text === "string" ? raw.draft_text : null,
    dataSources: strings(raw.data_sources),
    ownerOnlySources: strings(raw.owner_only_sources),
    questionKind: str(raw.question_kind),
    classifier: classifier(raw.classifier),
    reasonCodes: strings(raw.reason_codes),
    channel: {
      id: str(channel.id),
      type: channelType,
      name: str(channel.name),
      audienceTotal: num(channel.audience_total),
    },
    state: STATES.includes(raw.state as ApprovalState)
      ? (raw.state as ApprovalState)
      : "pending",
    createdAt: str(raw.created_at),
    expiresAt: str(raw.expires_at),
    decidedAt: str(raw.decided_at),
    approvalUrl: str(raw.approval_url),
  };
}

export function parseApprovalList(value: unknown): GuestApproval[] {
  return items(value).flatMap((entry) => parseApproval(entry) ?? []);
}

export function parseGrant(value: unknown): GuestGrant | null {
  const raw = obj(value);
  const grantId = str(raw.grant_id);
  if (!grantId) return null;
  const grantee = obj(raw.grantee);
  return {
    grantId,
    guestEndpointId: str(raw.guest_endpoint_id),
    grantee: {
      userId: str(grantee.user_id),
      pubkey: str(grantee.pubkey),
      displayName: str(grantee.display_name),
      kind: str(grantee.kind),
    },
    scope: scope(raw.scope),
    threadRootEventId: str(raw.thread_root_event_id),
    questionKind: str(raw.question_kind),
    dataSources: strings(raw.data_sources),
    expiresAt: str(raw.expires_at),
    revokedAt: str(raw.revoked_at),
    useCount: num(raw.use_count) ?? 0,
    lastUsedAt: str(raw.last_used_at),
    createdAt: str(raw.created_at),
  };
}

export function parseGrantList(value: unknown): GuestGrant[] {
  return items(value).flatMap((entry) => parseGrant(entry) ?? []);
}

export function parseBlockList(value: unknown): GuestBlock[] {
  return items(value).flatMap((entry) => {
    const raw = obj(entry);
    const blockId = str(raw.block_id);
    const pubkey = str(raw.pubkey);
    if (!blockId || !pubkey) return [];
    return [
      {
        blockId,
        guestEndpointId: str(raw.guest_endpoint_id),
        pubkey,
        displayName: str(raw.display_name),
        reason: str(raw.reason),
        createdAt: str(raw.created_at),
      },
    ];
  });
}

export function parseAccessLog(value: unknown): {
  items: GuestAccessLogEntry[];
  nextCursor: string | null;
} {
  const raw = obj(value);
  return {
    items: items(value).flatMap((entry) => {
      const row = obj(entry);
      const entryId = str(row.entry_id);
      if (!entryId) return [];
      return [
        {
          entryId,
          at: str(row.at),
          guestTurnId: str(row.guest_turn_id),
          guestEndpointId: str(row.guest_endpoint_id),
          requester: requester(row.requester),
          tier: num(row.tier),
          outcome: str(row.outcome) ?? "unknown",
          dataSources: strings(row.data_sources),
          classifier: classifier(row.classifier),
          approvalId: str(row.approval_id),
          questionText: str(row.question_text),
        },
      ];
    }),
    nextCursor: str(raw.next_cursor),
  };
}

export function parseShareableList(value: unknown): GuestShareable[] {
  return items(value).flatMap((entry) => {
    const raw = obj(entry);
    const shareableId = str(raw.shareable_id);
    if (!shareableId) return [];
    return [
      {
        shareableId,
        guestEndpointId: str(raw.guest_endpoint_id),
        resourceKind: str(raw.resource_kind) ?? "note",
        resourceId: str(raw.resource_id),
        content: str(raw.content),
        audienceKind: str(raw.audience_kind),
        expiresAt: str(raw.expires_at),
        createdAt: str(raw.created_at),
      },
    ];
  });
}

export function parseSuggestionList(value: unknown): GuestSuggestion[] {
  return items(value).flatMap((entry) => {
    const raw = obj(entry);
    const suggestionId = str(raw.suggestion_id);
    if (!suggestionId) return [];
    const grantee = obj(raw.grantee);
    return [
      {
        suggestionId,
        guestEndpointId: str(raw.guest_endpoint_id),
        grantee: {
          userId: str(grantee.user_id),
          displayName: str(grantee.display_name),
        },
        questionKind: str(raw.question_kind),
        dataSources: strings(raw.data_sources),
        approvalsCount: num(raw.approvals_count) ?? 0,
        proposedScope: scope(raw.proposed_scope),
      },
    ];
  });
}

export function parseDigest(value: unknown): GuestDigest {
  const raw = obj(value);
  const byOutcome: Record<string, number> = {};
  for (const [key, count] of Object.entries(obj(raw.by_outcome))) {
    if (typeof count === "number") byOutcome[key] = count;
  }
  return {
    date: str(raw.date) ?? "",
    total: num(raw.total) ?? 0,
    byOutcome,
    byRequester: (Array.isArray(raw.by_requester) ? raw.by_requester : [])
      .map((entry) => {
        const row = obj(entry);
        return {
          pubkey: str(row.pubkey) ?? "",
          displayName: str(row.display_name),
          count: num(row.count) ?? 0,
        };
      })
      .filter((row) => row.pubkey.length > 0),
    flaggedRequests: num(raw.flagged_requests) ?? 0,
    pendingApprovals: num(raw.pending_approvals) ?? 0,
    openSuggestions: num(raw.open_suggestions) ?? 0,
  };
}

export function parseOwnerAgents(value: unknown): GuestOwnerAgent[] {
  const raw = obj(value);
  const list = Array.isArray(raw.agents) ? raw.agents : items(value);
  return list.flatMap((entry) => {
    const row = obj(entry);
    const guestEndpointId = str(row.guest_endpoint_id);
    const pubkey = str(row.pubkey);
    if (!guestEndpointId || !pubkey) return [];
    return [
      {
        guestEndpointId,
        pubkey: pubkey.toLowerCase(),
        displayName: str(row.display_name),
        enabled: row.enabled !== false,
        respondTo: str(row.respond_to),
        lastSeenAt: str(row.last_seen_at),
      },
    ];
  });
}

export function parseIdentityStatus(value: unknown): IdentityStatus {
  const raw = obj(value);
  return {
    linked: raw.linked === true,
    displayName: str(raw.display_name),
    linkUrl: str(raw.link_url),
  };
}

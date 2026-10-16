import { invokeTauri } from "@/shared/api/tauri";

/**
 * Remote signer bridge. The backend validates every request, holds the key
 * and signs; the renderer only shows what it receives here and sends back a
 * decision. Scopes are created only through `decide`.
 */

/** Tauri event the backend emits whenever the snapshot changes. */
export const REMOTE_SIGNER_CHANGED_EVENT = "remote-signer-changed";

export type RemoteSignerStatus =
  | "off"
  | "unavailable"
  | "connecting"
  | "listening"
  | "error";

export type RemoteSignerScope = {
  id: string;
  kind: "publish" | "read";
  /** Publish kinds covered (empty for reads). */
  kinds: number[];
  /** `null` only for an all-channels read scope. */
  channelId: string | null;
  createdAt: number;
  expiresAt: number;
};

export type RemoteSignerLogEntry = {
  at: number;
  requestId: string | null;
  action: string;
  channelId: string | null;
  /** `prompt`, `scope:<id>` or `automatic`. */
  decision: string;
  /** signed, declined, refused, expired, cancelled or failed. */
  outcome: string;
  eventId: string | null;
  detail: string | null;
};

export type RemoteSignerRequester = {
  mcpClient: string | null;
  sessionId: string | null;
  jobId: string | null;
  agentId: string | null;
  label: string | null;
};

export type RemoteSignerReadView = {
  kinds: number[];
  channelIds: string[];
  /** Some filter is not bound to a channel. */
  unbound: boolean;
  search: string | null;
  filtersJson: string;
};

export type RemoteSignerPrompt = {
  requestId: string;
  method: "publish" | "read";
  action: string;
  serverActionLabel: string | null;
  kind: number | null;
  content: string | null;
  /** Where the event is posted (its `h` tag), or the channel a read is bound to. */
  channelId: string | null;
  /** The channel the requester reported. */
  reportedChannelId: string | null;
  targetEventId: string | null;
  targetContent: string | null;
  mentions: string[];
  isReply: boolean;
  read: RemoteSignerReadView | null;
  requester: RemoteSignerRequester;
  deadlineMs: number;
};

export type RemoteSignerSnapshot = {
  available: boolean;
  enabled: boolean;
  status: RemoteSignerStatus;
  lastError: string | null;
  communityId: string | null;
  signerPubkey: string | null;
  scopes: RemoteSignerScope[];
  log: RemoteSignerLogEntry[];
  prompt: RemoteSignerPrompt | null;
};

export type ScopeDurationMinutes = 15 | 60 | 480;

export type ScopeChoice = {
  durationMinutes: ScopeDurationMinutes;
  /** Publish scopes: kinds to cover (the request's kind is always included). */
  kinds?: number[];
  /** Read scopes: all my channels instead of this channel. */
  allChannels?: boolean;
};

export type RemoteSignerDecision = {
  requestId: string;
  choice: "allowOnce" | "deny" | "allowScope";
  scope?: ScopeChoice;
};

export const remoteSignerApi = {
  /** Current state; also starts or stops the poller to match the switch. */
  snapshot: () => invokeTauri<RemoteSignerSnapshot>("remote_signer_snapshot"),
  setEnabled: (enabled: boolean) =>
    invokeTauri<RemoteSignerSnapshot>("remote_signer_set_enabled", {
      enabled,
    }),
  decide: (decision: RemoteSignerDecision) =>
    invokeTauri<RemoteSignerSnapshot>("remote_signer_decide", { decision }),
  /** Revoke one scope, or all of them when `scopeId` is omitted. */
  revokeScopes: (scopeId?: string) =>
    invokeTauri<RemoteSignerSnapshot>("remote_signer_revoke_scopes", {
      scopeId: scopeId ?? null,
    }),
};

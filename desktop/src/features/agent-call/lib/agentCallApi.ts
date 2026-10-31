import { invokeTauri } from "@/shared/api/tauri";

import type { AgentCallFeed } from "./agentCallFeed";
import {
  parseVoiceSettings,
  parseVoiceStartProvider,
  type VoiceProviderId,
  type VoiceSettings,
  type VoiceStartProvider,
  VoiceStreamFatalError,
  voiceProviderUnavailableSentence,
} from "./voice-stream";

/**
 * The agent host's call routes, reached through the native
 * `agent_voice_request` command (NIP-98 signed by the signed-in user; the
 * key never enters the webview). Every route is the caller's own: the host
 * starts a call only from the caller's private 1:1 DM with the agent and
 * serves each call to its caller only.
 */

type Raw = { status: number; body: unknown };
type Send = (method: string, path: string, body?: unknown) => Promise<Raw>;

export class AgentCallApiError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  /** `details.reason` of `voice_provider_unavailable` (a code, never content). */
  readonly reason: string | null;
  constructor(
    status: number | null,
    code: string | null,
    reason?: string | null,
  ) {
    super(code ?? `status_${status ?? "unknown"}`);
    this.name = "AgentCallApiError";
    this.status = status;
    this.code = code;
    this.reason = reason ?? null;
  }
}

function reasonOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const details = (body as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

const tauriSend: Send = async (method, path, body) => {
  const raw = await invokeTauri<Raw>("agent_voice_request", {
    method,
    path,
    body: body === undefined ? null : JSON.stringify(body),
  });
  return raw;
};

let send: Send = tauriSend;

/** Test seam: replace the native request. Returns a restore function. */
export function setAgentCallSendForTests(next: Send) {
  const previous = send;
  send = next;
  return () => {
    send = previous;
  };
}

function codeOf(body: unknown): string | null {
  if (body && typeof body === "object" && "error" in body) {
    const code = (body as { error?: unknown }).error;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function nativeCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

/** One signed request to the agent host's Buzz mount (the agent DM's other features use it too). */
export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let raw: Raw;
  try {
    raw = await send(method, path, body);
  } catch (error) {
    throw new AgentCallApiError(null, nativeCode(error) ?? "network");
  }
  if (raw.status < 200 || raw.status >= 300) {
    throw new AgentCallApiError(
      raw.status,
      codeOf(raw.body),
      reasonOf(raw.body),
    );
  }
  return raw.body as T;
}

const call = (callId: string) => `calls/${encodeURIComponent(callId)}`;

export function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type StartAgentCallCommon = {
  callId: string;
  executeUntil: string | null;
  /** Null from a host older than the provider choice. */
  provider: VoiceStartProvider | null;
};

/** GPT-Live answers the SDP offer; Gemini returns a stream offer (§9.3). */
export type StartAgentCallResponse =
  | (StartAgentCallCommon & { transport: "webrtc"; sdpAnswer: string })
  | (StartAgentCallCommon & { transport: "gemini_ws"; stream: unknown });

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseStartAgentCallResponse(
  value: unknown,
): StartAgentCallResponse {
  const record = asRecord(value) ?? {};
  if (typeof record.callId !== "string" || !record.callId) {
    throw new AgentCallApiError(null, "voice_call_response_invalid");
  }
  const common: StartAgentCallCommon = {
    callId: record.callId,
    executeUntil:
      typeof record.executeUntil === "string" ? record.executeUntil : null,
    provider: parseVoiceStartProvider(record.provider),
  };
  if (record.transport === "gemini_ws") {
    if (!asRecord(record.stream)) {
      throw new AgentCallApiError(null, "voice_call_response_invalid");
    }
    return { ...common, transport: "gemini_ws", stream: record.stream };
  }
  if (typeof record.sdpAnswer !== "string" || !record.sdpAnswer) {
    throw new AgentCallApiError(null, "voice_call_response_invalid");
  }
  return { ...common, transport: "webrtc", sdpAnswer: record.sdpAnswer };
}

export async function startAgentCall(input: {
  agentPubkey: string;
  channelId: string;
  /** Required unless the call may resolve to Gemini. */
  sdpOffer?: string;
  /** The one-tap choice; omitted = the caller's precedence (§4.1). */
  provider?: VoiceProviderId;
  /** `gemini_ws` when this app runs the stream transport. */
  clientCapabilities?: string[];
  clientTapAt?: string;
}): Promise<StartAgentCallResponse> {
  return parseStartAgentCallResponse(
    await request<unknown>("POST", "calls", {
      ...input,
      clientDiagnostics: { systemCallUI: "none" },
    }),
  );
}

/**
 * A fresh stream offer for a live Gemini call (reconnect or handover). A
 * call that can't take a stream any more throws VoiceStreamFatalError.
 */
export async function getAgentCallStreamToken(
  callId: string,
): Promise<unknown> {
  try {
    const body = await request<unknown>(
      "POST",
      `${call(callId)}/stream-token`,
      {},
    );
    return asRecord(body)?.stream;
  } catch (error) {
    if (
      error instanceof AgentCallApiError &&
      (error.status === 404 ||
        error.status === 401 ||
        error.code === "voice_call_not_live" ||
        error.code === "voice_provider_mismatch")
    ) {
      throw new VoiceStreamFatalError(error.code ?? `http_${error.status}`);
    }
    throw error;
  }
}

/** The call view (read for `state: "ended"`, which stops stream reconnects). */
export function getAgentCall(callId: string): Promise<unknown> {
  return request("GET", call(callId));
}

/** The API host a stream offer may point at (the call routes' own host). */
export async function getAgentCallStreamHost(): Promise<string | null> {
  try {
    return await invokeTauri<string>("agent_voice_stream_host");
  } catch {
    return null;
  }
}

/** The caller's voice settings for this agent (§9.1), by its key. */
export async function getAgentVoiceSettings(
  agentPubkey: string,
): Promise<VoiceSettings | null> {
  try {
    return parseVoiceSettings(
      await request<unknown>(
        "GET",
        `settings?agentPubkey=${encodeURIComponent(agentPubkey)}`,
      ),
    );
  } catch (error) {
    // A host without the settings read: no chooser.
    if (
      error instanceof AgentCallApiError &&
      (error.status === 404 || error.status === 405)
    ) {
      return null;
    }
    throw error;
  }
}

/** "Make … my default" (`null` clears it). */
export async function setAgentVoiceDefault(
  provider: VoiceProviderId | null,
  expectedRevision: number,
): Promise<VoiceSettings | null> {
  return parseVoiceSettings(
    await request<unknown>("PUT", "settings", {
      defaultProvider: provider,
      expectedRevision,
    }),
  );
}

/** "Always use … for <agent>" (`null` clears it), by the agent's id. */
export async function setAgentVoiceOverride(
  agentId: string,
  provider: VoiceProviderId | null,
  expectedRevision: number,
): Promise<VoiceSettings | null> {
  return parseVoiceSettings(
    await request<unknown>(
      "PUT",
      `settings/agents/${encodeURIComponent(agentId)}`,
      { provider, expectedRevision },
    ),
  );
}

/** One sentence for a failed settings write. */
export function describeAgentVoiceSettingsError(error: unknown): string {
  const code = error instanceof AgentCallApiError ? error.code : null;
  switch (code) {
    case "voice_settings_conflict":
      return "Your voice choice changed on another device. Showing the latest.";
    case "voice_provider_unsupported":
      return "That voice isn't one Kiingo offers.";
    case "agent_not_found":
      return "This isn't an agent you can call.";
    default:
      return "Couldn't save your voice choice. Try again.";
  }
}

/** Codes that mean the chosen voice can't take this call. */
export function isProviderUnavailableError(error: unknown): boolean {
  const code = error instanceof AgentCallApiError ? error.code : null;
  return (
    code === "voice_provider_unavailable" ||
    code === "voice_transport_unsupported" ||
    code === "voice_provider_unsupported" ||
    code === "voice_stream_origin_unconfigured"
  );
}

export function endAgentCall(callId: string, reason: string): Promise<unknown> {
  return request("POST", `${call(callId)}/end`, { reason });
}

export type StopAgentCallWorkOutcome = "stopped" | "nothing_to_stop";

/** Stops the agent's current work (its Run stop control); the call goes on. */
export async function stopAgentCallWork(
  callId: string,
): Promise<StopAgentCallWorkOutcome> {
  try {
    await request("POST", `${call(callId)}/stop`, {
      idempotencyKey: newIdempotencyKey(),
    });
    return "stopped";
  } catch (error) {
    if (
      error instanceof AgentCallApiError &&
      error.code === "voice_nothing_to_stop"
    ) {
      return "nothing_to_stop";
    }
    throw error;
  }
}

/** Feed v2 long-poll: the whole snapshot, or `{ rev, unchanged: true }`. */
export function getAgentCallFeed(
  callId: string,
  rev: string | null,
  waitSeconds: number,
): Promise<AgentCallFeed | { rev: string; unchanged: true }> {
  const query = new URLSearchParams();
  if (rev) query.set("rev", rev);
  query.set("wait", String(Math.max(0, Math.min(20, waitSeconds))));
  return request("GET", `${call(callId)}/feed?${query.toString()}`);
}

/** Tap an option of the call's open question (exactly the ask that asked). */
export function answerAgentCallQuestion(input: {
  callId: string;
  humanAskId: string;
  questionId: string | null;
  optionIndex: number;
}): Promise<unknown> {
  return request(
    "POST",
    `${call(input.callId)}/human-asks/${encodeURIComponent(input.humanAskId)}/answer`,
    {
      ...(input.questionId ? { questionId: input.questionId } : {}),
      optionIndex: input.optionIndex,
      idempotencyKey: newIdempotencyKey(),
    },
  );
}

/** Stop one ask's work, silently; the call goes on. */
export function cancelAgentCallAsk(
  callId: string,
  askKey: string,
): Promise<unknown> {
  return request("POST", `${call(callId)}/asks/cancel`, {
    askKey,
    idempotencyKey: newIdempotencyKey(),
  });
}

/** Archive hides a card (the work goes on); pin keeps it on top. */
export function setAgentCallAskState(
  callId: string,
  askKey: string,
  action: "archive" | "unarchive" | "pin" | "unpin",
): Promise<unknown> {
  return request("POST", `${call(callId)}/asks/state`, {
    askKey,
    action,
    idempotencyKey: newIdempotencyKey(),
  });
}

/** A plain sentence for a failed request (codes only, never content). */
export function describeAgentCallError(error: unknown): string {
  const code = error instanceof AgentCallApiError ? error.code : null;
  const status = error instanceof AgentCallApiError ? error.status : null;
  switch (code) {
    case "voice_call_in_progress":
      return "You're already on a call. Hang up there first.";
    case "voice_buzz_dm_required":
      return "Calls work only in your private DM with this agent.";
    case "voice_buzz_dm_unverified":
      return "Couldn't confirm this DM with the relay. Try again.";
    case "caller_not_allowed":
      return "Your account isn't linked for calls with this agent.";
    case "agent_not_found":
      return "This agent can't take calls.";
    case "voice_disabled":
      return "Calls are turned off for this agent.";
    case "voice_conversation_unavailable":
      return "This agent can't open a conversation with you yet.";
    case "rate_limited":
    case "voice_daily_limit":
      return "You've reached the call limit for now. Try again later.";
    case "voice_route_unavailable":
    case "voice_route_unreachable":
    case "voice_route_timeout":
    case "network":
      return "Couldn't reach the call service. Check your connection.";
    case "nip98_expired":
      return "The call request expired. Check your computer's clock.";
    case "voice_provider_unavailable":
    case "voice_provider_unsupported":
      return voiceProviderUnavailableSentence(
        error instanceof AgentCallApiError ? error.reason : null,
        "Gemini",
      );
    case "voice_transport_unsupported":
      return voiceProviderUnavailableSentence("client_transport", "Gemini");
    case "voice_stream_origin_unconfigured":
      return voiceProviderUnavailableSentence("provider_error", "Gemini");
    default:
      if (status === 401) return "Couldn't sign the call request. Try again.";
      return "Calls are unavailable right now. Try again.";
  }
}

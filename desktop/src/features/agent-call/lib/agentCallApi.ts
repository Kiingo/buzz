import { invokeTauri } from "@/shared/api/tauri";

import type { AgentCallFeed } from "./agentCallFeed";

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
  constructor(status: number | null, code: string | null) {
    super(code ?? `status_${status ?? "unknown"}`);
    this.name = "AgentCallApiError";
    this.status = status;
    this.code = code;
  }
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

async function request<T>(
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
    throw new AgentCallApiError(raw.status, codeOf(raw.body));
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

export type StartAgentCallResponse = {
  callId: string;
  sdpAnswer: string;
  executeUntil: string | null;
};

export function startAgentCall(input: {
  agentPubkey: string;
  channelId: string;
  sdpOffer: string;
  clientTapAt?: string;
}): Promise<StartAgentCallResponse> {
  return request<StartAgentCallResponse>("POST", "calls", {
    ...input,
    clientDiagnostics: { systemCallUI: "none" },
  });
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
    default:
      if (status === 401) return "Couldn't sign the call request. Try again.";
      return "Calls are unavailable right now. Try again.";
  }
}

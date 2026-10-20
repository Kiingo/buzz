/**
 * Agent DM markers v1 (docs/agent-dm-markers.md): strict parsers for the
 * signed tags an agent runtime publishes into a 1:1 DM, plus the shared
 * honour rule (DM channel, signer is a member). Every parser returns `null`
 * for anything malformed so the event degrades to its plain content.
 */

export const KIND_AGENT_DM_STREAM_MESSAGE = 9;
export const KIND_AGENT_DM_QUIET = 40002;

const HEX64_RE = /^[0-9a-f]{64}$/i;
const SURFACE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const UNIX_SECONDS_RE = /^\d{1,12}$/;
const COUNT_RE = /^\d{1,9}$/;
// Ids are embedded in plain-text commands (`/sessions load <id>`), so they
// must be a single printable token.
const TOKEN_RE = /^[\x21-\x7e]{1,128}$/;

export const MIRROR_SOURCE_ID_MAX = 256;
export const MIRROR_SUBJECT_MAX = 200;
export const SESSIONS_MAX_ITEMS = 20;
export const SESSION_TITLE_MAX = 200;
export const QUESTION_MAX_ITEMS = 4;
export const QUESTION_MAX_OPTIONS = 8;
export const QUESTION_TEXT_MAX = 1_000;
export const QUESTION_LABEL_MAX = 200;
export const ACTION_MAX_BUTTONS = 3;
export const ACTION_LABEL_MAX = 100;
export const ACTION_SEND_TEXT_MAX = 4_000;
export const ACTION_REF_MAX = 512;

type Tags = readonly (readonly string[])[] | undefined | null;

export type DmChannelLike = {
  channelType?: string | null;
  participantPubkeys?: readonly string[] | null;
  memberPubkeys?: readonly string[] | null;
};

function normalizeHex(value: string | undefined): string | null {
  return value && HEX64_RE.test(value) ? value.toLowerCase() : null;
}

function firstTag(tags: Tags, name: string) {
  return tags?.find((tag) => tag[0] === name);
}

function isText(value: string | undefined, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isNonEmptyText(
  value: string | undefined,
  max: number,
): value is string {
  return isText(value, max) && value.trim().length > 0;
}

export function isAgentDmChannel(channel: DmChannelLike | null | undefined) {
  return channel?.channelType === "dm";
}

function memberSet(channel: DmChannelLike) {
  return new Set(
    [
      ...(channel.participantPubkeys ?? []),
      ...(channel.memberPubkeys ?? []),
    ].map((pubkey) => pubkey.toLowerCase()),
  );
}

/**
 * Whether `pubkey` is a known member of the DM. `relayEnforced` treats an
 * unknown roster as membership: the relay only accepts DM events from
 * members, so the signer rule can rely on it, while author overrides cannot.
 */
export function isDmMember(
  channel: DmChannelLike,
  pubkey: string,
  relayEnforced: boolean,
) {
  const members = memberSet(channel);
  if (members.size === 0) return relayEnforced;
  return members.has(pubkey.toLowerCase());
}

/** The honour rule shared by every marker: DM channel, signed by a member. */
export function areAgentDmMarkersHonoured(
  channel: DmChannelLike | null | undefined,
  signerPubkey: string,
): channel is DmChannelLike {
  return (
    isAgentDmChannel(channel) &&
    normalizeHex(signerPubkey) !== null &&
    isDmMember(channel as DmChannelLike, signerPubkey, true)
  );
}

// ── 1. Mirrored history ────────────────────────────────────────────────────

export type MirrorAuthorRole = "requester" | "agent";

export type AgentMirror = {
  surface: string;
  sourceId: string;
  originalAt: number;
  role: MirrorAuthorRole;
  /** Claimed author pubkey (lowercase hex) or null. Never trusted alone. */
  authorPubkey: string | null;
  subject: string | null;
};

export function parseMirror(tags: Tags): AgentMirror | null {
  const mirror = firstTag(tags, "buzz-mirror");
  const author = firstTag(tags, "buzz-mirror-author");
  if (!mirror || !author) return null;
  const [, surface, sourceId, originalAt] = mirror;
  if (
    !surface ||
    !SURFACE_RE.test(surface) ||
    !isNonEmptyText(sourceId, MIRROR_SOURCE_ID_MAX) ||
    !originalAt ||
    !UNIX_SECONDS_RE.test(originalAt)
  ) {
    return null;
  }
  const [, role, pubkey = "", name = ""] = author;
  if (role !== "requester" && role !== "agent") return null;
  if (pubkey !== "" && normalizeHex(pubkey) === null) return null;
  if (typeof name !== "string") return null;
  const subjectTag = firstTag(tags, "subject");
  const subject = subjectTag?.[1];
  if (subjectTag && !isText(subject, MIRROR_SUBJECT_MAX)) return null;
  return {
    surface,
    sourceId,
    originalAt: Number(originalAt),
    role,
    authorPubkey: normalizeHex(pubkey),
    subject: subject?.trim() ? subject.trim() : null,
  };
}

const SURFACE_LABELS: Record<string, string> = {
  email: "via email",
  teams: "via Teams",
  sms: "via SMS",
  web: "via web",
  voice: "via voice call",
};

export function mirrorBadgeLabel(surface: string) {
  return SURFACE_LABELS[surface] ?? `via ${surface}`;
}

/**
 * The requester override applies only when the claimed pubkey is 64-hex,
 * differs from the signer and is a known member of this DM. Otherwise the row
 * stays the signer's and reads "Relayed by <signer>".
 */
export function mirrorDisplayAuthorPubkey(
  mirror: AgentMirror,
  signerPubkey: string,
  channel: DmChannelLike,
): string | null {
  if (mirror.role !== "requester" || !mirror.authorPubkey) return null;
  if (mirror.authorPubkey === signerPubkey.toLowerCase()) return null;
  return isDmMember(channel, mirror.authorPubkey, false)
    ? mirror.authorPubkey
    : null;
}

// ── 1b. Call card ─────────────────────────────────────────────────────────

export type AgentCallDirection = "inbound" | "outbound";

export type AgentCall = {
  direction: AgentCallDirection;
  durationS: number;
  /** Where the call happened, such as `web` or `buzz_huddle`. */
  surface: string;
};

/**
 * `["buzz-call", direction, durationS, surface]` on a `voice` mirror:
 * exactly one such tag of exactly four elements. Anything else is not a call
 * card and renders as the plain mirror.
 */
export function parseCall(tags: Tags): AgentCall | null {
  const mirror = parseMirror(tags);
  const calls = (tags ?? []).filter((tag) => tag[0] === "buzz-call");
  if (mirror?.surface !== "voice" || calls.length !== 1) return null;
  const tag = calls[0];
  if (tag?.length !== 4) return null;
  const [, direction, duration, surface] = tag;
  if (
    (direction !== "inbound" && direction !== "outbound") ||
    !duration ||
    !COUNT_RE.test(duration) ||
    !surface ||
    !SURFACE_RE.test(surface)
  ) {
    return null;
  }
  return { direction, durationS: Number(duration), surface };
}

/** "Call · N min", rounded and never below one minute. */
export function callTitle(call: AgentCall) {
  const minutes = Math.round(call.durationS / 60);
  return `Call · ${minutes < 1 ? 1 : minutes} min`;
}

const TRANSCRIPT_HEADER = "\n\nTranscript\n";

/**
 * A call card's readable content split into the summary (the head without
 * its own "Call · N min" line, since the card titles itself from the tag)
 * and everything after `Transcript`.
 */
export function splitCallContent(content: string): {
  summary: string;
  transcript: string | null;
} {
  const at = content.indexOf(TRANSCRIPT_HEADER);
  const head = at < 0 ? content : content.slice(0, at);
  const transcript =
    at < 0 ? null : content.slice(at + TRANSCRIPT_HEADER.length).trim();
  const parts = head.split("\n\n");
  const summary = (
    parts.length > 1 && parts[0]?.startsWith("Call ·")
      ? parts.slice(1).join("\n\n")
      : head
  ).trim();
  return { summary, transcript: transcript ? transcript : null };
}

// ── 2. Session divider ────────────────────────────────────────────────────

export type AgentSessionAction = "new" | "load" | "switch";

export type AgentSessionDivider = {
  action: AgentSessionAction;
  sessionId: string | null;
};

export function parseSessionDivider(tags: Tags): AgentSessionDivider | null {
  const tag = firstTag(tags, "buzz-session");
  if (!tag) return null;
  const [, action, sessionId = ""] = tag;
  if (action !== "new" && action !== "load" && action !== "switch") {
    return null;
  }
  if (sessionId !== "" && !TOKEN_RE.test(sessionId)) return null;
  return { action, sessionId: sessionId || null };
}

export function sessionDividerLabel(action: AgentSessionAction) {
  return action === "load" ? "Earlier session loaded" : "New session";
}

// ── 3. Sessions listing ───────────────────────────────────────────────────

export type AgentSessionItem = {
  sessionId: string;
  current: boolean;
  startedAt: number;
  lastActiveAt: number;
  title: string;
  loadable: boolean;
  turnCount: number;
};

export type AgentSessionsListing = {
  requestId: string | null;
  items: AgentSessionItem[];
};

function parseSessionItem(tag: readonly string[]): AgentSessionItem | null {
  const [, sessionId, state, started, lastActive, title, loadable, turns] = tag;
  if (
    !sessionId ||
    !TOKEN_RE.test(sessionId) ||
    (state !== "current" && state !== "previous") ||
    !started ||
    !UNIX_SECONDS_RE.test(started) ||
    !lastActive ||
    !UNIX_SECONDS_RE.test(lastActive) ||
    !isText(title, SESSION_TITLE_MAX) ||
    (loadable !== "1" && loadable !== "0") ||
    !turns ||
    !COUNT_RE.test(turns)
  ) {
    return null;
  }
  return {
    sessionId,
    current: state === "current",
    startedAt: Number(started),
    lastActiveAt: Number(lastActive),
    title: title.trim(),
    loadable: loadable === "1",
    turnCount: Number(turns),
  };
}

/** Malformed items are dropped; at most the first 20 are kept. */
export function parseSessionsListing(tags: Tags): AgentSessionsListing | null {
  const tag = firstTag(tags, "buzz-sessions");
  if (!tag) return null;
  const requestId = tag[1] ?? "";
  if (requestId !== "" && normalizeHex(requestId) === null) return null;
  const items: AgentSessionItem[] = [];
  const seen = new Set<string>();
  for (const itemTag of tags ?? []) {
    if (itemTag[0] !== "buzz-session-item") continue;
    if (items.length >= SESSIONS_MAX_ITEMS) break;
    const item = parseSessionItem(itemTag);
    if (!item || seen.has(item.sessionId)) continue;
    seen.add(item.sessionId);
    items.push(item);
  }
  return { requestId: normalizeHex(requestId), items };
}

// ── 4. Question card ──────────────────────────────────────────────────────

export type AgentQuestionOption = { label: string; description: string | null };

export type AgentQuestionItem = {
  qid: string;
  question: string;
  header: string | null;
  multi: boolean;
  allowOther: boolean;
  options: AgentQuestionOption[];
};

export type AgentQuestion = { askId: string; items: AgentQuestionItem[] };

/** Strict: any malformed question or option drops the whole card. */
export function parseQuestion(tags: Tags): AgentQuestion | null {
  const ask = firstTag(tags, "buzz-question");
  const askId = ask?.[1];
  if (!askId || !TOKEN_RE.test(askId)) return null;
  const items: AgentQuestionItem[] = [];
  const byQid = new Map<string, AgentQuestionItem>();
  for (const tag of tags ?? []) {
    if (tag[0] !== "buzz-question-item") continue;
    const [, qid, question, header = "", multi, allowOther] = tag;
    if (
      !qid ||
      !TOKEN_RE.test(qid) ||
      byQid.has(qid) ||
      !isNonEmptyText(question, QUESTION_TEXT_MAX) ||
      !isText(header, QUESTION_LABEL_MAX) ||
      (multi !== "0" && multi !== "1") ||
      (allowOther !== "0" && allowOther !== "1")
    ) {
      return null;
    }
    const item: AgentQuestionItem = {
      qid,
      question: question.trim(),
      header: header.trim() || null,
      multi: multi === "1",
      allowOther: allowOther === "1",
      options: [],
    };
    items.push(item);
    byQid.set(qid, item);
  }
  if (items.length < 1 || items.length > QUESTION_MAX_ITEMS) return null;
  for (const tag of tags ?? []) {
    if (tag[0] !== "buzz-question-option") continue;
    const [, qid, label, description = ""] = tag;
    const item = qid ? byQid.get(qid) : undefined;
    if (
      !item ||
      !isNonEmptyText(label, QUESTION_LABEL_MAX) ||
      !isText(description, QUESTION_TEXT_MAX) ||
      item.options.length >= QUESTION_MAX_OPTIONS ||
      item.options.some((option) => option.label === label.trim())
    ) {
      return null;
    }
    item.options.push({
      label: label.trim(),
      description: description.trim() || null,
    });
  }
  return { askId, items };
}

export type AgentQuestionStateValue = "answered" | "closed";

export type AgentQuestionStateMarker = {
  askId: string;
  state: AgentQuestionStateValue;
};

/** Any state other than `answered` closes the card. */
export function parseQuestionState(
  tags: Tags,
): AgentQuestionStateMarker | null {
  const tag = firstTag(tags, "buzz-question-state");
  const askId = tag?.[1];
  if (!tag || !askId || !TOKEN_RE.test(askId)) return null;
  return { askId, state: tag[2] === "answered" ? "answered" : "closed" };
}

/** `ask_id` from a user's `buzz-answer` tag, or null. */
export function parseAnswerAskId(tags: Tags): string | null {
  const askId = firstTag(tags, "buzz-answer")?.[1];
  return askId && TOKEN_RE.test(askId) ? askId : null;
}

// ── 5. Action buttons ─────────────────────────────────────────────────────

export type AgentAction = {
  actionId: string;
  label: string;
  sendText: string;
  primary: boolean;
  ref: string;
};

/** Malformed buttons are dropped; at most the first 3 are kept. */
export function parseActions(tags: Tags): AgentAction[] {
  const actions: AgentAction[] = [];
  const seen = new Set<string>();
  for (const tag of tags ?? []) {
    if (tag[0] !== "buzz-action") continue;
    if (actions.length >= ACTION_MAX_BUTTONS) break;
    const [, actionId, label, sendText, style, ref] = tag;
    if (
      !actionId ||
      !TOKEN_RE.test(actionId) ||
      seen.has(actionId) ||
      !isNonEmptyText(label, ACTION_LABEL_MAX) ||
      !isNonEmptyText(sendText, ACTION_SEND_TEXT_MAX) ||
      (style !== "primary" && style !== "secondary") ||
      !isNonEmptyText(ref, ACTION_REF_MAX)
    ) {
      continue;
    }
    seen.add(actionId);
    actions.push({
      actionId,
      label: label.trim(),
      sendText,
      primary: style === "primary",
      ref,
    });
  }
  return actions;
}

/** The tag a tapped action sends back, exactly `["buzz-action-ref", ref]`. */
export function actionRefTag(action: AgentAction): string[] {
  return ["buzz-action-ref", action.ref];
}

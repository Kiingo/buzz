// Generated from the Kiingo surface renderer packages at c72e3863b9419a77a51b527a9ff4255646c6384c; do not edit here.
import { isObject } from "./json";
import { comparableText, hasInvisibleText, plainText } from "./text";

// A control that sends words as the person's own message (`send_message`,
// suggestion chips; `ask_agent` on an MCP Apps page) sends ONLY words the
// person can see on it (79 H1/W1/M1). The control draws its label and, when
// the words differ, the words themselves in full; past SENDS_MAX, or holding
// an invisible character, it is disabled with "Open in Kiingo".

/** The longest words a control may send, shown in full (code points). */
export const SENDS_MAX = 300;

/**
 * The most line breaks words may hold (79 S2): past it a caption could push
 * the tail out of sight ("Sounds good" + 280 newlines), so it is blocked.
 */
export const SENDS_MAX_LINE_BREAKS = 3;

const LINE_BREAKS = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/gu;

/**
 * The longest label a control draws in full on one line (code points); a
 * longer label that is also the words gets the words drawn under it.
 */
export const SENDS_LABEL_MAX = 80;

/** Shown on a control that can't send here. */
export const SENDS_BLOCKED_TEXT = "Open in Kiingo to send this";

export type MessageSend =
  /** The label is the words: the control draws it and sends it. */
  | { kind: "label"; text: string }
  /** The words differ: drawn in full under the label ({@link sendsCaption}). */
  | { kind: "sends"; text: string }
  /**
   * Disabled: too long to show in full (or more than
   * {@link SENDS_MAX_LINE_BREAKS} lines), empty, hiding something, a slash
   * command, or addressed to another agent (79, r3d).
   */
  | {
      kind: "blocked";
      reason: "too_long" | "hidden" | "empty" | "slash" | "other_agent";
    };

/** The blocked line a control draws for `reason`. */
export const sendBlockedText = (send: MessageSend): string | undefined => {
  if (send.kind !== "blocked") {
    return undefined;
  }
  switch (send.reason) {
    case "slash":
      return "Slash commands can’t be sent from a card";
    case "other_agent":
      return "Messages to another agent can’t be sent from a card";
    default:
      return SENDS_BLOCKED_TEXT;
  }
};

/**
 * A send a card may not make, read after NFKC and invisible-character
 * cleaning so nothing hides in front (79, r3d): a leading "/" (a slash
 * command), or a leading "@name" that is not the surface's own agent.
 */
const refusedLead = (
  words: string,
  agentName: string | undefined,
): "slash" | "other_agent" | undefined => {
  const lead = comparableText(words).trimStart();
  if (lead.startsWith("/") || lead.startsWith("／")) {
    return "slash";
  }
  if (lead.startsWith("@")) {
    const own = agentName ? comparableText(agentName).trim() : "";
    const named = lead.slice(1);
    const addressesOwn =
      own !== "" &&
      named.startsWith(own) &&
      !/[\p{L}\p{N}_.-]/u.test(named.charAt(own.length));
    return addressesOwn ? undefined : "other_agent";
  }
  return undefined;
};

/**
 * What a sending control shows and sends: `text` (else the label) when it
 * can be shown in full. `hidden` is true when the agent's raw label or words
 * held an invisible character (S1): such a control never sends.
 */
export const messageSend = (
  label: string,
  text: string | undefined,
  hidden = false,
  /** The surface's agent: a leading "@<it>" is allowed, no other. */
  agentName?: string,
): MessageSend => {
  if (hidden) {
    return { kind: "blocked", reason: "hidden" };
  }
  const words = text ?? label;
  if (!words.trim()) {
    return { kind: "blocked", reason: "empty" };
  }
  const refused = refusedLead(words, agentName);
  if (refused) {
    return { kind: "blocked", reason: refused };
  }
  if ((words.match(LINE_BREAKS)?.length ?? 0) > SENDS_MAX_LINE_BREAKS) {
    return { kind: "blocked", reason: "too_long" };
  }
  const length = Array.from(words).length;
  if (length > SENDS_MAX) {
    return { kind: "blocked", reason: "too_long" };
  }
  // The label alone stands for the words only when it is the words and every
  // renderer can draw it in full on one line (79 W6 parity #1): no line
  // break of any kind and at most SENDS_LABEL_MAX. Otherwise the words are
  // drawn in full under it.
  if (
    words === label &&
    length <= SENDS_LABEL_MAX &&
    (words.match(LINE_BREAKS)?.length ?? 0) === 0
  ) {
    return { kind: "label", text: words };
  }
  return { kind: "sends", text: words };
};

/** The caption a `sends` control draws, as plain text (newlines kept). */
export const sendsCaption = (text: string): string => `Sends: “${text}”`;

/** The words a send posts, or undefined when it is blocked. */
export const sentText = (send: MessageSend): string | undefined =>
  send.kind === "blocked" ? undefined : send.text;

/**
 * Which surface control a sent message came from. Every message a surface
 * sends carries it (the Buzz `buzz-surface-tap` tag, the dashboard turn's
 * `ui_surface_tap`), so its turn gets the tap-turn trust of r3/r3b: the
 * agent wrote the words, so they are never the person's free-typed word.
 */
export type SurfaceTapRef = {
  surfaceId: string;
  /** The action id, or `chip:<componentId>:<index>` for a suggestion chip. */
  actionId: string;
  revision: number;
};

/** The Buzz kind-9 tag a surface tap's message carries. */
export const buzzSurfaceTapTag = (tap: SurfaceTapRef): string[] => [
  "buzz-surface-tap",
  tap.surfaceId.toLowerCase(),
  tap.actionId,
  String(tap.revision),
];

/** A suggestion chip (`{text, label?}`): its label and what it sends. */
export const chipSend = (
  chip: unknown,
  agentName?: string,
): { label: string; send: MessageSend } | undefined => {
  const record = isObject(chip) ? chip : {};
  const text = plainText(record.text, 2000, true);
  if (!text) {
    return undefined;
  }
  const label = plainText(record.label, 80) ?? text;
  return {
    label,
    send: messageSend(
      label,
      text,
      hasInvisibleText(record.text) || hasInvisibleText(record.label),
      agentName,
    ),
  };
};

/** The tap id of a suggestion chip. */
export const chipActionId = (componentId: string, index: number): string =>
  `chip:${componentId}:${index}`;

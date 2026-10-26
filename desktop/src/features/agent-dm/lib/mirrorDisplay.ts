/**
 * The one display rule for mirrored agent DM history
 * (docs/agent-dm-markers.md §1). Agent runtimes hold the agent's key, so an
 * agent-signed mirror must never be indistinguishable from a message the
 * requester signed. Every surface that shows a mirror (timeline row, inbox
 * and sidebar previews, notifications, search, copy) asks this module how
 * to show it; none decides on its own.
 *
 * Shared test vectors: test-fixtures/mirror-display.json (also loaded by the
 * mobile rule, `mobile/lib/shared/agent_dm/agent_dm_mirror_display.dart`).
 */

import { withoutInvisible } from "@/features/surfaces/core/text";
import { truncateNpub } from "@/shared/lib/pubkey";

import {
  areAgentDmMarkersHonoured,
  KIND_AGENT_DM_QUIET,
  mirrorDisplayAuthorPubkey,
  mirrorSurfaceLabel,
  parseMirror,
  type AgentMirror,
  type DmChannelLike,
} from "./markers";

type Tags = readonly (readonly string[])[] | undefined | null;

/** The event fields the rule reads. */
export type MirrorDisplayEvent = {
  kind?: number;
  pubkey: string;
  tags?: Tags;
};

/** Resolves a pubkey to the display name the surface already uses. */
export type MirrorDisplayNames = (pubkey: string) => string;

export type MirrorDisplay = {
  mirror: AgentMirror;
  /**
   * The pubkey the row is attributed to: the requester when the claimed key
   * is a member of this DM (and the signer is an agent), otherwise the
   * signer. Edits, deletion and moderation stay with the signer regardless.
   */
  authorPubkey: string;
  /** "You" when the attributed requester is the viewer, otherwise a name. */
  authorName: string;
  /** The agent that signed (relayed) the line. */
  relayedByPubkey: string;
  relayedByName: string;
  /** "Kiingo Tasks", "the Companion", "email", ... */
  surfaceLabel: string;
  /**
   * Always-visible line under the row: "via Kiingo Tasks · relayed by
   * Agent" for a requester mirror, "via Teams" for the agent's own one. With
   * the author name it reads "You · via Kiingo Tasks · relayed by Agent" on
   * the owner's own device.
   */
  relayLine: string;
  /**
   * True for every requester mirror: the row must use the distinct relayed
   * style (outlined, relay glyph, never the own-message treatment) and never
   * group with messages its displayed author signed.
   */
  relayed: boolean;
};

/**
 * How to show `event` if it is an honoured mirror in `channel`, or `null`
 * when it is not (any other event, or a mirror outside a DM or from a
 * non-member: those render as a plain message from their signer).
 */
export function mirrorDisplay({
  event,
  channel,
  names,
  signerIsAgent,
  viewerPubkey,
}: {
  event: MirrorDisplayEvent;
  channel: DmChannelLike | null | undefined;
  names: MirrorDisplayNames;
  /** Whether the signer is known to be an agent. */
  signerIsAgent: boolean;
  /** The viewer's own pubkey: an attributed requester who is the viewer reads "You". */
  viewerPubkey?: string | null;
}): MirrorDisplay | null {
  if (event.kind !== KIND_AGENT_DM_QUIET) return null;
  if (!areAgentDmMarkersHonoured(channel, event.pubkey)) return null;
  const mirror = parseMirror(event.tags);
  if (!mirror) return null;
  const signer = event.pubkey.toLowerCase();
  const requester = signerIsAgent
    ? mirrorDisplayAuthorPubkey(mirror, signer, channel)
    : null;
  const authorPubkey = requester ?? signer;
  const relayedByName = profileName(signer, names);
  const surfaceLabel = mirrorSurfaceLabel(mirror.surface);
  const relayed = mirror.role === "requester";
  return {
    mirror,
    authorPubkey,
    authorName: requesterName(requester, viewerPubkey, names) ?? relayedByName,
    relayedByPubkey: signer,
    relayedByName,
    surfaceLabel,
    relayLine: relayed
      ? `via ${surfaceLabel} · relayed by ${relayedByName}`
      : `via ${surfaceLabel}`,
    relayed,
  };
}

function requesterName(
  requester: string | null,
  viewerPubkey: string | null | undefined,
  names: MirrorDisplayNames,
) {
  if (!requester) return null;
  return requester === viewerPubkey?.toLowerCase()
    ? "You"
    : profileName(requester, names);
}

/**
 * A resolved name for `pubkey`. Profile names are self-asserted, and "You"
 * is reserved for the viewer's own attributed lines, so a profile name that
 * reads as "You" ({@link readsAsYou}) shows as its compact npub instead.
 */
function profileName(pubkey: string, names: MirrorDisplayNames) {
  const name = names(pubkey);
  return readsAsYou(name) ? truncateNpub(pubkey) : name;
}

/**
 * Letters that pass for y, o and u in "You": Cyrillic, Greek, Armenian,
 * small capitals and the digit zero. Same table as the mobile rule.
 */
const YOU_LOOKALIKES: Readonly<Record<string, string>> = Object.freeze({
  "\u0423": "y", // У
  "\u0443": "y", // у
  "\u04AE": "y", // Ү
  "\u04AF": "y", // ү
  "\u03A5": "y", // Υ
  "\u028F": "y", // ʏ
  "\u13A9": "y", // Ꭹ
  "\u041E": "o", // О
  "\u043E": "o", // о
  "\u039F": "o", // Ο
  "\u03BF": "o", // ο
  "\u0555": "o", // Օ
  "\u0585": "o", // օ
  "\u1D0F": "o", // ᴏ
  "0": "o",
  "\u03C5": "u", // υ
  "\u054D": "u", // Ս
  "\u057D": "u", // ս
  "\u1D1C": "u", // ᴜ
  "\u028B": "u", // ʋ
});

const EDGE_PUNCTUATION = /^[\p{P}\p{S}\p{Z}\s]+|[\p{P}\p{S}\p{Z}\s]+$/gu;

/**
 * Whether a self-asserted name would read as "You": NFKC, characters that
 * draw nothing removed (Cf and default-ignorables), surrounding
 * punctuation, symbols and spaces trimmed, look-alike letters folded, then
 * compared case-insensitively. "Ｙｏｕ", "Yo\u200Bu", "You." and Cyrillic
 * "Үou" all read as "You".
 */
export function readsAsYou(name: string): boolean {
  const clean = withoutInvisible(name.normalize("NFKC")).replace(
    EDGE_PUNCTUATION,
    "",
  );
  let folded = "";
  for (const char of clean) folded += YOU_LOOKALIKES[char] ?? char;
  return folded.toLowerCase() === "you";
}

/**
 * Plain-text form for previews, notifications, search and copy:
 * "Alex (via Kiingo Tasks, relayed by Agent): text", or "You (via Kiingo
 * Tasks, relayed by Agent): text" on the owner's own device. A requester
 * mirror that could not be attributed reads "Relayed by Agent (via Kiingo
 * Tasks): text"; the agent's own mirror reads "Agent (via Teams): text".
 * "relayed by" is always kept, even for "You (via email, ...)".
 */
export function mirrorPlainText(display: MirrorDisplay, content: string) {
  const text = content.trim();
  if (!display.relayed) {
    return `${display.authorName} (via ${display.surfaceLabel}): ${text}`;
  }
  if (display.authorPubkey === display.relayedByPubkey) {
    return `Relayed by ${display.relayedByName} (via ${display.surfaceLabel}): ${text}`;
  }
  return `${display.authorName} (via ${display.surfaceLabel}, relayed by ${display.relayedByName}): ${text}`;
}

/**
 * Author label for one-line references to a message (reply banner): the
 * relayed form for a requester mirror, otherwise the row's own author.
 */
export function mirrorAwareAuthorLabel(message: {
  author: string;
  agentDmMirror?: MirrorDisplay | null;
}) {
  const display = message.agentDmMirror;
  if (!display?.relayed) return message.author;
  return display.authorPubkey === display.relayedByPubkey
    ? `${display.relayedByName} (relayed via ${display.surfaceLabel})`
    : `${display.authorName} (relayed by ${display.relayedByName})`;
}

/** Text "Copy message" puts on the clipboard for a timeline row. */
export function mirrorAwareCopyText(message: {
  body: string;
  agentDmMirror?: MirrorDisplay | null;
}) {
  return message.agentDmMirror
    ? mirrorPlainText(message.agentDmMirror, message.body)
    : message.body;
}

export type MirrorDetails = {
  /** "Agent (<agent key>)": the key that signed the event, never the requester. */
  signedBy: string;
  signerPubkey: string;
  /**
   * "You · via email" / "Alex · via email" for an attributed requester
   * mirror, "unknown requester · via email" when the author tag was missing
   * or malformed, `null` for the agent's own mirror.
   */
  relayedFor: string | null;
  /** The membership-checked requester key, when the row is attributed. */
  requesterPubkey: string | null;
  /** "via Teams" for the agent's own mirror, otherwise `null`. */
  mirroredVia: string | null;
};

/**
 * Message details for a mirrored row: the signer is shown as the author and
 * the requester only as "Relayed for", matching the mobile details sheet,
 * which lists the signing key as the author key.
 */
export function mirrorDetails(display: MirrorDisplay): MirrorDetails {
  const signerPubkey = display.relayedByPubkey;
  const attributed =
    display.relayed && display.authorPubkey !== display.relayedByPubkey;
  const via = `via ${display.surfaceLabel}`;
  return {
    signedBy: `${display.relayedByName} (${signerPubkey})`,
    signerPubkey,
    relayedFor: display.relayed
      ? `${attributed ? display.authorName : "unknown requester"} · ${via}`
      : null,
    requesterPubkey: attributed ? display.authorPubkey : null,
    mirroredVia: display.relayed ? null : via,
  };
}

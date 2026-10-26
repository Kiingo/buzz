/// The one display rule for mirrored agent DM history
/// (`docs/agent-dm-markers.md` §1), the same rule as desktop's
/// `mirrorDisplay.ts`. Agent runtimes hold the agent's key, so an
/// agent-signed mirror must never be indistinguishable from a message the
/// requester signed. Every surface that shows a mirror (message row, list
/// previews, search, copy) asks this rule how to show it; none decides on
/// its own.
///
/// Shared test vectors: `test-fixtures/mirror-display.json`.
library;

import '../surfaces/surface_text.dart';
import '../utils/string_utils.dart';
import 'agent_dm_markers.dart';

/// How to show one honoured mirror.
class AgentDmMirrorDisplay {
  /// The mirror marker.
  final AgentDmMirror mirror;

  /// The lowercase key the row is attributed to: the requester when the
  /// claimed key is a member of this DM and the signer is an agent,
  /// otherwise the signer. Managing the message stays with the signer.
  final String authorPubkey;

  /// The display name for [authorPubkey], or "You" when the attributed
  /// requester is the viewer.
  final String authorName;

  /// The agent that signed (relayed) the line, lowercase.
  final String relayedByPubkey;

  /// The display name for [relayedByPubkey].
  final String relayedByName;

  /// "Kiingo Tasks", "the Companion", "email", ...
  final String surfaceLabel;

  /// Always-visible line by the row: "via Kiingo Tasks · relayed by
  /// Agent" for a requester mirror, "via Teams" for the agent's own one.
  /// With the author name it reads "You · via Kiingo Tasks · relayed by
  /// Agent" on the owner's own device.
  final String relayLine;

  /// True for every requester mirror: the row uses the distinct relayed
  /// style (outlined, relay glyph, never the own-message bubble) and never
  /// groups with messages its displayed author signed.
  final bool relayed;

  const AgentDmMirrorDisplay({
    required this.mirror,
    required this.authorPubkey,
    required this.authorName,
    required this.relayedByPubkey,
    required this.relayedByName,
    required this.surfaceLabel,
    required this.relayLine,
    required this.relayed,
  });

  /// Plain-text form for previews, notifications, search and copy:
  /// "Alex (via Kiingo Tasks, relayed by Agent): text", or "You (via Kiingo
  /// Tasks, relayed by Agent): text" on the owner's own device. A requester
  /// mirror shown as its signer reads "Relayed by Agent (via Kiingo Tasks):
  /// text"; the agent's own mirror reads "Agent (via Teams): text".
  /// "relayed by" is always kept, even for "You (via email, ...)".
  String plainText(String content) {
    final text = content.trim();
    if (!relayed) return '$authorName (via $surfaceLabel): $text';
    if (authorPubkey == relayedByPubkey) {
      return 'Relayed by $relayedByName (via $surfaceLabel): $text';
    }
    return '$authorName (via $surfaceLabel, relayed by $relayedByName): '
        '$text';
  }
}

/// How to show an event with [kind], [signerPubkey] and [tags] if it is an
/// honoured mirror, or null when it is not (any other event, or a mirror
/// outside a DM or from a non-member: those render as a plain message from
/// their signer).
///
/// [names] resolves a lowercase key to the label the surface already uses;
/// [signerIsAgent] is whether the signer is known to be an agent;
/// [viewerPubkey] is the viewer's own key, and an attributed requester who is
/// the viewer reads "You".
AgentDmMirrorDisplay? agentDmMirrorDisplay({
  required int kind,
  required String signerPubkey,
  required List<List<String>> tags,
  required bool isDm,
  required Iterable<String> memberPubkeys,
  required String Function(String pubkey) names,
  required bool signerIsAgent,
  String? viewerPubkey,
}) {
  if (kind != agentDmQuietKind) return null;
  if (!agentDmMarkersApply(
    isDm: isDm,
    signerPubkey: signerPubkey,
    memberPubkeys: memberPubkeys,
  )) {
    return null;
  }
  final mirror = readAgentDmMirror(tags);
  if (mirror == null) return null;
  final signer = signerPubkey.trim().toLowerCase();
  final requester = signerIsAgent
      ? mirror.authorOverride(
          signerPubkey: signer,
          memberPubkeys: memberPubkeys,
        )
      : null;
  final relayedByName = _profileName(signer, names);
  final surfaceLabel = agentDmMirrorSurfaceLabel(mirror.surface);
  final relayed = mirror.role == AgentDmMirrorRole.requester;
  return AgentDmMirrorDisplay(
    mirror: mirror,
    authorPubkey: requester ?? signer,
    authorName: requester == null
        ? relayedByName
        : requester == viewerPubkey?.trim().toLowerCase()
        ? 'You'
        : _profileName(requester, names),
    relayedByPubkey: signer,
    relayedByName: relayedByName,
    surfaceLabel: surfaceLabel,
    relayLine: relayed
        ? 'via $surfaceLabel · relayed by $relayedByName'
        : 'via $surfaceLabel',
    relayed: relayed,
  );
}

/// A resolved name for [pubkey]. Profile names are self-asserted, and "You"
/// is reserved for the viewer's own attributed lines, so a profile name that
/// reads as "You" ([agentDmNameReadsAsYou]) shows as its compact npub.
String _profileName(String pubkey, String Function(String pubkey) names) {
  final name = names(pubkey);
  return agentDmNameReadsAsYou(name) ? shortPubkey(pubkey) : name;
}

/// Letters that pass for y, o and u in "You": Cyrillic, Greek, Armenian,
/// small capitals and the digit zero. Same table as desktop.
const _youLookalikes = {
  0x0423: 0x79, // У
  0x0443: 0x79, // у
  0x04ae: 0x79, // Ү
  0x04af: 0x79, // ү
  0x03a5: 0x79, // Υ
  0x028f: 0x79, // ʏ
  0x13a9: 0x79, // Ꭹ
  0x041e: 0x6f, // О
  0x043e: 0x6f, // о
  0x039f: 0x6f, // Ο
  0x03bf: 0x6f, // ο
  0x0555: 0x6f, // Օ
  0x0585: 0x6f, // օ
  0x1d0f: 0x6f, // ᴏ
  0x30: 0x6f, // 0
  0x03c5: 0x75, // υ
  0x054d: 0x75, // Ս
  0x057d: 0x75, // ս
  0x1d1c: 0x75, // ᴜ
  0x028b: 0x75, // ʋ
};

final _combiningMarks = RegExp(r'[\p{Mn}\p{Me}]', unicode: true);

/// Circled letters (U+24B6–24E9) and the modifier letters ʸ ᵒ ᵘ, folded as
/// NFKC folds them (this app has no Unicode normaliser).
int _foldNameCode(int code) {
  if (code >= 0x24b6 && code <= 0x24cf) return 0x41 + code - 0x24b6;
  if (code >= 0x24d0 && code <= 0x24e9) return 0x61 + code - 0x24d0;
  return switch (code) {
    0x02b8 => 0x79,
    0x1d52 => 0x6f,
    0x1d58 => 0x75,
    _ => code,
  };
}

final _edgePunctuation = RegExp(
  r'^[\p{P}\p{S}\p{Z}\s]+|[\p{P}\p{S}\p{Z}\s]+$',
  unicode: true,
);

/// Whether a self-asserted name would read as "You": compatibility forms,
/// circled and modifier letters folded (this app's NFKC stand-in),
/// characters that draw nothing removed (Cf and default-ignorables),
/// combining marks (Mn, Me) removed, surrounding punctuation, symbols and
/// spaces trimmed, look-alike letters folded, then compared
/// case-insensitively. "Ｙｏｕ", "Yo\u200Bu", "You.",
/// "Y\u0332o\u0332u\u0332", "ⓎⓄⓊ", "ʸᵒᵘ" and Cyrillic "Үou" all read as "You".
bool agentDmNameReadsAsYou(String name) {
  final compatible = String.fromCharCodes(
    foldCompatibilityForms(name).runes.map(_foldNameCode),
  );
  final clean = withoutInvisible(
    compatible,
  ).replaceAll(_combiningMarks, '').replaceAll(_edgePunctuation, '');
  final folded = String.fromCharCodes(
    clean.runes.map((code) => _youLookalikes[code] ?? code),
  );
  return folded.toLowerCase() == 'you';
}

/// The text "Copy text" puts on the clipboard: a mirrored line in its
/// relayed form, never as bare text that reads as its displayed author's own
/// words; any other message as its content.
String agentDmMirrorCopyText(AgentDmMirrorDisplay? display, String content) =>
    display?.plainText(content) ?? content;

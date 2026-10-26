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

import 'agent_dm_markers.dart';

/// How to show one honoured mirror.
class AgentDmMirrorDisplay {
  /// The mirror marker.
  final AgentDmMirror mirror;

  /// The lowercase key the row is attributed to: the requester when the
  /// claimed key is a member of this DM and the signer is an agent,
  /// otherwise the signer. Managing the message stays with the signer.
  final String authorPubkey;

  /// The display name for [authorPubkey].
  final String authorName;

  /// The agent that signed (relayed) the line, lowercase.
  final String relayedByPubkey;

  /// The display name for [relayedByPubkey].
  final String relayedByName;

  /// "Kiingo Tasks", "email", ...
  final String surfaceLabel;

  /// Always-visible line by the row: "via Kiingo Tasks · relayed by
  /// Juniper" for a requester mirror, "via Teams" for the agent's own one.
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
  /// "Ross (via Kiingo Tasks, relayed by Juniper): text". A requester mirror
  /// shown as its signer reads "Relayed by Juniper (via Kiingo Tasks):
  /// text"; the agent's own mirror reads "Juniper (via Teams): text".
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
/// [signerIsAgent] is whether the signer is known to be an agent.
AgentDmMirrorDisplay? agentDmMirrorDisplay({
  required int kind,
  required String signerPubkey,
  required List<List<String>> tags,
  required bool isDm,
  required Iterable<String> memberPubkeys,
  required String Function(String pubkey) names,
  required bool signerIsAgent,
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
  final relayedByName = names(signer);
  final surfaceLabel = agentDmMirrorSurfaceLabel(mirror.surface);
  final relayed = mirror.role == AgentDmMirrorRole.requester;
  return AgentDmMirrorDisplay(
    mirror: mirror,
    authorPubkey: requester ?? signer,
    authorName: requester == null ? relayedByName : names(requester),
    relayedByPubkey: signer,
    relayedByName: relayedByName,
    surfaceLabel: surfaceLabel,
    relayLine: relayed
        ? 'via $surfaceLabel · relayed by $relayedByName'
        : 'via $surfaceLabel',
    relayed: relayed,
  );
}

/// The text "Copy text" puts on the clipboard: a mirrored line in its
/// relayed form, never as bare text that reads as its displayed author's own
/// words; any other message as its content.
String agentDmMirrorCopyText(AgentDmMirrorDisplay? display, String content) =>
    display?.plainText(content) ?? content;

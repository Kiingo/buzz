/// A control that sends words as the person's own message (`send_message`,
/// suggestion chips) sends ONLY words the person can see on it (79 M1). The
/// control draws its label and, when the words differ, the words themselves
/// in full; past [sendsMax] or [sendsMaxLineBreaks], or holding an
/// invisible character, it is disabled with a line saying why. The words are
/// never read for meaning: a "/" or an "@" sends like any other text (Ross,
/// 2026-10-31: no word parsing; the server refuses by provenance).
/// The same rules as the Kiingo renderers (surface-core sends.ts).
library;

import 'package:flutter/foundation.dart';

import 'surface_data.dart';
import 'surface_text.dart';

/// The longest words a control may send, shown in full (code points).
const sendsMax = 300;

/// The most line breaks words may hold (79 S2): past it a caption could
/// push the tail out of sight ("Sounds good" + 280 newlines), so it is
/// blocked.
const sendsMaxLineBreaks = 3;

/// A line break: CRLF counts once; CR, LF, VT, FF, NEL, LS and PS each
/// count.
final _lineBreaks = RegExp('\r\n|[\n\r\v\f\u0085\u2028\u2029]');

/// Shown on a control that can't send here.
const sendsBlockedText = 'Open in Kiingo to send this';

/// Why a control can't send.
enum SendBlockedReason { tooLong, hidden, empty }

/// What a sending control shows and sends.
@immutable
sealed class MessageSend {
  const MessageSend();
}

/// The label is the words: the control draws it and sends it.
class LabelSend extends MessageSend {
  final String text;
  const LabelSend(this.text);
}

/// The words differ from the label: drawn in full under it
/// ([sendsCaption]).
class CaptionSend extends MessageSend {
  final String text;
  const CaptionSend(this.text);
}

/// Disabled, for [reason].
class BlockedSend extends MessageSend {
  final SendBlockedReason reason;
  const BlockedSend(this.reason);
}

/// The blocked line a control draws, or null when it can send.
String? sendBlockedText(MessageSend send) => switch (send) {
  BlockedSend() => sendsBlockedText,
  _ => null,
};

/// The words a send posts, or null when it is blocked.
String? sentText(MessageSend send) => switch (send) {
  LabelSend(:final text) || CaptionSend(:final text) => text,
  BlockedSend() => null,
};

/// The caption a [CaptionSend] control draws (newlines kept).
String sendsCaption(String text) => 'Sends: “$text”';

/// What a sending control shows and sends: [text] (else [label]) when it
/// can be shown in full. [hidden] is true when the agent's raw label or
/// words held an invisible character (S1): such a control never sends.
MessageSend messageSend(String label, String? text, {bool hidden = false}) {
  if (hidden) return const BlockedSend(SendBlockedReason.hidden);
  final words = text ?? label;
  if (words.trim().isEmpty) return const BlockedSend(SendBlockedReason.empty);
  if (_lineBreaks.allMatches(words).length > sendsMaxLineBreaks) {
    return const BlockedSend(SendBlockedReason.tooLong);
  }
  if (words.runes.length > sendsMax) {
    return const BlockedSend(SendBlockedReason.tooLong);
  }
  return words == label ? LabelSend(words) : CaptionSend(words);
}

/// Which surface control a sent message came from. Every message a surface
/// sends carries it as the `buzz-surface-tap` tag
/// (docs/agent-dm-markers.md §7), so its turn gets tap-turn trust: the
/// agent wrote the words, so they are never the person's free-typed word.
@immutable
class SurfaceTap {
  final String surfaceId;

  /// The action id, or `chip:<componentId>:<index>` for a suggestion chip.
  final String actionId;

  /// The surface's revision when it was tapped.
  final int revision;

  const SurfaceTap({
    required this.surfaceId,
    required this.actionId,
    required this.revision,
  });

  @override
  bool operator ==(Object other) =>
      other is SurfaceTap &&
      other.surfaceId == surfaceId &&
      other.actionId == actionId &&
      other.revision == revision;

  @override
  int get hashCode => Object.hash(surfaceId, actionId, revision);
}

/// The Buzz kind-9 tag a surface tap's message carries.
List<String> buzzSurfaceTapTag(SurfaceTap tap) => [
  'buzz-surface-tap',
  tap.surfaceId.toLowerCase(),
  tap.actionId,
  '${tap.revision}',
];

/// The most suggestion chips drawn.
const surfaceMaxChips = 6;

/// The longest words a chip draws as its own label (code points), all of
/// them narrow ([_isNarrow]). A chip is one line that fades at its edge,
/// even in a compact carousel, so anything longer, wider or on several
/// lines is drawn in full inside the chip under a short label (79 M1).
const chipLabelFits = 20;

/// A suggestion chip (`{text, label?}`): its label and what it sends, or
/// null when it has no words. Words a one-line chip can't show in full
/// send as a [CaptionSend] under a shortened label.
({String label, MessageSend send})? chipSend(Object? chip) {
  final rawText = fieldOf(chip, 'text');
  final rawLabel = fieldOf(chip, 'label');
  final text = plainText(rawText, 2000, lines: true);
  if (text == null) return null;
  final label = plainText(rawLabel, 80) ?? text;
  final send = messageSend(
    label,
    text,
    hidden: hasInvisibleText(rawText) || hasInvisibleText(rawLabel),
  );
  if (send is LabelSend && !chipLabelFitsText(send.text)) {
    return (label: _chipLabel(send.text), send: CaptionSend(send.text));
  }
  return (
    label: chipLabelFitsText(label) ? label : _chipLabel(label),
    send: send,
  );
}

/// Whether a one-line chip shows [text] in full: at most [chipLabelFits]
/// narrow characters and no line break.
bool chipLabelFitsText(String text) =>
    text.runes.length <= chipLabelFits &&
    !_lineBreaks.hasMatch(text) &&
    text.runes.every(_isNarrow);

/// Latin, Greek, Cyrillic and Armenian letters, digits and the common
/// punctuation: no wide (CJK, Hangul), emoji or ligature-sized characters
/// (U+FDFD), and no combining marks (U+0300–U+036F), which stack out of
/// the chip's line.
bool _isNarrow(int code) =>
    (code >= 0x20 && code < 0x0300) ||
    (code > 0x036f && code < 0x0590) ||
    (code >= 0x2010 && code <= 0x2027);

/// [text]'s first line, cut to under [chipLabelFits] code points; "…" when
/// anything was left out.
String _chipLabel(String text) {
  final first = text.split(_lineBreaks).first.trimRight();
  final chars = first.runes.toList();
  if (chars.length < chipLabelFits && first == text) return first;
  return '${String.fromCharCodes(chars.take(chipLabelFits - 1))}…';
}

/// The tap id of a suggestion chip ([index] counts from 0 among the chips
/// drawn).
String chipActionId(String componentId, int index) =>
    'chip:$componentId:$index';

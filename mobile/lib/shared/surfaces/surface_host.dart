import 'package:flutter/foundation.dart';

import 'surface_sends.dart';

/// What the app does for a surface: the only ways a surface reaches outside
/// its card. Surfaces are view only in this app, so there is no write path.
@immutable
class SurfaceHost {
  /// Opens an https or Kiingo link (already checked, outside hosts already
  /// confirmed).
  final void Function(String url) openUrl;

  /// Sends [text] as the person's own ordinary message, tagged with the
  /// control it came from ([tap]), or null when this place can't send.
  final void Function(String text, SurfaceTap tap)? sendMessage;

  /// Opens the surface in a large sheet, or null in that sheet.
  final VoidCallback? openExpanded;

  /// Reads the surface again (its image URLs are re-signed on every read).
  final VoidCallback? refresh;

  /// The agent the card is from, named from the message signer's own
  /// profile (79): the "from" line and the one `@` mention a card may send
  /// use this, never a name in the surface itself.
  final String? agentName;

  /// How long after a revision is first drawn its controls ignore taps
  /// (79): a card that changes under a finger never takes the tap meant
  /// for what was there before.
  final Duration tapSettle;

  const SurfaceHost({
    required this.openUrl,
    this.sendMessage,
    this.openExpanded,
    this.refresh,
    this.agentName,
    this.tapSettle = surfaceTapSettle,
  });
}

/// The default [SurfaceHost.tapSettle].
const surfaceTapSettle = Duration(milliseconds: 500);

/// When one surface revision was first drawn, and the controls that have
/// sent from it: each control sends at most once per revision (79).
class SurfaceRevisionTaps {
  final DateTime drawnAt;
  final Set<String> sent = {};

  SurfaceRevisionTaps(this.drawnAt);
}

final _revisionTaps = <String, SurfaceRevisionTaps>{};

/// The taps record of revision [revision] of surface [surfaceId], made the
/// first time it is asked for (when the revision is first drawn). Keeps
/// the newest 256.
SurfaceRevisionTaps surfaceRevisionTaps(String surfaceId, int revision) {
  final key = '${surfaceId.toLowerCase()}:$revision';
  final found = _revisionTaps[key];
  if (found != null) return found;
  if (_revisionTaps.length >= 256) {
    _revisionTaps.remove(_revisionTaps.keys.first);
  }
  return _revisionTaps[key] = SurfaceRevisionTaps(DateTime.now());
}

/// Whether a send from control [actionId] on revision [revision] counts
/// now, and if so marks it sent: not before [settle] has passed since the
/// revision was first drawn, and never twice.
bool claimSurfaceSend(
  String surfaceId,
  int revision,
  String actionId, {
  Duration settle = surfaceTapSettle,
  DateTime? now,
}) {
  final taps = surfaceRevisionTaps(surfaceId, revision);
  if ((now ?? DateTime.now()).difference(taps.drawnAt) < settle) return false;
  return taps.sent.add(actionId);
}

/// Forgets every revision's taps (tests).
@visibleForTesting
void resetSurfaceRevisionTaps() => _revisionTaps.clear();

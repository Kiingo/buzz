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

/// The most revisions remembered that have sent nothing.
const _unsentRevisionsKept = 256;

/// The taps record of revision [revision] of surface [surfaceId], made the
/// first time it is asked for (when the revision is first on screen).
/// Keeps the newest [_unsentRevisionsKept] that have sent nothing, and
/// every one that has sent (79): forgetting a sent revision would let its
/// controls send again, while forgetting an unsent one only restarts its
/// settle. Each kept sent revision took a person's tap.
SurfaceRevisionTaps surfaceRevisionTaps(String surfaceId, int revision) {
  final key = _revisionKey(surfaceId, revision);
  final found = _revisionTaps[key];
  if (found != null) return found;
  final unsent = [
    for (final entry in _revisionTaps.entries)
      if (entry.value.sent.isEmpty) entry.key,
  ];
  if (unsent.length >= _unsentRevisionsKept) _revisionTaps.remove(unsent.first);
  return _revisionTaps[key] = SurfaceRevisionTaps(DateTime.now());
}

String _revisionKey(String surfaceId, int revision) =>
    '${surfaceId.toLowerCase()}:$revision';

/// Whether revision [revision] of surface [surfaceId] has been on screen
/// (tests).
@visibleForTesting
bool surfaceRevisionShown(String surfaceId, int revision) =>
    _revisionTaps.containsKey(_revisionKey(surfaceId, revision));

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

final _newestRevisions = <String, int>{};

/// Whether a surface's newest revision has been forgotten: from then on a
/// surface the map doesn't hold may be one of those, so it never counts as
/// newest until it is drawn again (79).
var _newestRevisionsEvicted = false;

/// Records that revision [revision] of surface [surfaceId] is drawn, and
/// returns the newest revision drawn of it so far (newest 256 surfaces).
int drawSurfaceRevision(String surfaceId, int revision) {
  final id = surfaceId.toLowerCase();
  final newest = _newestRevisions.remove(id);
  if (_newestRevisions.length >= 256) {
    _newestRevisions.remove(_newestRevisions.keys.first);
    _newestRevisionsEvicted = true;
  }
  return _newestRevisions[id] = newest == null || revision > newest
      ? revision
      : newest;
}

/// Whether revision [revision] of surface [surfaceId] is the newest drawn
/// (79): a control still open on an older one, in a sheet or a menu,
/// never acts.
bool isNewestSurfaceRevision(String surfaceId, int revision) {
  final newest = _newestRevisions[surfaceId.toLowerCase()];
  if (newest == null) return !_newestRevisionsEvicted;
  return revision >= newest;
}

/// Forgets every revision's taps and the newest revisions (tests).
@visibleForTesting
void resetSurfaceRevisionTaps() {
  _revisionTaps.clear();
  _newestRevisions.clear();
  _newestRevisionsEvicted = false;
}

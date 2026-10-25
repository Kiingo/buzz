import 'package:flutter/foundation.dart';

/// What the app does for a surface: the only ways a surface reaches outside
/// its card. Surfaces are view only in this app, so there is no write path.
@immutable
class SurfaceHost {
  /// Opens an https or Kiingo link (already checked, outside hosts already
  /// confirmed).
  final void Function(String url) openUrl;

  /// Sends [text] as the person's own ordinary message, or null when this
  /// place can't send.
  final void Function(String text)? sendMessage;

  /// Opens the surface in a large sheet, or null in that sheet.
  final VoidCallback? openExpanded;

  /// Reads the surface again (its image URLs are re-signed on every read).
  final VoidCallback? refresh;

  const SurfaceHost({
    required this.openUrl,
    this.sendMessage,
    this.openExpanded,
    this.refresh,
  });
}

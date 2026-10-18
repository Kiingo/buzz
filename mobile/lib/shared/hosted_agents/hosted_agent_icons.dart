import 'package:flutter/widgets.dart';

/// Tabler glyphs used only by the hosted-agent pages that the shared
/// [BuzzIcons] catalog does not name. Both use the bundled `BuzzTabler` font.
abstract final class HostedAgentIcons {
  /// Tabler `cloud`.
  static const cloud = IconData(0xea76, fontFamily: 'BuzzTabler');

  /// Tabler `cloud-off`.
  static const cloudOff = IconData(0xed3e, fontFamily: 'BuzzTabler');
}

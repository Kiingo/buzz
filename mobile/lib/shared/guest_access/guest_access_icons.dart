import 'package:flutter/widgets.dart';

/// Tabler glyphs used only by the guest-access sheets that the shared
/// [BuzzIcons] catalog does not name. Both use the bundled `BuzzTabler` font.
abstract final class GuestAccessIcons {
  /// Tabler `flask`.
  static const flask = IconData(0xebd2, fontFamily: 'BuzzTabler');

  /// Tabler `link-off`.
  static const linkOff = IconData(0xf402, fontFamily: 'BuzzTabler');
}

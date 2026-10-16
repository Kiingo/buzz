import 'package:flutter/widgets.dart';

/// Tabler glyphs used only by the guest-access sheets and settings pages that the shared
/// [BuzzIcons] catalog does not name. Both use the bundled `BuzzTabler` font.
abstract final class GuestAccessIcons {
  /// Tabler `flask`.
  static const flask = IconData(0xebd2, fontFamily: 'BuzzTabler');

  /// Tabler `link-off`.
  static const linkOff = IconData(0xf402, fontFamily: 'BuzzTabler');

  /// Tabler `ban`.
  static const ban = IconData(0xea2e, fontFamily: 'BuzzTabler');

  /// Tabler `calendar`.
  static const calendar = IconData(0xea53, fontFamily: 'BuzzTabler');

  /// Tabler `calendar-month`.
  static const calendarMonth = IconData(0xfd2f, fontFamily: 'BuzzTabler');

  /// Tabler `history`.
  static const history = IconData(0xebea, fontFamily: 'BuzzTabler');
}

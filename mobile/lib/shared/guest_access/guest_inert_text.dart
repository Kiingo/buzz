/// Someone else's words, made safe to show: the one character set and clamp
/// every guest-access row uses. Mirrors Kiingo's BUZZ_GUEST_INVISIBLE_RE,
/// BUZZ_GUEST_QUOTE_RE and inertBuzzGuestQuotedText
/// (packages/brain-public-ts-contracts/src/agents/buzz-guest-owner-sources.ts)
/// and desktop `lib/inertText.ts`; change all three together.
library;

/// Characters that render as nothing or as something else: controls, format
/// characters (bidi, zero-width, tags), line and paragraph separators, and
/// the blank fillers and selectors that are neither (combining grapheme
/// joiner U+034F, Hangul fillers U+115F/U+1160/U+3164/U+FFA0, Khmer
/// U+17B4/U+17B5, Mongolian selectors U+180B-180F, braille blank U+2800,
/// variation selectors U+FE00-FE0F and U+E0100-E01EF).
final guestInvisibleChars = RegExp(
  r'[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{034F}\u{115F}\u{1160}\u{17B4}\u{17B5}'
  r'\u{180B}-\u{180F}\u{2800}\u{3164}\u{FE00}-\u{FE0F}\u{FFA0}'
  r'\u{E0100}-\u{E01EF}]',
  unicode: true,
);

/// Quote characters: straight, curly, angle, low-9, CJK corner and fullwidth
/// quotes, plus every initial and final quote mark. Text shown inside quote
/// marks drops them, so it cannot close the quote and go on as plain words
/// (Kiingo 79 SHOULD-BUZZ-KIND-QUOTE-BREAKOUT).
final guestQuoteChars = RegExp(
  r'''["'`\p{Pi}\p{Pf}\u{00AB}\u{00BB}\u{2018}-\u{201F}\u{2039}\u{203A}'''
  r'\u{2E42}\u{300C}-\u{300F}\u{301D}-\u{301F}\u{FE41}-\u{FE44}\u{FF02}'
  r'\u{FF07}\u{FF62}\u{FF63}]',
  unicode: true,
);

/// At most [max] code points, never splitting a surrogate pair.
String clampCodePoints(String text, int max) {
  final runes = text.runes.toList();
  return runes.length > max
      ? '${String.fromCharCodes(runes.take(max - 1))}…'
      : text;
}

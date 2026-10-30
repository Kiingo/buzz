/**
 * Someone else's words, made safe to show: the one character set and clamp
 * every guest-access row uses. Mirrors Kiingo's BUZZ_GUEST_INVISIBLE_RE,
 * BUZZ_GUEST_QUOTE_RE and inertBuzzGuestQuotedText
 * (packages/brain-public-ts-contracts/src/agents/buzz-guest-owner-sources.ts)
 * and mobile guest_inert_text.dart; change all three together.
 */

/**
 * Characters that render as nothing or as something else: controls, format
 * characters (bidi, zero-width, tags), line and paragraph separators, and
 * the blank fillers and selectors that are neither (combining grapheme
 * joiner U+034F, Hangul fillers U+115F/U+1160/U+3164/U+FFA0, Khmer
 * U+17B4/U+17B5, Mongolian selectors U+180B-180F, braille blank U+2800,
 * variation selectors U+FE00-FE0F and U+E0100-E01EF).
 */
export const GUEST_INVISIBLE_RE =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: combining selectors are exactly what this finds.
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{034F}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180B}-\u{180F}\u{2800}\u{3164}\u{FE00}-\u{FE0F}\u{FFA0}\u{E0100}-\u{E01EF}]/gu;

/**
 * Quote characters: straight, curly, angle, low-9, CJK corner and fullwidth
 * quotes, plus every initial and final quote mark. Text shown inside quote
 * marks drops them, so it cannot close the quote and go on as plain words
 * (Kiingo 79 SHOULD-BUZZ-KIND-QUOTE-BREAKOUT).
 */
export const GUEST_QUOTE_RE =
  /["'`\p{Pi}\p{Pf}\u{00AB}\u{00BB}\u{2018}-\u{201F}\u{2039}\u{203A}\u{2E42}\u{300C}-\u{300F}\u{301D}-\u{301F}\u{FE41}-\u{FE44}\u{FF02}\u{FF07}\u{FF62}\u{FF63}]/gu;

/** At most `max` code points, never splitting a surrogate pair. */
export function clampCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : text;
}

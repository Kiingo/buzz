// Generated from the Kiingo surface renderer packages at ecd20c86500467b7da9e4b33426b9a9ba379b523; do not edit here.
import { asNumber } from "./json";

// Agent text is plain text: control characters, format characters
// (Unicode Cf: bidi overrides, zero-width spaces and joiners, word joiners,
// BOMs, interlinear annotations), every default-ignorable code point
// (variation selectors, U+034F, U+17B4/5, Mongolian selectors) and tag
// characters are dropped and lengths capped, as the Swift renderer does
// (UiText; 79 S1/W9, S1 of 2026-10-25).

/**
 * Characters that draw nothing: Default_Ignorable_Code_Point (which holds
 * the variation selectors U+FE00–FE0F and U+E0100–E01EF, U+034F, U+17B4/5,
 * U+180B–180F and the Hangul fillers), Cf and the tags U+E0000–E007F.
 */
const INVISIBLE =
  /[\p{Default_Ignorable_Code_Point}\p{Cf}\u{E0000}-\u{E007F}\u115F\u1160\u3164\uFFA0]/u;
const INVISIBLE_ALL =
  /[\p{Default_Ignorable_Code_Point}\p{Cf}\u{E0000}-\u{E007F}\u115F\u1160\u3164\uFFA0]/gu;

/**
 * The one invisible character an agent's words may hold: a single emoji
 * presentation selector (U+FE0F) right after a pictograph ("❤️"). It only
 * picks the emoji glyph; a run of selectors (hidden data) still counts.
 */
const EMOJI_PRESENTATION =
  /(\p{Extended_Pictographic})\uFE0F(?![\uFE00-\uFE0F\u{E0100}-\u{E01EF}])/gu;

/** Whether `text` holds a character that draws nothing (S1). */
export const hasInvisibleText = (text: unknown): boolean =>
  typeof text === "string" &&
  INVISIBLE.test(text.replace(EMOJI_PRESENTATION, "$1"));

/** `text` without the characters that draw nothing. */
export const withoutInvisible = (text: string): string =>
  text.replace(INVISIBLE_ALL, "");

/**
 * The form two texts are compared in (secret words, a tap's words): NFKC,
 * nothing invisible, lower case. `pass\u200Bword` and `ｐａｓｓｗｏｒｄ` both
 * read "password".
 */
export const comparableText = (text: string): string =>
  withoutInvisible(text.normalize("NFKC")).toLowerCase();

/**
 * Every character that breaks a line somewhere (79 W6 parity #1): CR LF,
 * CR, LF, VT, FF, NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR. Each counts as
 * one line break everywhere a surface reads text.
 */
const LINE_BREAK_CHARS = new Set([
  "\n",
  "\r",
  "\v",
  "\f",
  "\u0085",
  "\u2028",
  "\u2029",
]);

/**
 * Controls and invisible characters removed, at most `max` characters. Every
 * line break ({@link LINE_BREAK_CHARS}, CR LF as one) becomes `\n` when
 * `lines`, else a space.
 */
export const cleanText = (text: string, max: number, lines = false): string => {
  let out = "";
  for (const char of text.replace(/\r\n/gu, "\n")) {
    const code = char.codePointAt(0) ?? 0;
    if (LINE_BREAK_CHARS.has(char)) {
      out += lines ? "\n" : " ";
      continue;
    }
    if (char === "\t") {
      out += " ";
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code < 0xa0) || INVISIBLE.test(char)) {
      continue;
    }
    out += char;
  }
  const chars = Array.from(out);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : out;
};

/** A whole number without ".0"; otherwise the shortest form. */
export const formatPlainNumber = (value: number): string =>
  Number.isInteger(value) && Math.abs(value) < 1e15
    ? String(value)
    : String(Number(value.toPrecision(12)));

/** A string or number as clean, trimmed text; undefined when empty. */
export const plainText = (
  value: unknown,
  max: number,
  lines = false,
): string | undefined => {
  let raw: string | undefined;
  if (typeof value === "string") {
    raw = value;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    raw = formatPlainNumber(value);
  }
  if (raw === undefined) {
    return undefined;
  }
  const text = cleanText(raw, max, lines).trim();
  return text === "" ? undefined : text;
};

/** Ids: printable ASCII without spaces, at most 200 characters. */
export const plainId = (value: unknown): string | undefined => {
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isInteger(value)
        ? String(value)
        : undefined;
  if (!raw || raw.length > 200) {
    return undefined;
  }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code >= 0x7f) {
      return undefined;
    }
  }
  return raw;
};

/** Kiingo's own deep-link schemes (R10). */
export const KIINGO_SCHEMES = new Set(["kiingo", "kiingotasks", "kiingolink"]);

/**
 * The deep-link routes a surface may open (79 W10): ones that only show
 * something. Anything that starts a call, adds, pairs or enrolls is plain
 * text, and every deep link is still confirmed before it opens.
 */
export const KIINGO_DEEP_LINK_ROUTES: Readonly<
  Record<string, readonly string[]>
> = {
  kiingo: ["artifact", "artifacts", "open", "task"],
  kiingotasks: ["task", "agent", "queue"],
};

const isAllowedDeepLink = (scheme: string, text: string): boolean => {
  const route = /^[a-z]+:\/\/([a-z0-9_-]+)(?:[/?#]|$)/iu.exec(text)?.[1];
  const routes = Object.prototype.hasOwnProperty.call(
    KIINGO_DEEP_LINK_ROUTES,
    scheme,
  )
    ? KIINGO_DEEP_LINK_ROUTES[scheme]!
    : [];
  return route !== undefined && routes.includes(route.toLowerCase());
};

const parseUrl = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

/**
 * What `open`, Link and Markdown links may open (R10): https with a host and
 * no credentials, or a Kiingo deep link. Anything else is plain text.
 */
export const openableUrl = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") {
    return undefined;
  }
  const text = raw.trim();
  if (!text || text.length > 2048 || /\s/u.test(text) || INVISIBLE.test(text)) {
    return undefined;
  }
  const url = parseUrl(text);
  if (!url) {
    return undefined;
  }
  const scheme = url.protocol.replace(/:$/u, "").toLowerCase();
  if (scheme === "https") {
    return url.hostname && !url.username && !url.password
      ? url.href
      : undefined;
  }
  return KIINGO_SCHEMES.has(scheme) && isAllowedDeepLink(scheme, text)
    ? text
    : undefined;
};

/**
 * Whether a link is confirmed before it opens (§5, 79 W10): everything
 * except the host app's own origin (`ownOrigins`, e.g. the dashboard's
 * `https://app.kiingo.com`), which the host routes in-app. Other Kiingo
 * hosts (an API GET carries cookies) and every deep link are confirmed.
 */
export const isOutsideUrl = (
  raw: string,
  ownOrigins: readonly string[] = [],
): boolean => {
  const url = parseUrl(raw);
  if (!url || url.protocol !== "https:") {
    return true;
  }
  return !ownOrigins.some((own) => parseUrl(own)?.origin === url.origin);
};

/** The host of a URL for "Open <host>?", else the URL. */
export const urlHost = (raw: string): string => parseUrl(raw)?.hostname ?? raw;

/**
 * The server's secret-word pattern (`@kiingo/ui-catalog` validate.ts
 * SECRET_PATTERN), copied so the client refuses exactly what the server
 * refuses (79 S2): whole words, an optional plural, nothing more.
 */
const SECRET_PATTERN =
  /\b(?:pass ?words?|pass ?codes?|pass ?phrases?|api[ -]?keys?|secret(?: key)?s?|access ?tokens?|auth(?:entication)? ?tokens?|tokens?|2fa|two[- ]factor|mfa|otp|one[- ]time (?:code|password|passcode|pin)|verification codes?|security codes?|pins?|ssn|social security|card numbers?|credit card|debit card|cvv|cvc|security number|routing numbers?|account numbers?|iban|private keys?|seed phrase|recovery (?:code|phrase)s?)\b/iu;

/**
 * Multi-letter secret words without spaces, read after the separators
 * between letters are removed ("Pass word", "p.a.s.s.w.o.r.d"; 79 S2
 * residual). The server's UI_SECRET_COMPACT_WORDS (`@kiingo/ui-catalog`).
 * Short or common words (pin, otp, token, secret, one-time) are left out.
 */
const SECRET_COMPACT_WORDS = [
  "password",
  "passcode",
  "passphrase",
  "apikey",
  "accesstoken",
  "authtoken",
  "twofactor",
  "verificationcode",
  "securitycode",
  "socialsecurity",
  "cardnumber",
  "creditcard",
  "debitcard",
  "securitynumber",
  "routingnumber",
  "accountnumber",
  "privatekey",
  "seedphrase",
  "recoverycode",
  "recoveryphrase",
];

const BETWEEN_LETTERS = /(?<=\p{L})[^\p{L}\p{N}]+(?=\p{L})/gu;

/**
 * Letters that look Latin, folded to the Latin letter they imitate (79 W6
 * NIT), so "раssword" (Cyrillic р, а) or "pαsscοde" (Greek) still reads as
 * a secret word. Capitals are folded before lower-casing (Greek Η reads H,
 * its lower case η reads n), lower case after.
 */
const SKELETON: Readonly<Record<string, string>> = Object.freeze({
  // Cyrillic
  а: "a",
  в: "b",
  с: "c",
  ԁ: "d",
  е: "e",
  ё: "e",
  һ: "h",
  і: "i",
  ї: "i",
  ј: "j",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  ԛ: "q",
  ѕ: "s",
  т: "t",
  у: "y",
  ԝ: "w",
  х: "x",
  // Greek
  α: "a",
  β: "b",
  ε: "e",
  η: "n",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  // Armenian and others seen in look-alike spoofs
  օ: "o",
  ս: "u",
  ց: "g",
  ɑ: "a",
  ı: "i",
  ɩ: "i",
  // Greek capitals (folded before lower-casing: Η is H, η is n)
  Α: "a",
  Β: "b",
  Ε: "e",
  Ζ: "z",
  Η: "h",
  Ι: "i",
  Κ: "k",
  Μ: "m",
  Ν: "n",
  Ο: "o",
  Ρ: "p",
  Τ: "t",
  Υ: "y",
  Χ: "x",
  // Cyrillic capitals
  А: "a",
  В: "b",
  Е: "e",
  Ё: "e",
  К: "k",
  М: "m",
  Н: "h",
  О: "o",
  Р: "p",
  С: "c",
  Т: "t",
  У: "y",
  Х: "x",
  Ѕ: "s",
  І: "i",
  Ї: "i",
  Ј: "j",
  Һ: "h",
  Ԁ: "d",
  Ԛ: "q",
  Ԝ: "w",
  Ү: "y",
  Ӏ: "l",
  // Armenian and Latin capitals
  Օ: "o",
  Ս: "u",
  İ: "i",
  // More lower-case look-alikes
  μ: "u",
  ү: "y",
  ӏ: "l",
  // Digits standing in for letters ("1" is both i and l: see skeletons)
  "0": "o",
});

/**
 * Digits and signs that stand in for letters ("p4$$w0rd", 79 W6 NIT), the
 * same extras as the server's UI_SECRET_FOLD (`@kiingo/ui-catalog`).
 */
const DIGIT_SKELETON: Readonly<Record<string, string>> = Object.freeze({
  "3": "e",
  "4": "a",
  "5": "s",
  $: "s",
});

const foldWith = (
  text: string,
  table: Readonly<Record<string, string>>,
): string => {
  let out = "";
  for (const char of text) {
    out += Object.prototype.hasOwnProperty.call(table, char)
      ? table[char]
      : char;
  }
  return out;
};

/**
 * The forms a label is read in, as the server's uiSecretCheckForms: as
 * written; NFKC, nothing invisible, lower case; and that with look-alikes
 * ({@link SKELETON}, {@link DIGIT_SKELETON}) folded, once with "1" as i
 * and once as l.
 */
const secretForms = (raw: string): string[] => {
  const plain = comparableText(raw);
  // Capitals fold before lower-casing (Greek Η reads H, its η reads n),
  // then what lower-casing produced folds too: as the server.
  const clean = withoutInvisible(raw.normalize("NFKC"));
  const folded = foldWith(
    foldWith(foldWith(clean, SKELETON).toLowerCase(), SKELETON),
    DIGIT_SKELETON,
  );
  // The earlier lower-case-first fold stays a form too, as the server.
  const lowerFirst = foldWith(foldWith(plain, SKELETON), DIGIT_SKELETON);
  return [
    ...new Set([
      raw,
      plain,
      folded.replace(/1/gu, "i"),
      folded.replace(/1/gu, "l"),
      lowerFirst.replace(/1/gu, "i"),
      lowerFirst.replace(/1/gu, "l"),
    ]),
  ];
};

/**
 * Texts that ask for a secret (§10, R11). Such an input is never drawn.
 * Read exactly as the server's matchesSecretInputPattern reads them (79
 * S2): {@link SECRET_PATTERN} on every {@link secretForms} form, plus the
 * multi-letter words with separators removed. Whole words only ("pin" is
 * not in "pinned", "secret" not in "secretary"), so the client never hides
 * an input the server accepted.
 */
export const asksForSecret = (
  texts: ReadonlyArray<string | undefined>,
): boolean =>
  texts.some((raw) => {
    if (!raw) {
      return false;
    }
    const forms = secretForms(raw);
    return (
      forms.some((text) => SECRET_PATTERN.test(text)) ||
      forms.some((text) => {
        const compact = text.replace(BETWEEN_LETTERS, "");
        return SECRET_COMPACT_WORDS.some((word) => compact.includes(word));
      })
    );
  });

/** Initials from a name ("Dana Lee" → "DL"). */
export const initialsOf = (name: string): string => {
  const parts = name
    .replace(/<[^>]*>/gu, " ")
    .split(/[\s@._-]+/u)
    .filter(Boolean);
  const letters = parts
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? "")
    .join("");
  return letters.toUpperCase() || "?";
};

/** A number from a string or number prop. */
export const numberOf = (value: unknown): number | undefined => asNumber(value);

/** A sentence: capitalised, ending in a stop. */
export const sentence = (text: string): string => {
  if (!text) {
    return text;
  }
  const out = text.charAt(0).toUpperCase() + text.slice(1);
  return /[\p{L}\p{N}]$/u.test(out) ? `${out}.` : out;
};

/**
 * Whether a heading or field label only repeats the surface's own title,
 * which the card header already shows: renderers skip that heading and
 * keep that label for screen readers only (Ross 2026-10-27, document_draft).
 */
export const repeatsSurfaceTitle = (
  title: string | undefined,
  text: string | undefined,
): boolean => {
  const own = comparableText(title ?? "").trim();
  return own !== "" && comparableText(text ?? "").trim() === own;
};

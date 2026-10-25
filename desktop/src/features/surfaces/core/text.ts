// Generated from the Kiingo surface renderer packages; do not edit here.
import { asNumber } from "./json";

// Agent text is plain text: control characters, format characters
// (Unicode Cf: bidi overrides, zero-width spaces and joiners, word joiners,
// BOMs, interlinear annotations) and tag characters are dropped and lengths
// capped, as the Swift renderer does (UiText; 79 S1/W9).

/** Characters that draw nothing: Cf, tags U+E0000–E007F, Hangul fillers. */
const INVISIBLE = /[\p{Cf}\u{E0000}-\u{E007F}\u115F\u1160\u3164\uFFA0]/u;
const INVISIBLE_ALL = /[\p{Cf}\u{E0000}-\u{E007F}\u115F\u1160\u3164\uFFA0]/gu;

/** Whether `text` holds a character that draws nothing (S1). */
export const hasInvisibleText = (text: unknown): boolean =>
  typeof text === "string" && INVISIBLE.test(text);

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

/** Controls and invisible characters removed (newlines kept when `lines`), at most `max` characters. */
export const cleanText = (text: string, max: number, lines = false): string => {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\n") {
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

const SECRET_WORDS = [
  "password",
  "passcode",
  "passphrase",
  "api key",
  "apikey",
  "token",
  "2fa",
  "two-factor",
  "one-time",
  "otp",
  "verification code",
  "mfa",
  "pin",
  "ssn",
  "social security",
  "card number",
  "cvv",
  "cvc",
  "routing number",
  "account number",
  "secret",
];

const isLetter = (char: string | undefined): boolean =>
  char !== undefined && /\p{L}/u.test(char);

/**
 * Texts that ask for a secret (§10, R11). Such an input is never drawn; the
 * server refuses them too. Short words match whole words only ("pin" is not
 * in "pinned").
 */
export const asksForSecret = (
  texts: ReadonlyArray<string | undefined>,
): boolean =>
  texts.some((raw) => {
    if (!raw) {
      return false;
    }
    const text = comparableText(raw);
    return SECRET_WORDS.some((word) => {
      let from = 0;
      for (;;) {
        const at = text.indexOf(word, from);
        if (at < 0) {
          return false;
        }
        if (word.length > 3) {
          return true;
        }
        if (!isLetter(text[at - 1]) && !isLetter(text[at + word.length])) {
          return true;
        }
        from = at + 1;
      }
    });
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

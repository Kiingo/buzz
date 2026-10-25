// Generated from the Kiingo surface renderer packages; do not edit here.
import { asNumber } from "./json";

// Agent text is plain text: control characters and bidi overrides are
// dropped and lengths capped, as the Swift renderer does (UiText).

const BIDI = new Set([
  0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067,
  0x2068, 0x2069,
]);

/** Controls and bidi overrides removed (newlines kept when `lines`), at most `max` characters. */
export const cleanText = (text: string, max: number, lines = false): string => {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (BIDI.has(code)) {
      continue;
    }
    if (char === "\n") {
      out += lines ? "\n" : " ";
      continue;
    }
    if (char === "\t") {
      out += " ";
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
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
  if (!text || text.length > 2048 || /\s/u.test(text)) {
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
  return KIINGO_SCHEMES.has(scheme) ? text : undefined;
};

/** Hosts Kiingo counts as its own: links there open without the outside-link confirmation. */
export const KIINGO_OWN_HOSTS = ["kiingo.com"];

/** Not a Kiingo deep link and not on a Kiingo host: confirmed before opening (§5). */
export const isOutsideUrl = (
  raw: string,
  ownHosts: readonly string[] = KIINGO_OWN_HOSTS,
): boolean => {
  const url = parseUrl(raw);
  if (!url) {
    return true;
  }
  const scheme = url.protocol.replace(/:$/u, "").toLowerCase();
  if (scheme !== "https") {
    return !KIINGO_SCHEMES.has(scheme);
  }
  const host = url.hostname.toLowerCase();
  return !ownHosts.some((own) => host === own || host.endsWith(`.${own}`));
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
    const text = raw.toLowerCase();
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

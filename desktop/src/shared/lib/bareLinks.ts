/**
 * Finds link-like text that is not written as a Markdown link: bare domains
 * (`kiingo.com/x`), `www.` hosts, email addresses and clearly formatted phone
 * numbers. Scheme URLs (`https://…`, `buzz://…`) are out of scope: GFM
 * autolinks and the Buzz deep-link plugins already own them.
 *
 * The behavior is shared with mobile (`bare_links.dart`) through
 * `test-fixtures/bare-links.json` and specified in `docs/bare-links.md`.
 * Domains are TLD-checked by linkifyjs; mobile mirrors it with an allowlist.
 */

import { find as findLinks } from "linkifyjs";

export type BareLinkKind = "url" | "www" | "email" | "phone";

export type BareLink = {
  start: number;
  end: number;
  text: string;
  href: string;
  kind: BareLinkKind;
};

/**
 * TLDs that are also common file extensions. A bare `name.<tld>` with one of
 * these is a filename unless it has `www.` or a path, query or fragment.
 * Must equal `fileExtensionTlds` in `test-fixtures/bare-links.json`.
 */
export const FILE_EXTENSION_TLDS: ReadonlySet<string> = new Set([
  "ac",
  "am",
  "app",
  "cc",
  "in",
  "json",
  "md",
  "ml",
  "mov",
  "pl",
  "pm",
  "ps",
  "py",
  "rs",
  "sh",
  "so",
  "tf",
  "ts",
  "zip",
]);

/**
 * Clearly formatted phone numbers only: `+` and a country code, or North
 * American `(555) 123-4567`, `555-123-4567`, `555.123.4567`. Plain digit
 * runs, dates and times never match. Same source as `bare_links.dart`.
 */
const PHONE_PATTERN =
  /(?<![\w+.\-/])(?:\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}|\(\d{3}\) ?\d{3}-\d{4}|\d{3}-\d{3}-\d{4}|\d{3}\.\d{3}\.\d{4})(?![\w\-/]|\.\d)/g;

/** A bare link must start the text or follow whitespace or an opener. */
const ALLOWED_PRECEDING = /[\s([{<"'*_~]/;

const TRAILING_PUNCTUATION = /[.,:;!?'"*_~]/;
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Peels trailing punctuation and unbalanced closing brackets. */
export function peelTrailing(text: string): string {
  let value = text;
  for (;;) {
    const last = value.at(-1);
    if (!last) return value;
    if (TRAILING_PUNCTUATION.test(last)) {
      value = value.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener && count(value, opener) < count(value, last)) {
      value = value.slice(0, -1);
      continue;
    }
    return value;
  }
}

function count(value: string, char: string): number {
  let n = 0;
  for (const c of value) if (c === char) n++;
  return n;
}

function precededOk(text: string, start: number): boolean {
  return start === 0 || ALLOWED_PRECEDING.test(text[start - 1] ?? "");
}

/** Classifies a scheme-less host match, or `null` when it is not a link. */
function classifyHost(value: string): "url" | "www" | null {
  const hostEnd = value.search(/[/?#:]/);
  const host = (hostEnd < 0 ? value : value.slice(0, hostEnd)).toLowerCase();
  if (!host.includes(".")) return null; // localhost and other single labels
  if (/^[\d.]+$/.test(host)) return null; // IPv4 and version-like numbers
  const tld = host.slice(host.lastIndexOf(".") + 1);
  if (!/^[a-z]{2,}$/.test(tld)) return null;
  if (host.startsWith("www.")) return "www";
  const hasPath = /[/?#]/.test(value.slice(host.length));
  if (!hasPath && FILE_EXTENSION_TLDS.has(tld)) return null;
  return "url";
}

/** All bare links in `text`, in order, with no overlaps. */
export function findBareLinks(text: string): BareLink[] {
  const found: BareLink[] = [];

  for (const match of findLinks(text)) {
    if (!match.isLink) continue;
    const start = match.start;
    if (!precededOk(text, start)) continue;
    if (match.type === "email") {
      if (/^mailto:/i.test(match.value)) continue;
      const value = peelTrailing(match.value);
      found.push({
        start,
        end: start + value.length,
        text: value,
        href: `mailto:${value}`,
        kind: "email",
      });
      continue;
    }
    if (match.type !== "url") continue;
    // Any scheme (`https:`, `ftp:`, …) belongs to the existing autolinkers.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(match.value)) continue;
    const value = peelTrailing(match.value);
    const kind = classifyHost(value);
    if (!kind) continue;
    found.push({
      start,
      end: start + value.length,
      text: value,
      href: `https://${value}`,
      kind,
    });
  }

  PHONE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(PHONE_PATTERN)) {
    const value = match[0];
    const digits = value.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) continue;
    const start = match.index ?? 0;
    found.push({
      start,
      end: start + value.length,
      text: value,
      href: `tel:${value.startsWith("+") ? "+" : ""}${digits}`,
      kind: "phone",
    });
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const result: BareLink[] = [];
  for (const link of found) {
    const previous = result.at(-1);
    if (previous && link.start < previous.end) continue;
    result.push(link);
  }
  return result;
}

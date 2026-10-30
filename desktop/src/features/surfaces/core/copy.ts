// Generated from the Kiingo surface renderer packages at 31af16c4bf4bf2ccee353af7c8c836d4be5d621a; do not edit here.
import { withoutInvisible } from "./text";

// Copy to clipboard (Ross, 2026-10-29): a client-only control next to input
// boxes, code blocks (Code, Markdown fences), Quote, KeyValue values and
// Diff. One behaviour on every renderer: an accessible label ("Copy code"),
// the plain text the control shows, and a brief "Copied" confirmation. The
// agent can never trigger it: it is not an action kind and has no spec field.

/** How long "Copied" stays before the control reads "Copy" again. */
export const COPY_CONFIRM_MS = 1500;

/** The words every renderer shows. */
export const COPY_LABEL = "Copy";
export const COPIED_LABEL = "Copied";

/** "Copy code", "Copy Amount": the control's accessible name. */
export const copyLabel = (what: string | undefined): string => {
  const noun = what ? withoutInvisible(what).trim().slice(0, 80) : "";
  return noun ? `${COPY_LABEL} ${noun}` : COPY_LABEL;
};

/** Kiingo's outside-content markers, never part of what a person copies. */
const UNTRUSTED_MARKER = /<\/?untrusted_content\b[^>]{0,200}>/giu;

/**
 * Exactly the text the control shows, as plain text: no outside-content
 * markers, no characters that draw nothing (bidi overrides, zero-width and
 * tag characters, variation selectors), no controls except tabs and line
 * breaks (each break becomes `\n`). Never HTML: the clipboard gets
 * `text/plain` only.
 */
export const copyableText = (text: string): string => {
  let out = "";
  for (const char of withoutInvisible(
    text.replace(UNTRUSTED_MARKER, "").replace(/\r\n?/gu, "\n"),
  )) {
    const code = char.codePointAt(0) ?? 0;
    // LF, NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR each break a line.
    if (code === 0x0a || code === 0x85 || code === 0x2028 || code === 0x2029) {
      out += "\n";
      continue;
    }
    if (char === "\t") {
      out += char;
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      continue;
    }
    out += char;
  }
  return out;
};

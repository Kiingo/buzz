// Generated from the Kiingo surface renderer packages at f674e04ba1130af309f8d467ccc7fc5a2efeba01; do not edit here.
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
 * Characters that draw as blank space (79 PASTEJACK). Hangul fillers
 * (U+115F, U+1160, U+3164, U+FFA0) are already removed as invisible; they
 * are listed so the fold never depends on that. U+2800 (braille blank) is
 * not removed, so it counts here.
 */
const BLANK_RUN =
  /[\t \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u2800\u3164\uFFA0]+/gu;

/**
 * 79 LOW-MO-PASTEJACK-GAPS: a blank run this many columns wide or wider
 * between text on one line is folded. 64 let a tail hide behind 63 spaces
 * (or 8 tabs) in a narrow paste target.
 */
export const COPY_INNER_GAP_COLUMNS = 16;
/** Indentation this wide or wider before text is folded (code under it
 * stays as written). */
export const COPY_LEAD_GAP_COLUMNS = 32;

/** A run's width in columns: a tab is 8, U+3000 and U+3164 are 2. */
const gapColumns = (gap: string): number => {
  let columns = 0;
  for (const char of gap) {
    columns +=
      char === "\t" ? 8 : char === "\u3000" || char === "\u3164" ? 2 : 1;
  }
  return columns;
};

/**
 * Each wide gap before more text on its line as a visible "⟨N spaces⟩ "
 * (N in columns), so a hidden tail shows when pasted. A trailing run hides
 * nothing and stays.
 */
const flagLongGaps = (text: string): string =>
  text
    .split("\n")
    .map((line) =>
      line.replace(BLANK_RUN, (gap: string, at: number) => {
        if (at + gap.length >= line.length) {
          return gap;
        }
        const columns = gapColumns(gap);
        const wide = at === 0 ? COPY_LEAD_GAP_COLUMNS : COPY_INNER_GAP_COLUMNS;
        return columns >= wide ? `⟨${columns} spaces⟩ ` : gap;
      }),
    )
    .join("\n");

/**
 * 79 LOW-MO-VERTICAL-GAP: this many or more consecutive blank (or
 * whitespace-only) lines are folded to one "⟨N blank lines⟩" line, so text
 * pushed far below what a paste target shows is seen.
 */
export const COPY_BLANK_LINES = 8;

const BLANK_LINE =
  /^[\t \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u2800\u3164\uFFA0]*$/u;

/** Each run of COPY_BLANK_LINES+ blank lines as one "⟨N blank lines⟩". */
const flagBlankLines = (text: string): string => {
  const out: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length >= COPY_BLANK_LINES) {
      out.push(`⟨${run.length} blank lines⟩`);
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const line of text.split("\n")) {
    if (BLANK_LINE.test(line)) {
      run.push(line);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out.join("\n");
};

/**
 * Exactly the text the control shows, as plain text: no outside-content
 * markers, no characters that draw nothing (bidi overrides, zero-width and
 * tag characters, variation selectors), no controls except tabs and line
 * breaks (each break becomes `\n`), and a wide blank run before more
 * text (16+ columns, or 32+ as indentation) folded to "⟨N spaces⟩", and 8+
 * blank lines in a row folded to "⟨N blank lines⟩". Never HTML: the
 * clipboard gets `text/plain` only.
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
  return flagBlankLines(flagLongGaps(out));
};

import {
  imetaMediaFromTags,
  stripImetaMediaLines,
} from "@/features/messages/lib/imetaMediaMarkdown";
import type { TimelineMessage } from "@/features/messages/types";

/**
 * What you sent in a DM with an agent, for the composer to go back through, as
 * in a terminal. Up and Down walk it; Ctrl-R searches it.
 *
 * Only an empty box starts Up, so an arrow never replaces words you're writing,
 * and editing a recalled message ends the walk. With several lines the arrows
 * move the caret until it reaches the first or last line. With nothing to
 * recall, Up is left to the composer, which opens your last message to edit.
 */

/**
 * Oldest first: your own messages as sent, repeats side by side counted once.
 * System messages and ones still sending aren't offered, and an attachment's
 * line isn't recalled, since the attachment doesn't come back with it.
 */
export function sentPrompts(
  messages: readonly TimelineMessage[],
  currentPubkey: string,
  systemKind: number,
): string[] {
  const own = messages
    .filter(
      (message) =>
        message.pubkey === currentPubkey &&
        message.kind !== systemKind &&
        !message.pending,
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  const sent: string[] = [];
  for (const message of own) {
    const text = stripImetaMediaLines(
      message.body,
      imetaMediaFromTags(message.tags),
    ).trim();
    if (text && sent.at(-1) !== text) sent.push(text);
  }
  return sent;
}

/**
 * The newest prompt before `before` with `query` in it, ignoring case. An empty
 * query matches every prompt. Null when nothing older has it.
 */
export function searchPrompts(
  history: readonly string[],
  query: string,
  before: number,
): number | null {
  const wanted = query.toLocaleLowerCase();
  for (let index = Math.min(before, history.length) - 1; index >= 0; index--) {
    if (history[index]?.toLocaleLowerCase().includes(wanted)) return index;
  }
  return null;
}

/** The box as a key press found it. */
export type PromptBox = {
  text: string;
  onFirstLine: boolean;
  onLastLine: boolean;
};

export type PromptKey = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

export const PROMPT_SEARCH_MISS = "Nothing older you sent has that in it.";

/**
 * Where the composer is in its history. `setText` puts a prompt in the box and
 * returns the box's text as it now reads, since markdown can read differently
 * from what was sent. True from `handleKey`: the key was this feature's.
 */
export class PromptRecall {
  private index: number | null = null;
  private shown: string | null = null;
  private search: { query: string; index: number } | null = null;

  constructor(
    private readonly setText: (prompt: string) => string,
    private readonly notify: (sentence: string) => void,
  ) {}

  private show(history: readonly string[], index: number) {
    this.index = index;
    this.shown = this.setText(history[index] ?? "");
  }

  private end(text = "") {
    this.index = null;
    this.shown = null;
    this.search = null;
    this.setText(text);
  }

  handleKey(
    event: PromptKey,
    box: PromptBox,
    history: readonly string[],
  ): boolean {
    const walking = this.index !== null && this.shown === box.text;
    if (!walking) this.search = null;
    if (
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "r"
    ) {
      const query = this.search?.query ?? box.text;
      const before = this.search?.index ?? history.length;
      const found = searchPrompts(history, query, before);
      if (found === null) {
        this.notify(PROMPT_SEARCH_MISS);
        return true;
      }
      this.show(history, found);
      this.search = { query, index: found };
      return true;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      return false;
    }
    if (event.key === "Escape" && this.search) {
      this.end(this.search.query);
      return true;
    }
    if (event.key === "ArrowUp") {
      if (!walking) {
        if (box.text !== "" || history.length === 0) return false;
        this.show(history, history.length - 1);
        return true;
      }
      if (!box.onFirstLine) return false;
      this.search = null;
      this.show(history, Math.max((this.index ?? 0) - 1, 0));
      return true;
    }
    if (event.key === "ArrowDown") {
      if (!walking || !box.onLastLine) return false;
      this.search = null;
      const next = (this.index ?? 0) + 1;
      if (next < history.length) this.show(history, next);
      else this.end();
      return true;
    }
    return false;
  }
}

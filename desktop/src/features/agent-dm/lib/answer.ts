import type { AgentQuestion, AgentQuestionItem } from "./markers";

export const ANSWER_OTHER_MAX = 2_000;

/** One question's pick: chosen labels, or typed "Other" text when `other` is set. */
export type QuestionPick = { labels: string[]; other: string | null };
export type AnswerSelection = Readonly<Record<string, QuestionPick>>;

const EMPTY_PICK: QuestionPick = { labels: [], other: null };

export function pickFor(selection: AnswerSelection, qid: string) {
  return selection[qid] ?? EMPTY_PICK;
}

/**
 * Tap an option. Single-select replaces the pick; multi-select toggles the
 * label. Choosing a label leaves "Other" mode (the contract sends labels or
 * the typed text, never both).
 */
export function toggleOption(
  selection: AnswerSelection,
  item: AgentQuestionItem,
  label: string,
): AnswerSelection {
  if (!item.options.some((option) => option.label === label)) return selection;
  const current = pickFor(selection, item.qid);
  let labels: string[];
  if (!item.multi) {
    labels = [label];
  } else if (current.labels.includes(label)) {
    labels = current.labels.filter((candidate) => candidate !== label);
  } else {
    labels = [...current.labels, label];
  }
  return { ...selection, [item.qid]: { labels, other: null } };
}

/** Enter (or leave) "Other" mode for a question that allows it. */
export function toggleOther(
  selection: AnswerSelection,
  item: AgentQuestionItem,
): AnswerSelection {
  if (!item.allowOther) return selection;
  const current = pickFor(selection, item.qid);
  return {
    ...selection,
    [item.qid]:
      current.other === null
        ? { labels: [], other: "" }
        : { labels: [], other: null },
  };
}

export function setOtherText(
  selection: AnswerSelection,
  item: AgentQuestionItem,
  text: string,
): AnswerSelection {
  if (!item.allowOther) return selection;
  return {
    ...selection,
    [item.qid]: { labels: [], other: text.slice(0, ANSWER_OTHER_MAX) },
  };
}

/** The answer text for one question, or null while it is unanswered. */
export function answerTextFor(
  item: AgentQuestionItem,
  pick: QuestionPick,
): string | null {
  if (pick.other !== null) {
    if (!item.allowOther) return null;
    const text = pick.other.trim();
    return text.length > 0 ? text : null;
  }
  // Options order, not tap order, so the content is deterministic.
  const labels = item.options
    .map((option) => option.label)
    .filter((label) => pick.labels.includes(label));
  return labels.length > 0 ? labels.join(", ") : null;
}

/**
 * A single single-select question sends on tap; anything else (multi-select
 * or several questions) selects first and sends with an explicit Send.
 */
export function sendsOnTap(question: AgentQuestion) {
  return question.items.length === 1 && !question.items[0]?.multi;
}

export type AnswerMessage = { content: string; tags: string[][] };

/**
 * Content and tags for the user's answer: one question sends its answer as
 * the whole content; several send `<n>. <answer>` lines in question order.
 * Returns null until every question is answered.
 */
export function buildAnswerMessage(
  question: AgentQuestion,
  selection: AnswerSelection,
): AnswerMessage | null {
  const lines: string[] = [];
  const tags: string[][] = [["buzz-answer", question.askId]];
  for (const item of question.items) {
    const pick = pickFor(selection, item.qid);
    const text = answerTextFor(item, pick);
    if (text === null) return null;
    lines.push(text);
    if (pick.other !== null) {
      tags.push(["buzz-answer-other", item.qid, text]);
    } else {
      tags.push([
        "buzz-answer-item",
        item.qid,
        ...item.options
          .map((option) => option.label)
          .filter((label) => pick.labels.includes(label)),
      ]);
    }
  }
  const content =
    lines.length === 1
      ? (lines[0] ?? "")
      : lines.map((line, index) => `${index + 1}. ${line}`).join("\n");
  return { content, tags };
}

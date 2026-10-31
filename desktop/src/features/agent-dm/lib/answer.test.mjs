import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAnswerMessage,
  sendsOnTap,
  setOtherText,
  toggleOption,
  toggleOther,
} from "./answer.ts";
import { parseQuestion } from "./markers.ts";

const single = parseQuestion([
  ["buzz-question", "ask-1"],
  ["buzz-question-item", "q1", "Which plan?", "", "0", "1"],
  ["buzz-question-option", "q1", "Basic", ""],
  ["buzz-question-option", "q1", "Pro", ""],
]);

const several = parseQuestion([
  ["buzz-question", "ask-2"],
  ["buzz-question-item", "q1", "Which days?", "", "1", "0"],
  ["buzz-question-option", "q1", "Mon", ""],
  ["buzz-question-option", "q1", "Tue", ""],
  ["buzz-question-option", "q1", "Wed", ""],
  ["buzz-question-item", "q2", "Anything else?", "", "0", "1"],
  ["buzz-question-option", "q2", "No", ""],
]);

test("one single-select question sends on tap; anything else selects then sends", () => {
  assert.equal(sendsOnTap(single), true);
  assert.equal(sendsOnTap(several), false);
  const multiOnly = parseQuestion([
    ["buzz-question", "ask-3"],
    ["buzz-question-item", "q1", "Pick", "", "1", "0"],
    ["buzz-question-option", "q1", "A", ""],
  ]);
  assert.equal(sendsOnTap(multiOnly), false);
});

test("one question: the chosen label is the whole content", () => {
  const item = single.items[0];
  let selection = toggleOption({}, item, "Basic");
  selection = toggleOption(selection, item, "Pro");
  assert.deepEqual(buildAnswerMessage(single, selection), {
    content: "Pro",
    tags: [
      ["buzz-answer", "ask-1"],
      ["buzz-answer-item", "q1", "Pro"],
    ],
  });
});

test("one question: the typed Other text is the content", () => {
  const item = single.items[0];
  let selection = toggleOther({}, item);
  assert.equal(buildAnswerMessage(single, selection), null, "blank other");
  selection = setOtherText(selection, item, "  Enterprise, please ");
  assert.deepEqual(buildAnswerMessage(single, selection), {
    content: "Enterprise, please",
    tags: [
      ["buzz-answer", "ask-1"],
      ["buzz-answer-other", "q1", "Enterprise, please"],
    ],
  });
  // Choosing a label leaves Other mode.
  selection = toggleOption(selection, item, "Basic");
  assert.equal(buildAnswerMessage(single, selection).content, "Basic");
});

test("several questions: numbered lines in order, multi-select labels joined", () => {
  const [days, extra] = several.items;
  let selection = toggleOption({}, days, "Wed");
  selection = toggleOption(selection, days, "Mon");
  assert.equal(buildAnswerMessage(several, selection), null, "q2 unanswered");
  selection = toggleOther(selection, extra);
  selection = setOtherText(selection, extra, "Bring snacks");
  assert.deepEqual(buildAnswerMessage(several, selection), {
    content: "1. Mon, Wed\n2. Bring snacks",
    tags: [
      ["buzz-answer", "ask-2"],
      ["buzz-answer-item", "q1", "Mon", "Wed"],
      ["buzz-answer-other", "q2", "Bring snacks"],
    ],
  });
  // Toggling a multi-select label off removes it.
  selection = toggleOption(selection, days, "Mon");
  assert.equal(
    buildAnswerMessage(several, selection).content,
    "1. Wed\n2. Bring snacks",
  );
});

test("Other is refused where the question does not allow it", () => {
  const days = several.items[0];
  assert.deepEqual(toggleOther({}, days), {});
  assert.deepEqual(setOtherText({}, days, "x"), {});
  assert.deepEqual(toggleOption({}, days, "Fri"), {}, "unknown labels ignored");
});

test("the card's revision rides on the answer, so an old card never answers a revised ask", () => {
  const card = (revisionTag) =>
    parseQuestion([
      ["buzz-question", "ask-9"],
      ...(revisionTag ? [revisionTag] : []),
      ["buzz-question-item", "q1", "Which plan?", "", "0", "0"],
      ["buzz-question-option", "q1", "Pro", ""],
    ]);
  const revised = card(["buzz-question-revision", "ask-9", "4"]);
  assert.equal(revised.revision, "4");
  const pick = toggleOption({}, revised.items[0], "Pro");
  assert.deepEqual(buildAnswerMessage(revised, pick).tags[0], [
    "buzz-answer",
    "ask-9",
    "4",
  ]);
  // No revision, one for another ask, or a malformed one: none is echoed.
  for (const tag of [
    null,
    ["buzz-question-revision", "ask-1", "4"],
    ["buzz-question-revision", "ask-9", "0"],
    ["buzz-question-revision", "ask-9", "x"],
  ]) {
    const plain = card(tag);
    assert.equal(plain.revision, undefined);
    assert.deepEqual(
      buildAnswerMessage(plain, toggleOption({}, plain.items[0], "Pro"))
        .tags[0],
      ["buzz-answer", "ask-9"],
    );
  }
});

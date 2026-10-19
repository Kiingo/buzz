import assert from "node:assert/strict";
import test from "node:test";

import {
  actionRefTag,
  areAgentDmMarkersHonoured,
  mirrorBadgeLabel,
  mirrorDisplayAuthorPubkey,
  parseActions,
  parseAnswerAskId,
  parseMirror,
  parseQuestion,
  parseQuestionState,
  parseSessionDivider,
  parseSessionsListing,
  sessionDividerLabel,
} from "./markers.ts";

const AGENT = "a".repeat(64);
const PERSON = "b".repeat(64);
const STRANGER = "c".repeat(64);
const DM = {
  channelType: "dm",
  participantPubkeys: [AGENT, PERSON],
  memberPubkeys: [],
};

function mirrorTags(overrides = {}) {
  return [
    ["h", "dm-1"],
    [
      "buzz-mirror",
      overrides.surface ?? "email",
      overrides.sourceId ?? "msg-1",
      overrides.at ?? "1760000000",
    ],
    [
      "buzz-mirror-author",
      overrides.role ?? "requester",
      overrides.pubkey ?? PERSON,
      "Ross",
    ],
    ...(overrides.subject === undefined
      ? []
      : [["subject", overrides.subject]]),
  ];
}

test("markers are honoured only in a DM and only for a member signer", () => {
  assert.equal(areAgentDmMarkersHonoured(DM, AGENT), true);
  assert.equal(areAgentDmMarkersHonoured(DM, STRANGER), false);
  assert.equal(
    areAgentDmMarkersHonoured({ ...DM, channelType: "stream" }, AGENT),
    false,
  );
  assert.equal(areAgentDmMarkersHonoured(null, AGENT), false);
  assert.equal(areAgentDmMarkersHonoured(DM, "not-hex"), false);
  // An unknown roster leans on the relay's DM membership enforcement.
  assert.equal(
    areAgentDmMarkersHonoured({ channelType: "dm" }, STRANGER),
    true,
  );
});

test("mirror parsing validates surface, source id, time, role and pubkey", () => {
  assert.deepEqual(parseMirror(mirrorTags({ subject: " Q3 plan " })), {
    surface: "email",
    sourceId: "msg-1",
    originalAt: 1_760_000_000,
    role: "requester",
    authorPubkey: PERSON,
    subject: "Q3 plan",
  });
  assert.equal(parseMirror(mirrorTags({ surface: "Email" })), null);
  assert.equal(parseMirror(mirrorTags({ surface: "a".repeat(33) })), null);
  assert.equal(parseMirror(mirrorTags({ sourceId: "x".repeat(257) })), null);
  assert.equal(parseMirror(mirrorTags({ sourceId: "" })), null);
  assert.equal(parseMirror(mirrorTags({ at: "-5" })), null);
  assert.equal(parseMirror(mirrorTags({ role: "owner" })), null);
  assert.equal(parseMirror(mirrorTags({ pubkey: "abc" })), null);
  assert.equal(parseMirror(mirrorTags({ subject: "s".repeat(201) })), null);
  assert.equal(parseMirror(mirrorTags({ pubkey: "" })).authorPubkey, null);
  assert.equal(parseMirror([["buzz-mirror", "email", "m", "1"]]), null);
});

test("mirror badge labels and the requester override rule", () => {
  assert.equal(mirrorBadgeLabel("email"), "via email");
  assert.equal(mirrorBadgeLabel("teams"), "via Teams");
  assert.equal(mirrorBadgeLabel("sms"), "via SMS");
  assert.equal(mirrorBadgeLabel("web"), "via web");
  assert.equal(mirrorBadgeLabel("slack"), "via slack");

  const requester = parseMirror(mirrorTags());
  assert.equal(mirrorDisplayAuthorPubkey(requester, AGENT, DM), PERSON);
  // Non-member, signer-equal, missing pubkey and agent role all fall back.
  assert.equal(
    mirrorDisplayAuthorPubkey(
      parseMirror(mirrorTags({ pubkey: STRANGER })),
      AGENT,
      DM,
    ),
    null,
  );
  assert.equal(
    mirrorDisplayAuthorPubkey(
      parseMirror(mirrorTags({ pubkey: AGENT })),
      AGENT,
      DM,
    ),
    null,
  );
  assert.equal(
    mirrorDisplayAuthorPubkey(
      parseMirror(mirrorTags({ pubkey: "" })),
      AGENT,
      DM,
    ),
    null,
  );
  assert.equal(
    mirrorDisplayAuthorPubkey(
      parseMirror(mirrorTags({ role: "agent" })),
      AGENT,
      DM,
    ),
    null,
  );
  // The override needs a known roster; it never trusts an unknown one.
  assert.equal(
    mirrorDisplayAuthorPubkey(requester, AGENT, { channelType: "dm" }),
    null,
  );
});

test("session dividers and listings", () => {
  assert.deepEqual(parseSessionDivider([["buzz-session", "new", ""]]), {
    action: "new",
    sessionId: null,
  });
  assert.deepEqual(parseSessionDivider([["buzz-session", "load", "s-1"]]), {
    action: "load",
    sessionId: "s-1",
  });
  assert.equal(parseSessionDivider([["buzz-session", "reset", ""]]), null);
  assert.equal(parseSessionDivider([["buzz-session", "load", "a b"]]), null);
  assert.equal(sessionDividerLabel("new"), "New session");
  assert.equal(sessionDividerLabel("switch"), "New session");
  assert.equal(sessionDividerLabel("load"), "Earlier session loaded");

  const item = (id, loadable = "1") => [
    "buzz-session-item",
    id,
    "previous",
    "1760000000",
    "1760000100",
    "Planning",
    loadable,
    "4",
  ];
  const listing = parseSessionsListing([
    ["buzz-sessions", PERSON.toUpperCase()],
    ["buzz-session-item", "s-0", "current", "1", "2", "Now", "0", "1"],
    item("s-1"),
    ["buzz-session-item", "bad", "previous", "x", "2", "T", "1", "1"],
    item("s-1"),
    item("s-2", "2"),
  ]);
  assert.equal(listing.requestId, PERSON);
  assert.deepEqual(
    listing.items.map((entry) => [
      entry.sessionId,
      entry.current,
      entry.loadable,
    ]),
    [
      ["s-0", true, false],
      ["s-1", false, true],
    ],
  );
  const many = parseSessionsListing([
    ["buzz-sessions", ""],
    ...Array.from({ length: 25 }, (_, index) => item(`s-${index}`)),
  ]);
  assert.equal(many.items.length, 20);
  assert.equal(many.requestId, null);
  assert.equal(parseSessionsListing([["buzz-sessions", "nope"]]), null);
});

test("question cards are strict about shape and bounds", () => {
  const base = [
    ["buzz-question", "ask-1"],
    ["buzz-question-item", "q1", "Which plan?", "Plan", "0", "1"],
    ["buzz-question-option", "q1", "Basic", "Cheapest"],
    ["buzz-question-option", "q1", "Pro", ""],
  ];
  assert.deepEqual(parseQuestion(base), {
    askId: "ask-1",
    items: [
      {
        qid: "q1",
        question: "Which plan?",
        header: "Plan",
        multi: false,
        allowOther: true,
        options: [
          { label: "Basic", description: "Cheapest" },
          { label: "Pro", description: null },
        ],
      },
    ],
  });
  assert.equal(parseQuestion(base.slice(1)), null, "needs an ask id");
  assert.equal(parseQuestion(base.slice(0, 1)), null, "needs a question");
  const tooMany = [
    ["buzz-question", "ask-1"],
    ...Array.from({ length: 5 }, (_, index) => [
      "buzz-question-item",
      `q${index}`,
      "Q?",
      "",
      "0",
      "0",
    ]),
  ];
  assert.equal(parseQuestion(tooMany), null);
  const nineOptions = [
    ...base.slice(0, 2),
    ...Array.from({ length: 9 }, (_, index) => [
      "buzz-question-option",
      "q1",
      `Option ${index}`,
      "",
    ]),
  ];
  assert.equal(parseQuestion(nineOptions), null);
  assert.equal(
    parseQuestion([...base, ["buzz-question-option", "q9", "Orphan", ""]]),
    null,
  );
  assert.equal(
    parseQuestion([
      base[0],
      ["buzz-question-item", "q1", "Which?", "", "2", "0"],
    ]),
    null,
  );
});

test("question state, answers and actions", () => {
  assert.deepEqual(
    parseQuestionState([["buzz-question-state", "ask-1", "answered"]]),
    {
      askId: "ask-1",
      state: "answered",
    },
  );
  // Anything but answered closes the card.
  assert.equal(
    parseQuestionState([["buzz-question-state", "ask-1", "expired"]]).state,
    "closed",
  );
  assert.equal(parseQuestionState([["buzz-question-state", ""]]), null);
  assert.equal(parseAnswerAskId([["buzz-answer", "ask-1"]]), "ask-1");
  assert.equal(parseAnswerAskId([["buzz-answer", ""]]), null);

  const actions = parseActions([
    ["buzz-action", "retry", "Retry", "retry", "primary", "ref-1"],
    [
      "buzz-action",
      "continue_on_claude",
      "Continue on Claude",
      "continue",
      "secondary",
      "ref-2",
    ],
    ["buzz-action", "bad", "Bad", "x", "tertiary", "ref-3"],
    ["buzz-action", "old", "Old shape", "x", "primary"],
    ["buzz-action", "retry", "Dup", "x", "primary", "ref-4"],
    ["buzz-action", "long", "Long", "x", "primary", "r".repeat(513)],
    ["buzz-action", "a3", "Three", "x", "secondary", "ref-5"],
    ["buzz-action", "a4", "Four", "x", "secondary", "ref-6"],
  ]);
  assert.deepEqual(
    actions.map((action) => [action.actionId, action.primary, action.ref]),
    [
      ["retry", true, "ref-1"],
      ["continue_on_claude", false, "ref-2"],
      ["a3", false, "ref-5"],
    ],
  );
  assert.deepEqual(actionRefTag(actions[0]), ["buzz-action-ref", "ref-1"]);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  actionRefTag,
  actionTapTags,
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
  parseSurface,
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
  // An empty or unknown roster honours nothing, the same rule as mobile.
  assert.equal(areAgentDmMarkersHonoured({ channelType: "dm" }, AGENT), false);
  assert.equal(
    areAgentDmMarkersHonoured(
      { channelType: "dm", participantPubkeys: [], memberPubkeys: [] },
      AGENT,
    ),
    false,
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
  assert.equal(parseMirror(mirrorTags({ pubkey: "" })).authorPubkey, null);
  assert.equal(
    parseMirror(mirrorTags({ pubkey: PERSON.toUpperCase() })).authorPubkey,
    PERSON,
  );
});

test("a malformed author tag fails closed to an unattributed requester mirror", () => {
  const unattributed = (tags) => {
    const mirror = parseMirror(tags);
    return mirror && { role: mirror.role, authorPubkey: mirror.authorPubkey };
  };
  const expected = { role: "requester", authorPubkey: null };
  const [, mirror, author] = mirrorTags();
  assert.deepEqual(unattributed(mirrorTags({ role: "owner" })), expected);
  assert.deepEqual(unattributed(mirrorTags({ pubkey: "abc" })), expected);
  assert.deepEqual(
    unattributed(mirrorTags({ role: "agent", pubkey: "abc" })),
    expected,
  );
  assert.deepEqual(unattributed([mirror]), expected);
  assert.deepEqual(unattributed([mirror, author, author]), expected);
  assert.deepEqual(
    unattributed([mirror, ["buzz-mirror-author", "agent", "", ""], author]),
    expected,
  );
  assert.deepEqual(unattributed([mirror, [...author, "extra"]]), expected);
  assert.deepEqual(
    unattributed([mirror, ["buzz-mirror-author", "agent"]]),
    expected,
  );
  // The agent's own mirror stays the agent's.
  assert.deepEqual(
    unattributed([mirror, ["buzz-mirror-author", "agent", "", ""]]),
    { role: "agent", authorPubkey: null },
  );
  // The author tag alone is not a mirror.
  assert.equal(parseMirror([author]), null);
});

test("a bad subject is dropped and the mirror kept", () => {
  const subjectOf = (tags) => parseMirror(tags)?.subject;
  assert.equal(subjectOf(mirrorTags({ subject: "s".repeat(201) })), null);
  assert.equal(subjectOf(mirrorTags({ subject: "   " })), null);
  assert.equal(
    subjectOf([...mirrorTags({ subject: "one" }), ["subject", "two"]]),
    null,
  );
  assert.equal(
    subjectOf([...mirrorTags(), ["subject", "Q3 plan", "extra"]]),
    null,
  );
});

test("the first mirror tag decides whether an event is a mirror", () => {
  const [, mirror, author] = mirrorTags();
  assert.equal(
    parseMirror([mirror, ["buzz-mirror", "Bad", "", ""], author])?.surface,
    "email",
  );
  assert.equal(
    parseMirror([["buzz-mirror", "email", "m", "soon"], mirror, author]),
    null,
  );
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
  // A tap names the message it was on, as a mention (never a thread reply).
  const messageId = "AB".repeat(32);
  assert.deepEqual(actionTapTags(actions[0], messageId), [
    ["buzz-action-ref", "ref-1"],
    ["e", "ab".repeat(32), "", "mention"],
  ]);
  assert.deepEqual(actionTapTags(actions[0], "local-optimistic-id"), [
    ["buzz-action-ref", "ref-1"],
  ]);
});

test("parseSurface reads exactly one well-formed surface card marker", () => {
  const id = "0192A6B0-0000-7000-8000-0000000000AC";
  assert.deepEqual(
    parseSurface([
      ["h", "dm-1"],
      ["buzz-surface", id, "3"],
    ]),
    {
      surfaceId: id.toLowerCase(),
      revision: 3,
    },
  );
  for (const tags of [
    [],
    [["buzz-surface", "not-a-uuid", "3"]],
    [["buzz-surface", id, "0"]],
    [["buzz-surface", id, "-1"]],
    [["buzz-surface", id, "1.5"]],
    [["buzz-surface", id, "3", "extra"]],
    [["buzz-surface", id]],
    [
      ["buzz-surface", id, "3"],
      ["buzz-surface", id, "4"],
    ],
  ]) {
    assert.equal(parseSurface(tags), null, JSON.stringify(tags));
  }
});

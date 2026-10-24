import assert from "node:assert/strict";
import test from "node:test";

import {
  narrowSlashChoice,
  detectGroupSlashQuery,
  groupSkillTag,
  MAX_SLASH_AGENT_CHOICES,
  mentionsSomeone,
  parseGroupSkillInvocation,
  resolveSlashTarget,
  slashTokenStart,
} from "./groupSlash.ts";
import { MAX_SKILL_ARGS } from "./slashQuery.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

const REVIEW = {
  kind: "skill",
  name: "review",
  skillId: "skill-review",
  description: null,
  argumentHint: null,
  source: "installed",
  displayName: null,
};

test("slashTokenStart: at the start or after a leading mention", () => {
  assert.equal(slashTokenStart("/rev"), 0);
  assert.equal(slashTokenStart("@Scout /rev"), 7);
  assert.equal(slashTokenStart("@Scout Bot /rev"), 11);
  assert.equal(slashTokenStart("hi /rev"), null);
  assert.equal(slashTokenStart("@Scout\nnext /rev"), null);
  assert.equal(slashTokenStart("@ /rev"), null);
});

test("detectGroupSlashQuery: reads the token after the mention", () => {
  assert.deepEqual(detectGroupSlashQuery("@Scout /re", 10), {
    query: "re",
    tokenStart: 7,
    tokenEnd: 10,
    prefix: "@Scout ",
  });
  assert.deepEqual(detectGroupSlashQuery("/", 1), {
    query: "",
    tokenStart: 0,
    tokenEnd: 1,
    prefix: "",
  });
  // The caret has left the token: arguments are being typed.
  assert.equal(detectGroupSlashQuery("@Scout /review x", 16), null);
});

test("detectGroupSlashQuery: a / opens at any word start", () => {
  assert.deepEqual(detectGroupSlashQuery("ask @Scout to /re", 17), {
    query: "re",
    tokenStart: 14,
    tokenEnd: 17,
    prefix: "ask @Scout to ",
  });
  assert.deepEqual(detectGroupSlashQuery("hi /", 4), {
    query: "",
    tokenStart: 3,
    tokenEnd: 4,
    prefix: "hi ",
  });
  assert.equal(detectGroupSlashQuery("see https://x.io/re", 19), null);
  assert.equal(detectGroupSlashQuery("me@x.io/re", 10), null);
});

test("mentionsSomeone: an @ that opens a word", () => {
  assert.equal(mentionsSomeone("@Scout "), true);
  assert.equal(mentionsSomeone("ask @Scout to "), true);
  assert.equal(mentionsSomeone("(@Scout) "), true);
  assert.equal(mentionsSomeone("hi "), false);
  assert.equal(mentionsSomeone("me@example.com "), false);
  assert.equal(mentionsSomeone(""), false);
});

test("resolveSlashTarget: mention, then addressed agents, then the channel's", () => {
  assert.deepEqual(
    resolveSlashTarget({
      hasPrefix: true,
      prefixAgents: [B],
      addressedAgents: [A],
      channelAgents: [A, C],
    }),
    { kind: "agent", pubkey: B },
  );
  // A mention of someone who is not an agent: no menu.
  assert.equal(
    resolveSlashTarget({
      hasPrefix: true,
      prefixAgents: [],
      addressedAgents: [A],
      channelAgents: [A],
    }),
    null,
  );
  assert.deepEqual(
    resolveSlashTarget({
      hasPrefix: false,
      prefixAgents: [],
      addressedAgents: [A.toUpperCase()],
      channelAgents: [B, C],
    }),
    { kind: "agent", pubkey: A },
  );
  assert.deepEqual(
    resolveSlashTarget({
      hasPrefix: false,
      prefixAgents: [],
      addressedAgents: [],
      channelAgents: [C],
    }),
    { kind: "agent", pubkey: C },
  );
  assert.deepEqual(
    resolveSlashTarget({
      hasPrefix: false,
      prefixAgents: [],
      addressedAgents: [],
      channelAgents: [B, C],
    }),
    { kind: "choose", pubkeys: [B, C] },
  );
  assert.equal(
    resolveSlashTarget({
      hasPrefix: false,
      prefixAgents: [],
      addressedAgents: [],
      channelAgents: [],
    }),
    null,
  );
  const many = Array.from({ length: 30 }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );
  const chosen = resolveSlashTarget({
    hasPrefix: false,
    prefixAgents: [],
    addressedAgents: [],
    channelAgents: many,
  });
  assert.equal(chosen?.kind, "choose");
  assert.equal(chosen.pubkeys.length, MAX_SLASH_AGENT_CHOICES);
});

test("parseGroupSkillInvocation and groupSkillTag keep the typed args", () => {
  const invocation = parseGroupSkillInvocation("@Scout /review the PR", [
    REVIEW,
  ]);
  assert.deepEqual(invocation, {
    command: REVIEW,
    args: "the PR",
    text: "@Scout /review the PR",
    leading: true,
  });
  assert.deepEqual(groupSkillTag(invocation), [
    "buzz-skill",
    "skill-review",
    "the PR",
  ]);
  assert.equal(parseGroupSkillInvocation("please /review", [REVIEW]), null);
  // Picked from the menu, a mid-message skill counts, with the whole
  // message (mention included) as its input.
  const picked = parseGroupSkillInvocation(
    "ask @Scout to /review the PR",
    [REVIEW],
    new Set(["review"]),
  );
  assert.equal(picked.command, REVIEW);
  assert.equal(picked.args, "ask @Scout to the PR");
  assert.equal(picked.leading, false);
  assert.equal(
    groupSkillTag({ command: REVIEW, args: "x".repeat(MAX_SKILL_ARGS + 1) }),
    null,
  );
});

test("narrowSlashChoice: drops agents with nothing to offer", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const C = "c".repeat(64);
  const choose = { kind: "choose", pubkeys: [A, B, C] };
  const states = (map) => (pubkey) => map[pubkey] ?? "unknown";
  assert.deepEqual(narrowSlashChoice(choose, states({})), choose);
  assert.deepEqual(narrowSlashChoice(choose, states({ [B]: "empty" })), {
    kind: "choose",
    pubkeys: [A, C],
  });
  assert.deepEqual(
    narrowSlashChoice(
      choose,
      states({ [A]: "some", [B]: "empty", [C]: "empty" }),
    ),
    { kind: "agent", pubkey: A },
  );
  // The one left is still loading: keep offering it rather than guessing.
  assert.deepEqual(
    narrowSlashChoice(choose, states({ [B]: "empty", [C]: "empty" })),
    { kind: "choose", pubkeys: [A] },
  );
  assert.equal(
    narrowSlashChoice(
      choose,
      states({ [A]: "empty", [B]: "empty", [C]: "empty" }),
    ),
    null,
  );
  const single = { kind: "agent", pubkey: A };
  assert.equal(narrowSlashChoice(single, states({ [A]: "empty" })), single);
  assert.equal(narrowSlashChoice(null, states({})), null);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  detectGroupSlashQuery,
  groupSkillTag,
  MAX_SLASH_AGENT_CHOICES,
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
  assert.deepEqual(invocation, { command: REVIEW, args: "the PR" });
  assert.deepEqual(groupSkillTag(invocation), [
    "buzz-skill",
    "skill-review",
    "the PR",
  ]);
  assert.equal(parseGroupSkillInvocation("please /review", [REVIEW]), null);
  assert.equal(
    groupSkillTag({ command: REVIEW, args: "x".repeat(MAX_SKILL_ARGS + 1) }),
    null,
  );
});

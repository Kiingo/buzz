import assert from "node:assert/strict";
import test from "node:test";

import {
  agentDmPeer,
  argumentHintFor,
  buildSkillMessage,
  detectSlashQuery,
  filterSlashCommands,
  MAX_SKILL_ARGS,
  parseSkillInvocation,
  slashCommandNeedsConfirm,
  slashCommandSection,
  slashCommandText,
  slashTokens,
} from "./slashQuery.ts";

const SESSION_NEW = {
  kind: "session",
  name: "new",
  description: "Start a fresh session",
  usage: "/new",
};
const SESSION_LIST = {
  kind: "session",
  name: "sessions",
  description: "List sessions",
  usage: null,
};
const REVIEW = {
  kind: "skill",
  name: "review",
  skillId: "skill-review-1",
  description: "Review a pull request",
  argumentHint: "<pr url>",
};
const RENEW = {
  kind: "skill",
  name: "renew-cert",
  skillId: "skill-renew",
  description: null,
  argumentHint: null,
};
const COMMANDS = [SESSION_NEW, SESSION_LIST, REVIEW, RENEW];

const RESEARCH = {
  kind: "skill",
  name: "deep-research",
  skillId: "reg-research",
  description: "Research a topic in depth",
  argumentHint: null,
  source: "registry",
  displayName: "Deep Research",
};
const NOTES = {
  kind: "skill",
  name: "notes",
  skillId: "reg-notes",
  description: "Write review notes",
  argumentHint: null,
  source: "registry",
  displayName: null,
};

test("sections: commands, then this agent's skills, then registry skills", () => {
  assert.equal(slashCommandSection(SESSION_NEW), "commands");
  assert.equal(slashCommandSection(REVIEW), "agent-skills");
  assert.equal(slashCommandSection(RESEARCH), "skills");
  assert.deepEqual(
    filterSlashCommands([RESEARCH, REVIEW, SESSION_NEW], "").map(
      (command) => command.name,
    ),
    ["new", "review", "deep-research"],
  );
});

test("matching covers word prefixes, letters in order and descriptions", () => {
  const all = [...COMMANDS, RESEARCH, NOTES];
  assert.deepEqual(
    filterSlashCommands(all, "research").map((command) => command.name),
    ["deep-research"],
  );
  assert.deepEqual(
    filterSlashCommands(all, "dpr").map((command) => command.name),
    ["deep-research"],
  );
  assert.deepEqual(
    filterSlashCommands(all, "review").map((command) => command.name),
    ["review", "notes"],
    "a description match ranks after name matches",
  );
});

test("the menu opens for a / at any word start while the caret ends its token", () => {
  assert.deepEqual(detectSlashQuery("/", 1), {
    query: "",
    tokenStart: 0,
    tokenEnd: 1,
  });
  assert.deepEqual(detectSlashQuery("/rev", 4), {
    query: "rev",
    tokenStart: 0,
    tokenEnd: 4,
  });
  assert.deepEqual(detectSlashQuery("hi /rev", 7), {
    query: "rev",
    tokenStart: 3,
    tokenEnd: 7,
  });
  assert.deepEqual(detectSlashQuery(" /rev", 5), {
    query: "rev",
    tokenStart: 1,
    tokenEnd: 5,
  });
  assert.deepEqual(detectSlashQuery("line one\n/", 10), {
    query: "",
    tokenStart: 9,
    tokenEnd: 10,
  });
  assert.deepEqual(detectSlashQuery("see (/rev", 9), {
    query: "rev",
    tokenStart: 5,
    tokenEnd: 9,
  });
  // Mid-message, before more text: only the token is replaced on choose.
  assert.deepEqual(detectSlashQuery("hi /re there", 6), {
    query: "re",
    tokenStart: 3,
    tokenEnd: 6,
  });
  assert.equal(detectSlashQuery("/rev", 2), null, "caret inside the token");
  assert.equal(detectSlashQuery("/review the PR", 14), null);
  assert.equal(detectSlashQuery("/a/b", 4), null);
  assert.equal(detectSlashQuery("", 0), null);
});

test("a / inside a word, URL, email or path never opens the menu", () => {
  assert.equal(detectSlashQuery("a/rev", 5), null);
  assert.equal(detectSlashQuery("https://example.com/rev", 23), null);
  assert.equal(detectSlashQuery("see https://x.io/", 17), null);
  assert.equal(detectSlashQuery("me@example.com/rev", 18), null);
  assert.equal(detectSlashQuery("open ~/rev", 10), null);
  assert.equal(detectSlashQuery("open ./rev", 10), null);
  assert.equal(detectSlashQuery("open /usr/bin", 13), null);
  assert.deepEqual(slashTokens("a /x b/y /z"), [
    { start: 2, end: 4, name: "x" },
    { start: 9, end: 11, name: "z" },
  ]);
});

test("filtering puts prefix matches before substring matches", () => {
  assert.deepEqual(
    filterSlashCommands(COMMANDS, "").map((command) => command.name),
    ["new", "sessions", "review", "renew-cert"],
  );
  assert.deepEqual(
    filterSlashCommands(COMMANDS, "re").map((command) => command.name),
    ["review", "renew-cert"],
  );
  assert.deepEqual(
    filterSlashCommands(COMMANDS, "NEW").map((command) => command.name),
    ["new", "renew-cert"],
  );
  assert.deepEqual(filterSlashCommands(COMMANDS, "zzz"), []);
});

test("choosing a skill leaves room for arguments; a session command is exact", () => {
  assert.equal(slashCommandText(REVIEW), "/review ");
  assert.equal(slashCommandText(SESSION_NEW), "/new");
  assert.equal(slashCommandText(SESSION_LIST), "/sessions");
});

test("a skill send is /<name> <args> with exactly one buzz-skill tag", () => {
  const invocation = parseSkillInvocation(
    "/review  https://example.com/pr/1 please ",
    COMMANDS,
  );
  assert.deepEqual(buildSkillMessage(invocation), {
    ok: true,
    content: "/review https://example.com/pr/1 please",
    tags: [["buzz-skill", "skill-review-1", "https://example.com/pr/1 please"]],
  });
  assert.deepEqual(
    buildSkillMessage(parseSkillInvocation("/review", COMMANDS)),
    {
      ok: true,
      content: "/review",
      tags: [["buzz-skill", "skill-review-1", ""]],
    },
  );
  assert.deepEqual(
    buildSkillMessage(
      parseSkillInvocation(
        `/review ${"x".repeat(MAX_SKILL_ARGS + 1)}`,
        COMMANDS,
      ),
    ),
    { ok: false, reason: "args_too_long" },
  );
  assert.equal(
    buildSkillMessage(
      parseSkillInvocation(`/review ${"x".repeat(MAX_SKILL_ARGS)}`, COMMANDS),
    ).ok,
    true,
  );
});

test("only listed skills are invocations; session commands stay plain messages", () => {
  assert.equal(parseSkillInvocation("/new", COMMANDS), null);
  assert.equal(parseSkillInvocation("/sessions", COMMANDS), null);
  assert.equal(parseSkillInvocation("/unknown args", COMMANDS), null);
  assert.equal(parseSkillInvocation("/Review x", COMMANDS), null);
  assert.equal(parseSkillInvocation("review x", COMMANDS), null);
  assert.equal(parseSkillInvocation("/reviewer x", COMMANDS), null);
});

test("a skill picked mid-message is the invocation, with the whole message as input", () => {
  const picked = new Set(["review"]);
  const invocation = parseSkillInvocation(
    "please /review https://example.com/pr/1 today",
    COMMANDS,
    picked,
  );
  assert.equal(invocation.command.name, "review");
  assert.equal(invocation.args, "please https://example.com/pr/1 today");
  assert.deepEqual(buildSkillMessage(invocation), {
    ok: true,
    content: "please /review https://example.com/pr/1 today",
    tags: [
      ["buzz-skill", "skill-review-1", "please https://example.com/pr/1 today"],
    ],
  });
  assert.equal(
    parseSkillInvocation("can you /review this", COMMANDS, picked).args,
    "can you this",
  );
  // A name typed mid-message without picking it stays a plain message.
  assert.equal(parseSkillInvocation("I ran /review yesterday", COMMANDS), null);
  // A leading skill may still be typed by hand.
  assert.equal(parseSkillInvocation("/review x", COMMANDS).args, "x");
  // A session command is never a mid-message invocation.
  assert.equal(
    parseSkillInvocation("hi /new", COMMANDS, new Set(["new"])),
    null,
  );
});

test("one skill per message: the last picked token counts", () => {
  const invocation = parseSkillInvocation(
    "/renew-cert first then /review second",
    COMMANDS,
    new Set(["renew-cert", "review"]),
  );
  assert.equal(invocation.command.name, "review");
  assert.equal(invocation.args, "/renew-cert first then second");
});

test("the argument hint shows only while the arguments are still empty", () => {
  assert.equal(argumentHintFor("/review ", COMMANDS), "<pr url>");
  assert.equal(argumentHintFor("/review", COMMANDS), "<pr url>");
  assert.equal(argumentHintFor("/review x", COMMANDS), null);
  assert.equal(argumentHintFor("/renew-cert ", COMMANDS), null);
  assert.equal(argumentHintFor("hello", COMMANDS), null);
});

test("the menu belongs to 1:1 DMs whose other member is an agent", () => {
  const self = "a".repeat(64);
  const agent = "b".repeat(64);
  const human = "c".repeat(64);
  const isAgent = (pubkey) => pubkey === agent;
  const dm = (participantPubkeys, channelType = "dm") => ({
    channelType,
    participantPubkeys,
  });
  assert.equal(
    agentDmPeer(dm([self, agent.toUpperCase()]), self, isAgent),
    agent,
  );
  assert.equal(agentDmPeer(dm([self, human]), self, isAgent), null);
  assert.equal(agentDmPeer(dm([self, agent, human]), self, isAgent), null);
  assert.equal(agentDmPeer(dm([self, agent], "stream"), self, isAgent), null);
  assert.equal(agentDmPeer(dm([self, agent]), undefined, isAgent), null);
  assert.equal(agentDmPeer(undefined, self, isAgent), null);
});

test("only /new asks for confirmation; /sessions and skills do not", () => {
  assert.equal(slashCommandNeedsConfirm(SESSION_NEW), true);
  assert.equal(slashCommandNeedsConfirm(SESSION_LIST), false);
  assert.equal(slashCommandNeedsConfirm(REVIEW), false);
});

test("the menu lists every match, not just a first screenful", () => {
  const many = Array.from({ length: 300 }, (_, index) => ({
    kind: "skill",
    name: `skill-${String(index).padStart(3, "0")}`,
    skillId: `sk-${index}`,
    description: null,
    argumentHint: null,
    source: "registry",
    displayName: null,
  }));
  assert.equal(filterSlashCommands(many, "").length, 300);
  assert.deepEqual(
    filterSlashCommands(many, "skill-29")
      .slice(0, 10)
      .map((command) => command.name),
    Array.from({ length: 10 }, (_, index) => `skill-29${index}`),
  );
});

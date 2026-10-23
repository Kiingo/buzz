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

test("the menu opens only for a leading / while the caret is in the first token", () => {
  assert.deepEqual(detectSlashQuery("/", 1), { query: "", tokenEnd: 1 });
  assert.deepEqual(detectSlashQuery("/rev", 4), { query: "rev", tokenEnd: 4 });
  assert.equal(detectSlashQuery("/rev", 2), null, "caret inside the token");
  assert.equal(detectSlashQuery("/review the PR", 14), null);
  assert.equal(detectSlashQuery("hi /rev", 7), null);
  assert.equal(detectSlashQuery(" /rev", 5), null);
  assert.equal(detectSlashQuery("/a/b", 4), null);
  assert.equal(detectSlashQuery("", 0), null);
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

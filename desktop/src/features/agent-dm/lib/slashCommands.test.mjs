import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  COMMANDS_REVALIDATE_MS,
  getAgentCommands,
  parseAgentCommandsBody,
  refreshAgentCommands,
  resetAgentCommandsCache,
  setAgentCommandsTransportForTests,
} from "./slashCommands.ts";

const AGENT = "a".repeat(64);

function body(commands, overrides = {}) {
  return {
    contract_version: 1,
    agent_id: "agent-1",
    agent_public_key: AGENT,
    commands,
    ...overrides,
  };
}

const LISTED = [
  { kind: "session", name: "new", description: "Fresh session", usage: "/new" },
  {
    kind: "session",
    name: "sessions",
    description: "List",
    usage: "/sessions",
  },
  {
    kind: "skill",
    name: "review",
    skill_id: "sk-1",
    description: "Review a PR",
    argument_hint: "<pr url>",
  },
];

let restore = () => {};
afterEach(() => {
  restore();
  resetAgentCommandsCache();
});

test("bodies are validated and malformed entries dropped", () => {
  assert.deepEqual(parseAgentCommandsBody(body(LISTED), AGENT.toUpperCase()), [
    {
      kind: "session",
      name: "new",
      description: "Fresh session",
      usage: "/new",
    },
    {
      kind: "session",
      name: "sessions",
      description: "List",
      usage: "/sessions",
    },
    {
      kind: "skill",
      name: "review",
      skillId: "sk-1",
      description: "Review a PR",
      argumentHint: "<pr url>",
      source: "installed",
      displayName: null,
    },
  ]);
  assert.equal(
    parseAgentCommandsBody(body(LISTED, { contract_version: 2 }), AGENT),
    null,
  );
  assert.equal(
    parseAgentCommandsBody(
      body(LISTED, { agent_public_key: "b".repeat(64) }),
      AGENT,
    ),
    null,
  );
  assert.equal(parseAgentCommandsBody(body("nope"), AGENT), null);
  assert.equal(parseAgentCommandsBody(null, AGENT), null);
  assert.deepEqual(
    parseAgentCommandsBody(
      body([
        { kind: "session", name: "reset", description: "x" },
        { kind: "skill", name: "has space", skill_id: "s" },
        { kind: "skill", name: "ok", skill_id: "" },
        { kind: "skill", name: "new", skill_id: "shadow" },
        { kind: "session", name: "new", description: "" },
        { kind: "skill", name: "dup", skill_id: "d1", description: null },
        { kind: "skill", name: "DUP", skill_id: "d2" },
        { kind: "other", name: "x" },
      ]),
      AGENT,
    ).map((command) => `${command.kind}:${command.name}`),
    ["session:new", "skill:dup"],
  );
});

test("registry skills keep their source and display name", () => {
  const [registry] = parseAgentCommandsBody(
    body([
      {
        kind: "skill",
        name: "deep-research",
        skill_id: "reg-1",
        description: "Research a topic",
        argument_hint: null,
        source: "registry",
        display_name: "Deep Research",
      },
    ]),
    AGENT,
  );
  assert.deepEqual(registry, {
    kind: "skill",
    name: "deep-research",
    skillId: "reg-1",
    description: "Research a topic",
    argumentHint: null,
    source: "registry",
    displayName: "Deep Research",
  });
});

function harness(respond) {
  const calls = [];
  let clock = 1_000_000;
  restore = setAgentCommandsTransportForTests({
    transport: async (input) => {
      calls.push(input);
      return respond(input, calls.length);
    },
    now: () => clock,
  });
  return {
    calls,
    advance(ms) {
      clock += ms;
    },
  };
}

test("lazy fetch caches the list with its ETag and revalidates with If-None-Match", async () => {
  const h = harness((input) =>
    input.etag === '"v1"'
      ? { notModified: true, etag: '"v1"', body: null }
      : { notModified: false, etag: '"v1"', body: body(LISTED) },
  );
  assert.deepEqual(
    getAgentCommands(AGENT),
    [],
    "nothing before the menu opens",
  );
  await refreshAgentCommands(AGENT);
  assert.equal(getAgentCommands(AGENT).length, 3);
  await refreshAgentCommands(AGENT);
  assert.equal(h.calls.length, 1, "a fresh answer is reused");
  h.advance(COMMANDS_REVALIDATE_MS);
  await refreshAgentCommands(AGENT);
  assert.deepEqual(h.calls[1], {
    agentPublicKey: AGENT,
    etag: '"v1"',
    audience: "private",
  });
  assert.equal(getAgentCommands(AGENT).length, 3, "304 keeps the cached list");
});

test("a channel's group list is cached apart from the DM's private one", async () => {
  const h = harness((input) => ({
    notModified: false,
    etag: `"${input.audience}"`,
    body: body(input.audience === "group" ? LISTED.slice(0, 1) : LISTED),
  }));
  await refreshAgentCommands(AGENT, "group");
  assert.equal(getAgentCommands(AGENT, "group").length, 1);
  assert.deepEqual(getAgentCommands(AGENT), [], "the private list is separate");
  await refreshAgentCommands(AGENT);
  assert.equal(getAgentCommands(AGENT).length, 3);
  assert.deepEqual(
    h.calls.map((call) => call.audience),
    ["group", "private"],
  );
});

test("any error or invalid body shows no commands and does not retry at once", async () => {
  let fail = false;
  const h = harness(() => {
    if (fail) throw new Error('{"status":403,"error":"identity_not_linked"}');
    return { notModified: false, etag: '"v1"', body: body(LISTED) };
  });
  await refreshAgentCommands(AGENT);
  assert.equal(getAgentCommands(AGENT).length, 3);
  fail = true;
  h.advance(COMMANDS_REVALIDATE_MS);
  await refreshAgentCommands(AGENT);
  assert.deepEqual(getAgentCommands(AGENT), [], "an error withdraws the list");
  await refreshAgentCommands(AGENT);
  assert.equal(h.calls.length, 2, "no retry loop");

  restore();
  const invalid = harness(() => ({
    notModified: false,
    etag: '"x"',
    body: { nope: 1 },
  }));
  resetAgentCommandsCache();
  await refreshAgentCommands(AGENT);
  assert.deepEqual(getAgentCommands(AGENT), []);
  assert.equal(invalid.calls.length, 1);
});

test("concurrent opens share one lookup; a community switch retires it", async () => {
  let release;
  restore = setAgentCommandsTransportForTests({
    transport: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    now: () => 1,
  });
  const first = refreshAgentCommands(AGENT);
  const second = refreshAgentCommands(AGENT);
  assert.equal(first, second);
  resetAgentCommandsCache();
  release({ notModified: false, etag: null, body: body(LISTED) });
  await first;
  assert.deepEqual(getAgentCommands(AGENT), []);
  assert.deepEqual(await refreshAgentCommands("not-hex"), undefined);
});

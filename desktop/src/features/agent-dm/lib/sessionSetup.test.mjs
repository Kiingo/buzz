import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { setAgentCallSendForTests } from "../../agent-call/lib/agentCallApi.ts";
import {
  resetAgentSummaryCache,
  setAgentSummaryLookupForTests,
} from "./agentSummary.ts";
import {
  availableModes,
  changeSessionSetup,
  contextLine,
  ensureSessionSetup,
  getSessionSetup,
  modeNote,
  parseSessionSetupPanel,
  parseSetupCommand,
  requestSetupPicker,
  resetSessionSetupCache,
  resolveEffortArg,
  resolveModelArg,
  setupChangeErrorSentence,
  setupChipText,
  setupCommandEntries,
  stopAgentDmTurn,
  takeSetupPickerRequest,
  vitalsLines,
} from "./sessionSetup.ts";
import {
  activityLine,
  ensureReplyTurn,
  findReply,
  getReplyTurn,
  loadTurnSteps,
  parseChatReplies,
  parseTurnSteps,
  replyKey,
  replyLine,
  resetTurnStepsCache,
  setTurnStepsClockForTests,
  stepsDuration,
} from "./turnSteps.ts";

const AGENT = "a".repeat(64);
const AGENT_ID = "0192a6b0-0000-7000-8000-0000000000aa";

function panelBody(overrides = {}) {
  return {
    current: {
      harness: "claude-code",
      model: "opus",
      effort: "high",
      label: "Claude Code · Opus 5.5 · High",
      revision: 3,
    },
    options: {
      harnesses: [
        {
          id: "codex",
          models: [{ id: "gpt", label: "GPT", efforts: ["low"] }],
        },
        {
          id: "claude-code",
          models: [
            { id: "opus", label: "Opus 5.5", efforts: ["low", "high"] },
            { id: "sonnet", label: "Sonnet 5", efforts: ["low"] },
          ],
        },
      ],
      effortLabels: { low: "Low", high: "High" },
    },
    canChange: { harness: false, model: true, effort: true, speed: true },
    changes: [],
    ...overrides,
  };
}

const MODES = [
  {
    id: "ceiling",
    label: "Full",
    description: "Runs with the agent's own access",
    isDefault: true,
    available: true,
    unavailableReason: null,
  },
  {
    id: "ask",
    label: "Ask",
    description: "Asks before edits, commands and other tools",
    isDefault: false,
    available: true,
    unavailableReason: null,
  },
  {
    id: "plan",
    label: "Plan",
    description: "Stops file edits",
    isDefault: false,
    available: false,
    unavailableReason: "harness",
  },
];

function modeBody(overrides = {}) {
  const body = panelBody(overrides);
  return {
    ...body,
    current: { ...body.current, mode: "ask", modeBeforePlan: null },
    options: { ...body.options, modes: MODES },
    canChange: { ...body.canChange, mode: true },
  };
}

const VITALS = {
  session_id: "s-1",
  account_usage: {
    account_alias: "rosspro",
    freshness: "fresh",
    five_hour: { remaining_percent: 40, used_percent: 60, resets_at: null },
    seven_day: null,
    seven_day_opus: { remaining_percent: 75.4, resets_at: null },
    seven_day_sonnet: null,
  },
  context: { tokens: 50_000, window: 200_000, percent: 25 },
  todos: {
    total: 5,
    completed: 2,
    in_progress: 1,
    items: [
      { text: "done one", status: "completed" },
      { text: "doing this", status: "in_progress" },
    ],
  },
  location: { cwd: "/home/me/repo/", branch: "main", worktree: null },
  cost: { usd: 4.1 },
};

function installHost(handlers) {
  const calls = [];
  const restoreSend = setAgentCallSendForTests(async (method, path, body) => {
    calls.push({ method, path, body });
    return handlers(method, path, body);
  });
  const restoreLookup = setAgentSummaryLookupForTests({
    lookup: async () => ({
      contract_version: 1,
      agent_public_key: AGENT,
      agent: { id: AGENT_ID, name: "Assistant" },
    }),
  });
  restores.push(restoreSend, restoreLookup);
  return calls;
}

const restores = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  resetSessionSetupCache();
  resetTurnStepsCache();
  resetAgentSummaryCache();
});

test("parses the panel for the current harness only", () => {
  const panel = parseSessionSetupPanel(panelBody());
  assert.equal(panel.label, "Claude Code · Opus 5.5 · High");
  assert.deepEqual(
    panel.models.map((model) => model.id),
    ["opus", "sonnet"],
  );
  assert.equal(panel.canChangeModel, true);
  assert.equal(panel.vitals, null);
});

test("a body that is not the panel is no panel", () => {
  assert.equal(parseSessionSetupPanel(null), null);
  assert.equal(parseSessionSetupPanel({ current: {} }), null);
  assert.equal(
    parseSessionSetupPanel(
      panelBody({ current: { harness: "codex", model: "x" } }),
    ),
    null,
  );
});

test("vitals read as the same lines as the other apps", () => {
  const panel = parseSessionSetupPanel(panelBody({ vitals: VITALS }));
  assert.deepEqual(
    vitalsLines(panel.vitals, new Date("2026-11-02T00:00:00Z")),
    [
      "rosspro",
      "5h 40% left",
      "Opus 7d 75% left",
      "Context 25% · 50k of 200k",
      "Todos 2 of 5",
      "doing this",
      "Est. $4.10",
      "repo · main",
    ],
  );
  assert.equal(setupChipText(panel), "Claude Code · Opus 5.5 · High · 25%");
});

test("a context with no window shows only its tokens", () => {
  assert.equal(
    contextLine({ tokens: 1_500_000, window: null, percent: null }),
    "Context 1.5M",
  );
});

test("an empty context and todo list show nothing", () => {
  const panel = parseSessionSetupPanel(
    panelBody({
      vitals: {
        account_usage: null,
        context: { tokens: 0, window: null, percent: null },
        todos: { total: 0, completed: 0, items: [] },
        location: null,
        cost: null,
      },
    }),
  );
  assert.deepEqual(vitalsLines(panel.vitals), []);
  assert.equal(setupChipText(panel), "Claude Code · Opus 5.5 · High");
});

test("an account not fresh says so", () => {
  const panel = parseSessionSetupPanel(
    panelBody({
      vitals: {
        ...VITALS,
        account_usage: { ...VITALS.account_usage, freshness: "stale" },
      },
    }),
  );
  assert.equal(vitalsLines(panel.vitals)[0], "rosspro (may be out of date)");
});

test("only a whole session command parses", () => {
  assert.deepEqual(parseSetupCommand(" /model "), { name: "model", arg: null });
  assert.deepEqual(parseSetupCommand("/model opus 5"), {
    name: "model",
    arg: "opus 5",
  });
  assert.deepEqual(parseSetupCommand("/effort high"), {
    name: "effort",
    arg: "high",
  });
  assert.deepEqual(parseSetupCommand("/cost"), { name: "cost", arg: null });
  assert.equal(parseSetupCommand("/cost of living"), null);
  assert.equal(parseSetupCommand("what /model is this"), null);
  assert.equal(parseSetupCommand("/models"), null);
  assert.equal(parseSetupCommand("/Model"), null);
});

test("a pick must be clear, otherwise the panel opens", () => {
  const panel = parseSessionSetupPanel(panelBody());
  assert.deepEqual(resolveModelArg(panel, "SONNET"), { pick: "sonnet" });
  assert.deepEqual(resolveModelArg(panel, "opus 5.5"), { pick: "opus" });
  assert.deepEqual(resolveModelArg(panel, "son"), { pick: "sonnet" });
  assert.deepEqual(resolveModelArg(panel, "default"), { pick: null });
  assert.equal(resolveModelArg(panel, "o"), "ask");
  assert.equal(resolveModelArg(panel, "gpt"), "ask");
  assert.deepEqual(resolveEffortArg(panel, "Low"), { pick: "low" });
  assert.equal(resolveEffortArg(panel, "max"), "ask");
});

test("the menu offers a pick only when the reader may change it", () => {
  const names = (canChange) =>
    setupCommandEntries(parseSessionSetupPanel(panelBody({ canChange }))).map(
      (entry) => entry.name,
    );
  assert.deepEqual(names({ model: true, effort: true }), [
    "model",
    "effort",
    "status",
    "usage",
    "context",
    "cost",
  ]);
  assert.deepEqual(names({ model: false, effort: true }), [
    "effort",
    "status",
    "usage",
    "context",
    "cost",
  ]);
});

test("reads through the agent's id on its host", async () => {
  const calls = installHost(() => ({ status: 200, body: panelBody() }));
  await ensureSessionSetup(AGENT);
  assert.equal(getSessionSetup(AGENT).revision, 3);
  assert.deepEqual(calls[0], {
    method: "GET",
    path: `agents/${AGENT_ID}/session-setup`,
    body: undefined,
  });
  await ensureSessionSetup(AGENT);
  assert.equal(calls.length, 1, "a fresh answer isn't asked again");
});

test("an agent with no host has no panel and asks nothing", async () => {
  const calls = installHost(() => ({ status: 200, body: panelBody() }));
  restores.push(
    setAgentSummaryLookupForTests({
      lookup: async () => {
        throw new Error("not found");
      },
    }),
  );
  await ensureSessionSetup(AGENT);
  assert.equal(getSessionSetup(AGENT), null);
  assert.equal(calls.length, 0);
});

test("a refused read is no panel", async () => {
  installHost(() => ({ status: 403, body: { error: "forbidden" } }));
  await ensureSessionSetup(AGENT);
  assert.equal(getSessionSetup(AGENT), null);
});

test("a change sends the revision and takes the host's answer", async () => {
  const calls = installHost((method) =>
    method === "GET"
      ? { status: 200, body: panelBody() }
      : {
          status: 200,
          body: {
            setup: panelBody({
              current: {
                harness: "claude-code",
                model: "sonnet",
                effort: "low",
                label: "Claude Code · Sonnet 5 · Low",
                revision: 4,
              },
            }),
            changed: true,
          },
        },
  );
  await ensureSessionSetup(AGENT);
  await changeSessionSetup(AGENT, { model: "sonnet" });
  const put = calls.find((call) => call.method === "PUT");
  assert.equal(put.path, `agents/${AGENT_ID}/session-setup`);
  assert.deepEqual(put.body.choice, { model: "sonnet" });
  assert.equal(put.body.expectedRevision, 3);
  assert.ok(put.body.idempotencyKey);
  assert.equal(getSessionSetup(AGENT).model, "sonnet");
});

test("modes offered are only the ones the host marks available", () => {
  const panel = parseSessionSetupPanel(modeBody());
  assert.equal(panel.mode, "ask");
  assert.equal(panel.canChangeMode, true);
  assert.deepEqual(
    availableModes(panel).map((mode) => mode.id),
    ["ceiling", "ask"],
  );
  assert.equal(
    modeNote(panel),
    "Ask: Asks before edits, commands and other tools. Plan isn't available on this harness.",
  );
});

test("no mode picks without the host's leave, or from an older host", () => {
  const body = modeBody();
  const refused = parseSessionSetupPanel({
    ...body,
    canChange: { ...body.canChange, mode: false },
  });
  assert.equal(refused.canChangeMode, false);
  const older = parseSessionSetupPanel(panelBody());
  assert.deepEqual(older.modes, []);
  assert.equal(older.canChangeMode, false);
  assert.equal(modeNote(older), null);
});

test("a terminal session says it keeps its own mode", () => {
  const body = modeBody();
  const panel = parseSessionSetupPanel({
    ...body,
    options: {
      ...body.options,
      modes: MODES.map((mode) => ({
        ...mode,
        available: false,
        unavailableReason: "use_terminal_mode",
      })),
    },
  });
  assert.deepEqual(availableModes(panel), []);
  assert.equal(
    modeNote(panel),
    "This terminal session keeps its own mode. Change it in the terminal.",
  );
});

test("a mode pick sends only the mode", async () => {
  const calls = installHost((method) =>
    method === "GET"
      ? { status: 200, body: modeBody() }
      : { status: 200, body: { setup: modeBody(), changed: true } },
  );
  await ensureSessionSetup(AGENT);
  await changeSessionSetup(AGENT, { mode: "ceiling" });
  const put = calls.find((call) => call.method === "PUT");
  assert.deepEqual(put.body.choice, { mode: "ceiling" });
  assert.equal(put.body.expectedRevision, 3);
});

test("a mode the host won't run reads in words", async () => {
  installHost((method) =>
    method === "PUT"
      ? { status: 422, body: { error: "session_setup_mode_not_supported" } }
      : { status: 200, body: modeBody() },
  );
  await ensureSessionSetup(AGENT);
  const refused = await changeSessionSetup(AGENT, { mode: "plan" }).catch(
    (error) => error,
  );
  assert.equal(
    setupChangeErrorSentence(refused),
    "This session can't run that mode.",
  );
});

test("a read begun before a change can't undo it", async () => {
  let releaseRead;
  let reads = 0;
  installHost((method) => {
    if (method !== "GET") {
      return {
        status: 200,
        body: {
          setup: panelBody({
            current: {
              harness: "claude-code",
              model: "sonnet",
              effort: "low",
              label: "new",
              revision: 4,
            },
          }),
        },
      };
    }
    reads += 1;
    return new Promise((resolve) => {
      releaseRead = () => resolve({ status: 200, body: panelBody() });
    });
  });
  const reading = ensureSessionSetup(AGENT);
  while (reads === 0) await new Promise((resolve) => setImmediate(resolve));
  await changeSessionSetup(AGENT, { model: "sonnet" });
  releaseRead();
  await reading;
  assert.equal(getSessionSetup(AGENT).label, "new");
});

test("a revision conflict re-reads and says so in a sentence", async () => {
  let puts = 0;
  const calls = installHost((method) => {
    if (method === "PUT") {
      puts += 1;
      return {
        status: 409,
        body: { error: "session_setup_revision_conflict" },
      };
    }
    return { status: 200, body: panelBody() };
  });
  await ensureSessionSetup(AGENT);
  const refused = await changeSessionSetup(AGENT, { effort: "low" }).catch(
    (error) => error,
  );
  assert.equal(puts, 1);
  assert.match(setupChangeErrorSentence(refused), /just changed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call.method === "GET").length, 2);
});

test("an unknown refusal still gets a plain sentence", () => {
  assert.match(setupChangeErrorSentence(new Error("x")), /Try again/);
});

test("Stop posts the requester's stop and reads the outcome", async () => {
  let state = "stopping";
  const calls = installHost(() => ({ status: 202, body: { state } }));
  assert.equal(await stopAgentDmTurn(AGENT), "stopping");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, `agents/${AGENT_ID}/chat/stop`);
  assert.ok(calls[0].body.idempotencyKey);
  state = "stopped";
  assert.equal(await stopAgentDmTurn(AGENT), "stopped");
  state = "not_running";
  assert.equal(await stopAgentDmTurn(AGENT), "not_running");
  assert.notEqual(calls[0].body.idempotencyKey, calls[1].body.idempotencyKey);
});

test("a panel open is asked once", () => {
  requestSetupPicker(AGENT);
  assert.equal(takeSetupPickerRequest(AGENT), true);
  assert.equal(takeSetupPickerRequest(AGENT), false);
});

test("a community switch retires a read in flight", async () => {
  let release;
  installHost(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ status: 200, body: panelBody() });
      }),
  );
  const reading = ensureSessionSetup(AGENT);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  resetSessionSetupCache();
  release();
  await reading;
  assert.equal(getSessionSetup(AGENT), null);
});

// ── B2: a reply's steps line ──────────────────────────────────────────────

const RUN = "0192a6b0-0000-7000-8000-0000000000b1";
const OTHER_RUN = "0192a6b0-0000-7000-8000-0000000000b2";
const YOU = "0192a6b0-0000-7000-8000-0000000000c1";
const REPLY = "0192a6b0-0000-7000-8000-0000000000d1";
const LATER = "0192a6b0-0000-7000-8000-0000000000d2";

function chatPage() {
  return {
    entries: [
      { id: YOU, role: "you", at: "2026-11-04T10:00:00Z", runId: RUN },
      {
        id: REPLY,
        role: "agent",
        at: "2026-11-04T10:00:40Z",
        runId: RUN,
        turnId: YOU,
        activity: { turnId: YOU, state: "done", tools: 6, durationMs: 41_000 },
        memory: { turnId: YOU, label: "Recalled 2 memories" },
      },
      {
        id: LATER,
        role: "agent",
        at: "2026-11-04T10:05:00Z",
        runId: RUN,
      },
      {
        id: "0192a6b0-0000-7000-8000-0000000000d3",
        role: "agent",
        at: "2026-11-04T10:06:00Z",
        runId: OTHER_RUN,
      },
    ],
  };
}

const atSeconds = (iso) => Date.parse(iso) / 1000;

test("a reply names its Run, or its entry when mirrored", () => {
  assert.deepEqual(replyKey([["kiingo-mission", RUN.toUpperCase()]], 100), {
    runId: RUN,
    entryId: null,
    atMs: 100_000,
  });
  assert.deepEqual(
    replyKey(
      [
        ["buzz-mirror", "web", `${REPLY}#part-2`, "100"],
        ["buzz-mirror-author", "agent", "", ""],
      ],
      100,
    ),
    { runId: null, entryId: REPLY, atMs: 100_000 },
  );
  // A requester's mirrored words, a bad id or no tag: no line.
  assert.equal(
    replyKey(
      [
        ["buzz-mirror", "web", REPLY, "100"],
        ["buzz-mirror-author", "requester", "", ""],
      ],
      100,
    ),
    null,
  );
  assert.equal(replyKey([["kiingo-mission", "not-a-uuid"]], 100), null);
  assert.equal(replyKey([], 100), null);
});

test("the page ties a reply to the turn the other apps open", () => {
  const replies = parseChatReplies(chatPage());
  assert.deepEqual(
    replies.map((reply) => reply.id),
    [REPLY, LATER, "0192a6b0-0000-7000-8000-0000000000d3"],
  );
  const first = findReply(replies, {
    runId: RUN,
    entryId: null,
    atMs: Date.parse("2026-11-04T10:00:41Z"),
  });
  assert.equal(first.turnId, YOU);
  assert.equal(first.line, "Recalled 2 memories · Used 6 tools · 41 s");
  // The Run's reply nearest the Buzz reply's time; a reply no turn names
  // opens itself, with the unknown line.
  const later = findReply(replies, {
    runId: RUN,
    entryId: null,
    atMs: Date.parse("2026-11-04T10:04:58Z"),
  });
  assert.equal(later.turnId, LATER);
  assert.equal(later.line, "Steps");
  assert.equal(
    findReply(replies, { runId: null, entryId: LATER, atMs: 0 }).id,
    LATER,
  );
  assert.equal(
    findReply(replies, {
      runId: "0192a6b0-0000-7000-8000-0000000000ff",
      entryId: null,
      atMs: 0,
    }),
    null,
  );
  assert.deepEqual(parseChatReplies({ entries: "x" }), []);
});

test("the line uses the server's label, else the other apps' words", () => {
  assert.equal(
    activityLine({ label: "Used 3 tools · 9 s", tools: 1 }),
    "Used 3 tools · 9 s",
  );
  assert.equal(activityLine({ tools: 1 }), "Used 1 tool");
  assert.equal(activityLine({ tools: 0, reasoning: 0 }), null);
  assert.equal(replyLine(null, null), "Steps");
  assert.equal(stepsDuration(185_000), "3 min 5 s");
  assert.equal(stepsDuration(3_720_000), "1 h 2 min");
  assert.equal(stepsDuration(120_000), "2 min");
});

test("steps parse as plain fields; a bad link or a step without words drops", () => {
  const steps = parseTurnSteps({
    turnId: YOU,
    state: "done",
    durationMs: 41_000,
    omitted: 2,
    items: [
      {
        id: "s1",
        type: "tool",
        line: "Ran the tests",
        action: "Bash",
        state: "failed",
        args: "pnpm test",
        result: "1 failed",
        link: { url: "javascript:alert(1)" },
      },
      { id: "s2", type: "reasoning", text: "Thinking\nabout it" },
      { id: "s3", type: "tool" },
      {
        id: "s4",
        type: "note",
        line: "Opened the doc",
        link: { url: "https://example.com/doc", title: "Doc" },
      },
    ],
  });
  assert.equal(steps.omitted, 2);
  assert.deepEqual(
    steps.items.map((step) => [step.id, step.line, step.action, step.state]),
    [
      ["s1", "Ran the tests", "Bash", "failed"],
      ["s2", "Thinking about it", null, "done"],
      ["s4", "Opened the doc", null, "done"],
    ],
  );
  assert.equal(steps.items[0].link, null);
  assert.equal(steps.items[0].args, "pnpm test");
  assert.deepEqual(steps.items[2].link, {
    url: "https://example.com/doc",
    title: "Doc",
  });
  assert.equal(parseTurnSteps({ turnId: "x" }), null);
});

test("one page read serves every reply; the steps read is the turn's", async () => {
  const calls = installHost((_method, path) => {
    if (path.startsWith(`agents/${AGENT_ID}/chat?`)) {
      return { status: 200, body: chatPage() };
    }
    if (path === `agents/${AGENT_ID}/chat/turns/${YOU}/activity`) {
      return {
        status: 200,
        body: {
          turnId: YOU,
          state: "done",
          items: [{ id: "s1", line: "Read a file" }],
        },
      };
    }
    return { status: 404, body: { error: "not_found" } };
  });
  restores.push(
    setTurnStepsClockForTests(() => Date.parse("2026-11-04T10:10:00Z")),
  );
  const key = replyKey(
    [["kiingo-mission", RUN]],
    atSeconds("2026-11-04T10:00:41Z"),
  );
  await Promise.all([ensureReplyTurn(AGENT, key), ensureReplyTurn(AGENT, key)]);
  await ensureReplyTurn(AGENT, key);
  assert.equal(getReplyTurn(AGENT, key).turnId, YOU);
  const steps = await loadTurnSteps(AGENT, YOU);
  assert.equal(steps.items[0].line, "Read a file");
  await loadTurnSteps(AGENT, YOU);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      `GET agents/${AGENT_ID}/chat?contract=2&limit=50`,
      `GET agents/${AGENT_ID}/chat/turns/${YOU}/activity`,
    ],
  );
});

test("a reply newer than the last page read asks again; a failed steps read throws", async () => {
  let now = Date.parse("2026-11-04T10:01:00Z");
  restores.push(setTurnStepsClockForTests(() => now));
  const calls = installHost((_method, path) =>
    path.includes("/activity")
      ? { status: 500, body: { error: "internal" } }
      : { status: 200, body: chatPage() },
  );
  const old = replyKey(
    [["kiingo-mission", RUN]],
    atSeconds("2026-11-04T10:00:41Z"),
  );
  await ensureReplyTurn(AGENT, old);
  const newer = replyKey(
    [["kiingo-mission", "0192a6b0-0000-7000-8000-0000000000b3"]],
    atSeconds("2026-11-04T10:06:01Z"),
  );
  now = Date.parse("2026-11-04T10:01:05Z");
  await ensureReplyTurn(AGENT, newer);
  assert.equal(calls.length, 2);
  await assert.rejects(loadTurnSteps(AGENT, YOU));
});

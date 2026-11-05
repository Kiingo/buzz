import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { setAgentCallSendForTests } from "../../agent-call/lib/agentCallApi.ts";
import {
  AGENT_REF_COMMANDS,
  addPickedAgentRef,
  agentRefLabel,
  agentRefTags,
  agentRefTypeFor,
  agentRefsErrorSentence,
  clearPickedAgentRefs,
  getPickedAgentRefs,
  parseAgentRefs,
  requestAgentRefPicker,
  resetAgentRefs,
  searchAgentRefs,
  takeAgentRefPickerRequest,
} from "./agentRefs.ts";
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
import {
  ensureSessionBuiltins,
  getSessionBuiltins,
  interruptSession,
  loadQueuedMessages,
  loadSessionScreen,
  parseFileChanges,
  parseSessionScreen,
  requestSessionView,
  resetSessionViewsCache,
  sessionBuiltinForText,
  sessionViewErrorSentence,
  takeSessionViewRequest,
  withdrawQueuedMessage,
} from "./sessionViews.ts";

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
  resetSessionViewsCache();
  resetTurnStepsCache();
  resetAgentSummaryCache();
  resetAgentRefs();
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

// ── B3+B4: the session's views, read from the DM ─────────────────────────

const MSG = "0192a6b0-0000-7000-8000-0000000000c1";

function commandsBody(lane = "tmux") {
  return {
    contract_version: 1,
    agent_id: AGENT_ID,
    session: { id: "s", harness: "claude_code", lane, raw_available: false },
    commands: [
      { kind: "session", name: "new", action: { kind: "control" } },
      {
        kind: "session",
        name: "mcp",
        description: "MCP servers",
        action: { kind: "screen", screen: "mcp", session_id: "s" },
      },
      {
        kind: "session",
        name: "diff",
        description: "Files changed",
        action: { kind: "panel", panel: "diff", pending: false },
      },
      // A screen the host doesn't serve, and a row of a kind this
      // client leaves to its own path, never open a view.
      {
        kind: "session",
        name: "keys",
        action: { kind: "screen", screen: "keys" },
      },
      {
        kind: "session",
        name: "doctor",
        action: { kind: "unsupported", reason: "needs_terminal" },
      },
      { kind: "skill", name: "mcp", skill_id: "x" },
    ],
  };
}

test("the session's screens and /diff open views; nothing else does", async () => {
  const calls = installHost(() => ({ status: 200, body: commandsBody() }));
  await Promise.all([
    ensureSessionBuiltins(AGENT),
    ensureSessionBuiltins(AGENT),
  ]);
  await ensureSessionBuiltins(AGENT);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [`GET agents/${AGENT_ID}/commands`],
  );
  const builtins = getSessionBuiltins(AGENT);
  assert.equal(builtins.lane, "tmux");
  assert.deepEqual(
    builtins.rows.map((row) => [row.name, row.view]),
    [
      ["mcp", { kind: "screen", screen: "mcp" }],
      ["diff", { kind: "files" }],
    ],
  );
  assert.equal(sessionBuiltinForText(builtins, " /mcp ").name, "mcp");
  assert.equal(sessionBuiltinForText(builtins, "/mcp please"), null);
  assert.equal(sessionBuiltinForText(builtins, "/doctor"), null);
  assert.equal(sessionBuiltinForText(null, "/mcp"), null);
});

test("a failed built-ins read means no views and no Interrupt", async () => {
  installHost(() => ({ status: 503, body: { error: "database_unavailable" } }));
  await ensureSessionBuiltins(AGENT);
  assert.equal(getSessionBuiltins(AGENT), null);
});

test("a screen reads with no row action or write; unavailable stays unavailable", async () => {
  const calls = installHost(() => ({
    status: 200,
    body: {
      data: {
        title: "MCP servers",
        description: "From this session's project.",
        sections: [
          {
            id: "project",
            title: "Project",
            state: "unavailable",
            rows: [],
          },
          {
            id: "user",
            title: "User",
            state: "ok",
            empty: "None",
            rows: [
              {
                label: "github",
                value: "connected",
                mono: true,
                action: { kind: "open_session" },
                actions: [{ kind: "edit" }],
              },
              { value: "no label drops" },
            ],
          },
        ],
      },
    },
  }));
  const screen = await loadSessionScreen(AGENT, "mcp");
  assert.equal(calls[0].path, `agents/${AGENT_ID}/session/screens/mcp`);
  assert.equal(screen.sections[0].unavailable, true);
  assert.deepEqual(screen.sections[1].rows, [
    {
      label: "github",
      value: "connected",
      detail: null,
      body: null,
      mono: true,
    },
  ]);
  assert.equal(parseSessionScreen({ data: {} }), null);
});

test("file changes keep only well-formed lines", () => {
  const [change] = parseFileChanges({
    data: [
      {
        id: "t1",
        path: "src/a.ts",
        kind: "edit",
        moved_to: null,
        failed: false,
        added: 1,
        removed: 1,
        lines: [
          { sign: "-", text: "old" },
          { sign: "+", text: "new" },
          { sign: "*", text: "bad" },
        ],
      },
      { id: "t2", path: "x", kind: "chmod" },
    ],
  });
  assert.deepEqual(change.lines, [
    { sign: "-", text: "old" },
    { sign: "+", text: "new" },
  ]);
  assert.equal(parseFileChanges({ data: null }), null);
});

test("queued messages read the reader's own; Withdraw names one", async () => {
  const calls = installHost((method) =>
    method === "GET"
      ? {
          status: 200,
          body: {
            data: [
              {
                message_id: MSG.toUpperCase(),
                body: "also check the tests",
                created_at: "2026-11-04T10:00:00Z",
                send_when: "idle",
              },
              { message_id: "not-an-id", body: "drops" },
            ],
          },
        }
      : { status: 200, body: { data: { message_id: MSG } } },
  );
  const queued = await loadQueuedMessages(AGENT);
  assert.deepEqual(queued, [
    {
      messageId: MSG,
      body: "also check the tests",
      createdAt: "2026-11-04T10:00:00Z",
      idle: true,
    },
  ]);
  await withdrawQueuedMessage(AGENT, MSG);
  assert.equal(calls[1].method, "POST");
  assert.equal(
    calls[1].path,
    `agents/${AGENT_ID}/session/queued/${MSG}/withdraw`,
  );
  await assert.rejects(withdrawQueuedMessage(AGENT, "not-an-id"));
});

test("Interrupt posts a fresh key each time, and a refusal reads in words", async () => {
  let answer = { status: 200, body: { data: {} } };
  const calls = installHost(() => answer);
  await interruptSession(AGENT);
  await interruptSession(AGENT);
  assert.equal(calls[0].path, `agents/${AGENT_ID}/session/interrupt`);
  assert.ok(calls[0].body.idempotency_key);
  assert.notEqual(calls[0].body.idempotency_key, calls[1].body.idempotency_key);
  answer = { status: 409, body: { error: "session_taken_over" } };
  const error = await interruptSession(AGENT).catch((caught) => caught);
  assert.match(sessionViewErrorSentence(error), /taken over/);
  answer = { status: 404, body: { error: "session_not_found" } };
  const missing = await interruptSession(AGENT).catch((caught) => caught);
  assert.match(sessionViewErrorSentence(missing), /no session/);
});

test("a view open is asked once", () => {
  requestSessionView(AGENT, { kind: "queued" });
  assert.deepEqual(takeSessionViewRequest(AGENT), { kind: "queued" });
  assert.equal(takeSessionViewRequest(AGENT), null);
});

// ---- BUZZPARITY B5: task and project references ----

const TASK_ID = "0192a6b0-0000-7000-8000-0000000000b1";
const PROJECT_ID = "0192a6b0-0000-7000-8000-0000000000c2";

test("references read only well-formed task and project rows", () => {
  assert.equal(parseAgentRefs(null), null);
  assert.equal(parseAgentRefs([]), null);
  assert.deepEqual(
    parseAgentRefs({
      results: [
        {
          type: "task",
          id: TASK_ID.toUpperCase(),
          title: "Fix login",
          subtitle: "In your queue with Scout",
        },
        { type: "project", id: PROJECT_ID, title: "Launch" },
        { type: "comment", id: TASK_ID, title: "not offered" },
        { type: "task", id: "not-an-id", title: "drops" },
        { type: "task", id: TASK_ID },
      ],
    }),
    [
      {
        type: "task",
        id: TASK_ID,
        title: "Fix login",
        subtitle: "In your queue with Scout",
      },
      { type: "project", id: PROJECT_ID, title: "Launch", subtitle: null },
    ],
  );
});

test("a reference search asks the host for what the reader can read", async () => {
  const calls = installHost(() => ({
    status: 200,
    body: { results: [{ type: "task", id: TASK_ID, title: "Fix login" }] },
  }));
  const found = await searchAgentRefs(AGENT, "task", " fix login ");
  assert.equal(found.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(
    calls[0].path,
    `agents/${AGENT_ID}/chat/refs?types=task&q=fix%20login&limit=20`,
  );
  await searchAgentRefs(AGENT, "project", "");
  assert.equal(
    calls[1].path,
    `agents/${AGENT_ID}/chat/refs?types=project&limit=20`,
  );
  const error = await searchAgentRefs("not-a-key", "task", "").catch(
    (caught) => caught,
  );
  assert.match(agentRefsErrorSentence(error), /no host/);
});

test("only the reference rows open the picker, never a same-named command", () => {
  assert.equal(agentRefTypeFor(AGENT_REF_COMMANDS[0]), "task");
  assert.equal(agentRefTypeFor(AGENT_REF_COMMANDS[1]), "project");
  assert.equal(agentRefTypeFor({ ...AGENT_REF_COMMANDS[0] }), null);
  assert.equal(
    agentRefTypeFor({ kind: "skill", name: "task", description: "" }),
    null,
  );
});

test("a send tags each picked reference whose label is still there, once, with no count limit", () => {
  const picks = Array.from({ length: 30 }, (_, index) => ({
    type: "task",
    id: `0192a6b0-0000-7000-8000-${String(index).padStart(12, "0")}`,
    title: `Task ${String(index).padStart(2, "0")}`,
    subtitle: null,
  }));
  for (const pick of picks) addPickedAgentRef(AGENT, pick);
  addPickedAgentRef(AGENT, picks[0]);
  addPickedAgentRef(AGENT, {
    type: "project",
    id: PROJECT_ID,
    title: "  Launch\n plan ",
    subtitle: null,
  });
  assert.equal(
    agentRefLabel({ type: "project", title: "" }),
    "project: untitled",
  );
  const text = `${picks.map((pick) => agentRefLabel(pick)).join(" and ")} for project: Launch plan`;
  const tags = agentRefTags(getPickedAgentRefs(AGENT), text);
  assert.equal(tags.length, 31);
  assert.deepEqual(tags[0], ["buzz-ref", "task", picks[0].id]);
  assert.deepEqual(tags.at(-1), ["buzz-ref", "project", PROJECT_ID]);
  // A label the person deleted sends nothing.
  assert.deepEqual(
    agentRefTags(getPickedAgentRefs(AGENT), "task: Task 03 only"),
    [["buzz-ref", "task", picks[3].id]],
  );
  // Picks are per agent, and go after a send or a cleared draft.
  assert.deepEqual(getPickedAgentRefs("b".repeat(64)), []);
  clearPickedAgentRefs(AGENT);
  assert.deepEqual(getPickedAgentRefs(AGENT), []);
});

test("a picker open is asked once, and a community switch forgets picks", () => {
  const onPick = () => {};
  requestAgentRefPicker(AGENT, { type: "project", onPick });
  assert.deepEqual(takeAgentRefPickerRequest(AGENT), {
    type: "project",
    onPick,
  });
  assert.equal(takeAgentRefPickerRequest(AGENT), null);
  addPickedAgentRef(AGENT, {
    type: "task",
    id: TASK_ID,
    title: "Fix login",
    subtitle: null,
  });
  requestAgentRefPicker(AGENT, { type: "task", onPick });
  resetAgentRefs();
  assert.deepEqual(getPickedAgentRefs(AGENT), []);
  assert.equal(takeAgentRefPickerRequest(AGENT), null);
  const init = readFileSync(
    new URL("../../communities/useCommunityInit.ts", import.meta.url),
    "utf8",
  );
  assert.match(init, /resetAgentRefs\(\);/);
});

test("both DM sends carry the reference tags, and the rows are DM-only", () => {
  const hook = readFileSync(
    new URL("../ui/useAgentSlashCommands.ts", import.meta.url),
    "utf8",
  );
  const composer = readFileSync(
    new URL("../../messages/ui/MessageComposer.tsx", import.meta.url),
    "utf8",
  );
  // The skill send adds them to its own tags.
  assert.match(
    hook,
    /\.\.\.message\.tags,\s*\.\.\.agentRefTags\(getPickedAgentRefs\(dmPeer\), plainText\)/,
  );
  // The ordinary send (media included) adds them to its marker tags.
  assert.match(
    composer,
    /\.\.\.agentSlash\.refMarkerTags\(richText\.getPlainTextAndCursor\(\)\.text\)/,
  );
  assert.match(
    hook,
    /mode === "dm" && dmPeer\s*\? agentRefTags\(getPickedAgentRefs\(dmPeer\), plainText\)\s*: \[\]/,
  );
  assert.match(hook, /useAgentSummary\(mode === "dm" \? dmPeer : null\)/);
});

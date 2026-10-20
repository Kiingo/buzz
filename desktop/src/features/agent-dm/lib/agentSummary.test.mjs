import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  AGENT_SUMMARY_TTL_MS,
  agentSummaryForYouLabel,
  agentSummaryRows,
  cachedAgentSummary,
  ensureAgentSummary,
  hasAgentDm,
  parseAgentSummary,
  resetAgentSummaryCache,
  setAgentSummaryLookupForTests,
} from "./agentSummary.ts";

const AGENT = "a".repeat(64);
const SELF = "b".repeat(64);

function body(overrides = {}) {
  return {
    contract_version: 1,
    agent_public_key: AGENT,
    agent: {
      id: "ag-1",
      name: "Assistant",
      handle: "assistant",
      description: "Helps with email",
      status: "enabled",
    },
    owner: { principal_type: "Organization", display_name: null },
    viewer_role: "member",
    execution: {
      harness: "claude-code",
      model: "opus",
      effort: "high",
      tier: "standard",
      pinned: true,
      resolved_model: "opus-5",
      resolved_effort: "high",
      unavailable_reason: null,
    },
    location: { kind: "kiingo_compute", machine_name: null },
    viewer_session: {
      session_id: "s-1",
      harness: "claude-code",
      title: "Inbox triage",
      turn_count: 4,
      started_at: "2026-10-20T10:00:00Z",
      last_activity_at: "2026-10-20T11:00:00Z",
    },
    session_controls: true,
    skills: [
      { id: "sk-1", name: "review", description: null },
      { id: "sk-2", name: "triage", description: "x" },
      { id: "sk-3", name: "" },
    ],
    tools: {
      kiingo_mcp: true,
      execution_trust: "full",
      allowed_tool_count: 10,
      denied_tool_count: 1,
      required_scopes: [],
    },
    edit_url: "https://example.com/agents/ag-1",
    ...overrides,
  };
}

let restore = () => {};
afterEach(() => {
  restore();
  resetAgentSummaryCache();
});

test("the section rows match the mobile card's labels", () => {
  const summary = parseAgentSummary(body(), AGENT.toUpperCase());
  assert.deepEqual(agentSummaryRows(summary), [
    { label: "About", value: "Helps with email" },
    { label: "Runs on", value: "Claude Code · opus · high (pinned)" },
    { label: "For you", value: "opus-5 · high" },
    { label: "Where", value: "Hosted compute" },
    { label: "Your session", value: "Inbox triage · 4 turns" },
    { label: "Owner", value: "Your organization" },
    { label: "2 skills", value: "review, triage" },
    { label: "Tools", value: "MCP tools, full trust" },
  ]);
  assert.equal(summary.editUrl, "https://example.com/agents/ag-1");
});

test("optional parts and plain reasons", () => {
  const summary = parseAgentSummary(
    body({
      owner: { principal_type: "User", display_name: "Ross" },
      location: { kind: "machine", machine_name: "Mac Studio" },
      viewer_session: null,
      skills: [],
      tools: null,
      edit_url: "http://example.com/insecure",
      execution: {
        harness: "codex",
        model: "gpt",
        effort: "auto",
        pinned: false,
        resolved_model: null,
        resolved_effort: null,
        unavailable_reason: "no_subscription",
      },
    }),
    AGENT,
  );
  assert.deepEqual(
    agentSummaryRows(summary).map((row) => `${row.label}: ${row.value}`),
    [
      "About: Helps with email",
      "Runs on: Codex · gpt · auto",
      "For you: Connect your Codex subscription to talk to this agent.",
      "Where: Mac Studio",
      "Owner: Ross",
    ],
  );
  assert.equal(summary.editUrl, null, "only https edit links are offered");
  assert.equal(
    agentSummaryForYouLabel({ ...summary.execution, unavailableReason: null }),
    "Model details aren't available for you yet.",
  );
  assert.equal(
    agentSummaryRows(parseAgentSummary(body({ execution: null }), AGENT)).some(
      (row) => row.label === "Runs on" || row.label === "For you",
    ),
    false,
  );
});

test("bodies for another agent or contract are refused", () => {
  assert.equal(parseAgentSummary(body({ contract_version: 2 }), AGENT), null);
  assert.equal(parseAgentSummary(body(), "c".repeat(64)), null);
  assert.equal(parseAgentSummary(body({ agent: { name: " " } }), AGENT), null);
  assert.equal(parseAgentSummary(null, AGENT), null);
});

test("cached two minutes per agent, failures included; a community switch clears it", async () => {
  const calls = [];
  let clock = 1_000;
  let fail = false;
  restore = setAgentSummaryLookupForTests({
    lookup: async (key) => {
      calls.push(key);
      if (fail) throw new Error("timeout");
      return body();
    },
    now: () => clock,
  });
  await ensureAgentSummary(AGENT);
  assert.equal(cachedAgentSummary(AGENT)?.name, "Assistant");
  clock += AGENT_SUMMARY_TTL_MS - 1;
  await ensureAgentSummary(AGENT);
  assert.equal(calls.length, 1);
  clock += 1;
  fail = true;
  await ensureAgentSummary(AGENT);
  assert.equal(cachedAgentSummary(AGENT), null, "a failure hides the section");
  await ensureAgentSummary(AGENT);
  assert.equal(calls.length, 2, "and is not retried at once");
  fail = false;
  resetAgentSummaryCache();
  await ensureAgentSummary(AGENT);
  assert.equal(calls.length, 3);
  assert.equal(cachedAgentSummary(AGENT)?.name, "Assistant");
});

test("the section belongs to agents the viewer has a 1:1 DM with", () => {
  const dm = (participantPubkeys, channelType = "dm") => ({
    channelType,
    participantPubkeys,
  });
  assert.equal(hasAgentDm([dm([SELF, AGENT])], SELF, AGENT), true);
  assert.equal(
    hasAgentDm([dm([SELF, AGENT, "c".repeat(64)])], SELF, AGENT),
    false,
  );
  assert.equal(hasAgentDm([dm([SELF, AGENT], "stream")], SELF, AGENT), false);
  assert.equal(hasAgentDm([dm([SELF, AGENT])], undefined, AGENT), false);
});

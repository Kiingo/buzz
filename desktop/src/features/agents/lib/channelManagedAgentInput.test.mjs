import assert from "node:assert/strict";
import test from "node:test";

import { buildChannelManagedAgentCreateInput } from "./channelManagedAgentInput.ts";

test("provider-owned channel placement needs no desktop runtime", async () => {
  const input = await buildChannelManagedAgentCreateInput({
    name: "Ada",
    personaId: "persona-ada",
    teamId: "team-executive",
    systemPrompt: "Lead learning.",
    model: "must-not-leak-to-provider-owned-placement",
    backend: {
      type: "provider",
      id: "kiingo",
      config: { harness: "claude", model: "sonnet", reasoning: "high" },
    },
  });

  assert.equal(input.agentCommand, undefined);
  assert.equal(input.acpCommand, undefined);
  assert.equal(input.mcpCommand, undefined);
  assert.equal(input.model, undefined);
  assert.equal(input.provider, undefined);
  assert.equal(input.startOnAppLaunch, false);
  assert.equal(input.spawnAfterCreate, true);
  assert.equal(input.teamId, "team-executive");
  assert.deepEqual(input.backend, {
    type: "provider",
    id: "kiingo",
    config: { harness: "claude", model: "sonnet", reasoning: "high" },
  });
});

test("local channel placement refuses to invent a runtime", async () => {
  await assert.rejects(
    buildChannelManagedAgentCreateInput({
      name: "Ada",
      backend: { type: "local" },
    }),
    /Choose where this agent runs, or install a local agent runtime/,
  );
});

test("local channel placement preserves the ACP projection", async () => {
  const input = await buildChannelManagedAgentCreateInput({
    name: "Ada",
    runtime: {
      id: "codex",
      label: "Codex",
      command: "codex-acp",
      defaultArgs: ["ignored"],
      mcpCommand: "buzz-mcp",
    },
    systemPrompt: "Lead learning.",
    model: "gpt-5.6",
    backend: { type: "local" },
  });

  assert.equal(input.agentCommand, "codex-acp");
  assert.equal(input.mcpCommand, "buzz-mcp");
  assert.deepEqual(input.agentArgs, []);
  assert.equal(input.model, "gpt-5.6");
  assert.deepEqual(input.backend, { type: "local" });
});

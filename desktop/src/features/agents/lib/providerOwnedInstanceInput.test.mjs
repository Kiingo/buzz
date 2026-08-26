import assert from "node:assert/strict";
import test from "node:test";

import { buildProviderOwnedInstanceInput } from "./providerOwnedInstanceInput.ts";

test("provider-owned creation needs no installed desktop runtime", async () => {
  const input = await buildProviderOwnedInstanceInput(
    {
      id: "p-1",
      displayName: "Remote Agent",
      systemPrompt: "prompt",
      model: null,
      runtime: null,
      avatarUrl: "https://example.com/a.png",
      envVars: {},
      isBuiltIn: false,
    },
    {
      type: "provider",
      id: "remote-execution",
      config: { harness: "codex", model: "gpt-5.6", reasoning: "high" },
    },
  );
  assert.equal(input.agentCommand, undefined);
  assert.equal(input.model, undefined);
  assert.equal(input.provider, undefined);
  assert.deepEqual(input.backend, {
    type: "provider",
    id: "remote-execution",
    config: { harness: "codex", model: "gpt-5.6", reasoning: "high" },
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentDefinitionSubmitPayload } from "./providerOwnedDefinitionSubmitPayload.ts";

test("provider-owned definition strips desktop execution state", () => {
  assert.deepEqual(
    buildAgentDefinitionSubmitPayload({
      acpCommand: "buzz-janet-acp",
      avatarUrl: " https://example.com/agent.png ",
      behavior: { respondTo: "owner-only" },
      description: "Public blurb",
      displayName: " Remote Agent ",
      envVars: { LOCAL_SECRET: "fixture" },
      execution: {
        runtime: "buzz-agent",
        model: "auto",
        provider: "relay-mesh",
        isEditMode: false,
        isAutoSeeded: false,
        initialPreviousRuntime: "",
        initialModel: null,
        initialProvider: null,
        initialModelProviderEditableWithoutRuntime: false,
      },
      namePoolText: "Birch, Compass",
      preserveEmptyNamePool: false,
      providerOwnsExecutionProfile: true,
      systemPrompt: "Preserve this prompt.",
    }),
    {
      acpCommand: undefined,
      avatarUrl: "https://example.com/agent.png",
      behavior: { respondTo: "owner-only" },
      description: "Public blurb",
      displayName: "Remote Agent",
      envVars: {},
      model: undefined,
      namePool: ["Birch", "Compass"],
      provider: undefined,
      runtime: undefined,
      systemPrompt: "Preserve this prompt.",
    },
  );
});

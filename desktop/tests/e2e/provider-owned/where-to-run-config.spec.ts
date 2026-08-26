/** Provider-owned create flow: no desktop runtime/defaults are required. */
import { expect, test } from "@playwright/test";

import { installMockBridge } from "../../helpers/bridge";

type Page = import("@playwright/test").Page;
type CreateCommand = {
  command: string;
  payload: { input?: Record<string, unknown> };
};

const PROVIDER = {
  id: "remote-execution",
  binaryPath: "/mock/buzz-backend-remote-execution",
};

const PROBE_RESULT = {
  ok: true,
  name: "remote-execution",
  version: "0.0.0-mock",
  config_schema: {
    type: "object",
    "x-buzz-owns-execution-profile": true,
    properties: {
      harness: {
        type: "string",
        title: "Agent harness",
        enum: ["codex", "claude"],
        "x-enum-labels": { codex: "Codex", claude: "Claude Code" },
        default: "codex",
      },
      model: {
        type: "string",
        title: "Model",
        enum: ["gpt-5.6", "claude-opus-4-6"],
        "x-enum-labels": {
          "gpt-5.6": "GPT-5.6",
          "claude-opus-4-6": "Claude Opus 4.6",
        },
        default: "gpt-5.6",
      },
      reasoning: {
        type: "string",
        title: "Reasoning effort",
        enum: ["medium", "high"],
        default: "medium",
      },
    },
    required: ["harness", "model", "reasoning"],
  },
};

async function openProviderCreate(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-agents-view").click();
  await page.getByTestId("new-agent-card").click();
  const dialog = page.getByTestId("persona-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole("button", { name: "Advanced", exact: true }).click();
  const runOn = dialog.locator("#agent-run-on");
  await runOn.press("Enter");
  await page
    .getByRole("menuitemradio", { name: PROVIDER.id, exact: true })
    .press("Enter");
  return dialog;
}

async function createCommands(page: Page): Promise<CreateCommand[]> {
  return page.evaluate(
    () =>
      (window as Window & { __BUZZ_E2E_COMMAND_LOG__?: CreateCommand[] })
        .__BUZZ_E2E_COMMAND_LOG__ ?? [],
  );
}

async function chooseProviderOption(
  page: Page,
  trigger: import("@playwright/test").Locator,
  label: string,
) {
  await trigger.press("Enter");
  const option = page.getByRole("menuitemradio", { name: label, exact: true });
  await expect(option).toBeVisible();
  await option.press("Enter");
  await expect(trigger).toContainText(label);
}

for (const profile of [
  {
    harness: "Codex",
    model: "GPT-5.6",
    expected: { harness: "codex", model: "gpt-5.6", reasoning: "medium" },
  },
  {
    harness: "Claude Code",
    model: "Claude Opus 4.6",
    expected: {
      harness: "claude",
      model: "claude-opus-4-6",
      reasoning: "high",
    },
  },
]) {
  test(`provider-owned ${profile.harness} profile creates without local defaults`, async ({
    page,
  }) => {
    await installMockBridge(page, {
      backendProviders: [PROVIDER],
      backendProviderProbeResult: PROBE_RESULT,
      globalAgentConfig: {
        env_vars: {},
        model: null,
        preferred_runtime: null,
        provider: null,
      },
    });
    const dialog = await openProviderCreate(page);
    await expect(dialog.locator("#provider-cfg-harness")).toBeVisible();
    await expect(dialog.locator("#persona-runtime")).toHaveCount(0);
    await expect(dialog.locator("#persona-llm-provider")).toHaveCount(0);
    await expect(dialog.getByText("Global defaults not set")).toHaveCount(0);

    if (profile.harness === "Claude Code") {
      await chooseProviderOption(
        page,
        dialog.locator("#provider-cfg-harness"),
        profile.harness,
      );
      await chooseProviderOption(
        page,
        dialog.locator("#provider-cfg-model"),
        profile.model,
      );
      await chooseProviderOption(
        page,
        dialog.locator("#provider-cfg-reasoning"),
        "high",
      );
    }

    await dialog
      .locator("#persona-display-name")
      .fill(`${profile.harness} Remote`);
    await dialog
      .locator("#persona-system-prompt")
      .fill("Use only the provider-owned execution profile.");
    const submit = dialog.getByTestId("persona-dialog-submit");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect
      .poll(
        async () =>
          (await createCommands(page)).filter(
            (entry) => entry.command === "create_managed_agent",
          ).length,
      )
      .toBe(1);

    const commands = await createCommands(page);
    const definition = commands.find(
      (entry) => entry.command === "create_persona",
    )?.payload.input;
    const instance = commands.find(
      (entry) => entry.command === "create_managed_agent",
    )?.payload.input;
    const serializedDefinition = JSON.parse(JSON.stringify(definition));
    const serializedInstance = JSON.parse(JSON.stringify(instance));

    expect(serializedDefinition).toMatchObject({ envVars: {} });
    expect(serializedDefinition).not.toHaveProperty("runtime");
    expect(serializedDefinition).not.toHaveProperty("provider");
    expect(serializedDefinition).not.toHaveProperty("model");
    expect(serializedInstance).toMatchObject({
      backend: { type: "provider", id: PROVIDER.id, config: profile.expected },
    });
    expect(serializedInstance).not.toHaveProperty("agentCommand");
    expect(serializedInstance).not.toHaveProperty("provider");
    expect(serializedInstance).not.toHaveProperty("model");
  });
}

test("provider-owned create attaches to the requested channel", async ({
  page,
}) => {
  await installMockBridge(page, {
    backendProviders: [PROVIDER],
    backendProviderProbeResult: PROBE_RESULT,
    globalAgentConfig: {
      env_vars: {},
      model: null,
      preferred_runtime: null,
      provider: null,
    },
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("channel-random").click();
  await page.getByTestId("channel-intro-action-create-agent").click();
  await page.getByRole("button", { name: /Create a new agent/ }).click();
  const dialog = page.getByTestId("persona-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Advanced", exact: true }).click();
  await dialog.locator("#agent-run-on").press("Enter");
  await page
    .getByRole("menuitemradio", { name: PROVIDER.id, exact: true })
    .press("Enter");
  await expect(dialog.locator("#provider-cfg-harness")).toBeVisible();
  await dialog.locator("#persona-display-name").fill("Channel Remote");
  await dialog
    .locator("#persona-system-prompt")
    .fill("Use the provider-owned execution profile in this channel.");
  await dialog.getByTestId("persona-dialog-submit").click();

  await expect
    .poll(
      async () =>
        (await createCommands(page)).filter(
          (entry) => entry.command === "add_channel_members",
        ).length,
    )
    .toBe(1);
  const commands = await createCommands(page);
  const createIndex = commands.findIndex(
    (entry) => entry.command === "create_managed_agent",
  );
  const attachIndex = commands.findIndex(
    (entry) => entry.command === "add_channel_members",
  );
  expect(createIndex).toBeGreaterThanOrEqual(0);
  expect(attachIndex).toBeGreaterThan(createIndex);
  await expect(
    page.getByText("shared-compute agents cannot be deployed remotely"),
  ).toHaveCount(0);
});

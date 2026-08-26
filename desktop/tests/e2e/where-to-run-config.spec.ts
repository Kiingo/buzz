/**
 * E2E spec for the create-agent "Run on" provider config fields.
 *
 * Pins the fix for the "Typewriter Eraser": WhereToRunSection's probe effect
 * used to depend on the whole draft, so every keystroke re-probed the
 * provider and every probe resolution reset providerConfig to schema
 * defaults — typing into a defaultless field (the k8s "Kubeconfig context")
 * looked completely dead, and the provider binary respawned in a loop.
 *
 * Covers:
 *  - typing into a defaultless provider field sticks, and the provider is
 *    probed exactly once for the selection (not once per keystroke or
 *    Advanced disclosure toggle)
 *  - the config form is gated on probe resolution (no half-rendered form),
 *    and defaults prefill exactly once when a slow probe lands
 *  - collapsing Advanced during an incomplete remote setup keeps the submit
 *    blocker visible through the Required badge
 *  - switching provider → local → provider re-probes and resets cleanly
 *
 * The stale-closure merge on probe resolution (defaults beneath in-flight
 * typing) is unreachable through this UI because the fields render only
 * after the probe resolves; it is pinned at the unit level in
 * whereToRunIntent.test.mjs (applyProbeResult).
 */
import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

type Page = import("@playwright/test").Page;

const PROVIDER = {
  id: "kubernetes",
  binaryPath: "/mock/buzz-backend-kubernetes",
};

const EXECUTION_PROFILE_PROVIDER = {
  id: "remote-execution",
  binaryPath: "/mock/buzz-backend-remote-execution",
};

const PROBE_RESULT = {
  ok: true,
  name: "kubernetes",
  version: "0.0.0-mock",
  config_schema: {
    type: "object",
    properties: {
      context: {
        type: "string",
        title: "Kubeconfig context",
        description: "Context from your kubeconfig.",
      },
      namespace: {
        type: "string",
        title: "Namespace",
        default: "buzz-agents-mock01",
      },
    },
    required: ["namespace"],
  },
};

const EXECUTION_PROFILE_PROBE_RESULT = {
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
        "x-enum-labels": {
          codex: "Codex",
          claude: "Claude Code",
        },
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

async function probeInvocations(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        window as Window & { __BUZZ_E2E_COMMANDS__?: string[] }
      ).__BUZZ_E2E_COMMANDS__?.filter(
        (command) => command === "probe_backend_provider",
      ).length ?? 0,
  );
}

async function selectRunOnOption(
  page: Page,
  dialog: import("@playwright/test").Locator,
  optionName: string,
) {
  const trigger = dialog.locator("#agent-run-on");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.press("Enter");

  const option = page.getByRole("menuitemradio", {
    exact: true,
    name: optionName,
  });
  await expect(option).toBeVisible();
  // The shared PersonaDropdownField supports keyboard selection. Using it here
  // avoids racing the menu's open animation when this test changes locations
  // repeatedly.
  await option.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
}

/** Open Advanced in the create-agent dialog and select the mocked provider. */
async function openCreateDialogOnProvider(
  page: Page,
  providerId = PROVIDER.id,
) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-agents-view").click();
  await page.getByTestId("new-agent-card").click();
  const dialog = page.getByTestId("persona-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const advanced = dialog.getByRole("button", {
    name: "Advanced",
    exact: true,
  });
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await expect(dialog.locator("#agent-run-on")).toHaveCount(0);
  await advanced.click();
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  const respondTo = dialog.getByTestId("agent-respond-to");
  const runOn = dialog.locator("#agent-run-on");
  await expect(respondTo).toBeVisible();
  await expect(runOn).toBeVisible();
  expect(await respondTo.evaluate((element) => element.offsetTop)).toBeLessThan(
    await runOn.evaluate((element) => element.offsetTop),
  );
  await selectRunOnOption(page, dialog, providerId);
  return dialog;
}

type CreateCommand = {
  command: string;
  payload: { input?: Record<string, unknown> };
};

async function createCommands(page: Page): Promise<CreateCommand[]> {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __BUZZ_E2E_COMMAND_LOG__?: CreateCommand[];
        }
      ).__BUZZ_E2E_COMMAND_LOG__ ?? [],
  );
}

test("typing into a defaultless provider field sticks and probes only once", async ({
  page,
}) => {
  await installMockBridge(page, {
    backendProviders: [PROVIDER],
    backendProviderProbeResult: PROBE_RESULT,
  });
  const dialog = await openCreateDialogOnProvider(page);

  const contextField = dialog.locator("#provider-cfg-context");
  await expect(contextField).toBeVisible({ timeout: 10_000 });
  // Defaults prefilled from the schema; context has none.
  await expect(dialog.locator("#provider-cfg-namespace")).toHaveValue(
    "buzz-agents-mock01",
  );
  await expect(contextField).toHaveValue("");

  await contextField.fill("prod-us-west");
  await expect(contextField).toHaveValue("prod-us-west");

  // One selection, one probe — keystrokes and Advanced disclosure toggles
  // must not refire executable provider discovery after it has completed.
  expect(await probeInvocations(page)).toBe(1);
  const advanced = dialog.getByRole("button", {
    name: "Advanced",
    exact: true,
  });
  await advanced.click();
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await expect(dialog.locator("#agent-run-on")).toHaveCount(0);
  await advanced.click();
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.locator("#provider-cfg-context")).toHaveValue(
    "prod-us-west",
  );
  expect(await probeInvocations(page)).toBe(1);
});

test("config fields render only after a slow probe resolves, with defaults", async ({
  page,
}) => {
  // The fields are gated on the probe result (draft.probedProvider), which is
  // what makes mid-flight typing unreachable through the UI — the stale-probe
  // merge seam (applyProbeResult) is pinned at the unit level instead. This
  // spec holds the gate: no half-rendered form before the probe lands, and
  // defaults appear exactly once when it does.
  await installMockBridge(page, {
    backendProviders: [PROVIDER],
    backendProviderProbeResult: PROBE_RESULT,
    backendProviderProbeDelayMs: 1_000,
  });
  const dialog = await openCreateDialogOnProvider(page);

  // Pre-resolution: the security warning is up, the form is not.
  await expect(dialog.getByText("will receive your agent")).toBeVisible();
  await expect(dialog.locator("#provider-cfg-context")).toHaveCount(0);

  // Post-resolution: fields render with schema defaults prefilled.
  await expect(dialog.locator("#provider-cfg-context")).toBeVisible({
    timeout: 10_000,
  });
  await expect(dialog.locator("#provider-cfg-namespace")).toHaveValue(
    "buzz-agents-mock01",
  );
  expect(await probeInvocations(page)).toBe(1);
});

test("collapsed Advanced marks incomplete remote setup as required", async ({
  page,
}) => {
  await installMockBridge(page, {
    backendProviders: [PROVIDER],
    backendProviderProbeResult: PROBE_RESULT,
    backendProviderProbeDelayMs: 10_000,
  });
  const dialog = await openCreateDialogOnProvider(page);
  const advanced = dialog.getByRole("button", {
    name: "Advanced",
    exact: true,
  });
  const submit = dialog.getByTestId("persona-dialog-submit");

  await expect(submit).toBeDisabled();
  await advanced.click();
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await expect(dialog.locator("#agent-run-on")).toHaveCount(0);
  await expect(
    dialog.getByTestId("persona-advanced-required-badge"),
  ).toHaveText("Required");
  await expect(submit).toBeDisabled();
});

test("provider → local → provider re-probes and resets the config", async ({
  page,
}) => {
  await installMockBridge(page, {
    backendProviders: [PROVIDER],
    backendProviderProbeResult: PROBE_RESULT,
  });
  const dialog = await openCreateDialogOnProvider(page);

  const contextField = dialog.locator("#provider-cfg-context");
  await expect(contextField).toBeVisible({ timeout: 10_000 });
  await contextField.fill("stale-value");

  await selectRunOnOption(page, dialog, "This computer");
  await expect(contextField).toHaveCount(0);

  await selectRunOnOption(page, dialog, PROVIDER.id);
  await expect(dialog.locator("#provider-cfg-context")).toBeVisible({
    timeout: 10_000,
  });
  // Fresh selection = fresh draft: the stale value must not leak back.
  await expect(dialog.locator("#provider-cfg-context")).toHaveValue("");
  expect(await probeInvocations(page)).toBe(2);
});

for (const profile of [
  {
    harness: "Codex",
    model: "GPT-5.6",
    expected: {
      harness: "codex",
      model: "gpt-5.6",
      reasoning: "medium",
    },
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
      backendProviders: [EXECUTION_PROFILE_PROVIDER],
      backendProviderProbeResult: EXECUTION_PROFILE_PROBE_RESULT,
      globalAgentConfig: {
        env_vars: {},
        model: null,
        preferred_runtime: null,
        provider: null,
      },
    });
    const dialog = await openCreateDialogOnProvider(
      page,
      EXECUTION_PROFILE_PROVIDER.id,
    );

    await expect(dialog.locator("#provider-cfg-harness")).toBeVisible({
      timeout: 10_000,
    });
    await expect(dialog.locator("#persona-runtime")).toHaveCount(0);
    await expect(dialog.locator("#persona-llm-provider")).toHaveCount(0);
    await expect(dialog.getByText("Global defaults not set")).toHaveCount(0);

    if (profile.harness === "Claude Code") {
      const harness = dialog.locator("#provider-cfg-harness");
      await harness.press("Enter");
      await page
        .getByRole("menuitemradio", { name: profile.harness, exact: true })
        .press("Enter");
      const model = dialog.locator("#provider-cfg-model");
      await model.press("Enter");
      await page
        .getByRole("menuitemradio", { name: profile.model, exact: true })
        .press("Enter");
      const reasoning = dialog.locator("#provider-cfg-reasoning");
      await reasoning.press("Enter");
      await page
        .getByRole("menuitemradio", { name: "high", exact: true })
        .press("Enter");
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

    const serializedDefinition = JSON.parse(
      JSON.stringify(definition),
    ) as Record<string, unknown>;
    const serializedInstance = JSON.parse(JSON.stringify(instance)) as Record<
      string,
      unknown
    >;

    expect(serializedDefinition).toMatchObject({ envVars: {} });
    expect(serializedDefinition).not.toHaveProperty("runtime");
    expect(serializedDefinition).not.toHaveProperty("provider");
    expect(serializedDefinition).not.toHaveProperty("model");
    expect(serializedInstance).toMatchObject({
      backend: {
        type: "provider",
        id: EXECUTION_PROFILE_PROVIDER.id,
        config: profile.expected,
      },
      envVars: {},
    });
    expect(serializedInstance).not.toHaveProperty("agentCommand");
    expect(serializedInstance).not.toHaveProperty("agentArgs");
    expect(serializedInstance).not.toHaveProperty("provider");
    expect(serializedInstance).not.toHaveProperty("model");
  });
}

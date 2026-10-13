/**
 * Create flow in a build that names a preferred destination. Build with
 * `VITE_BUZZ_PREFERRED_RUN_ON=kiingo pnpm build:e2e` and run with the same
 * variable set; generic builds skip this file.
 */
import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../../helpers/animations";
import { installMockBridge } from "../../helpers/bridge";

type Page = import("@playwright/test").Page;
type CommandLogEntry = {
  command: string;
  payload: { input?: Record<string, unknown> };
};

const PREFERRED = process.env.VITE_BUZZ_PREFERRED_RUN_ON ?? "";
test.skip(
  PREFERRED !== "kiingo",
  "needs a build with VITE_BUZZ_PREFERRED_RUN_ON=kiingo",
);

const PROVIDER = {
  id: "kiingo",
  binaryPath: "/Applications/Buzz.app/Contents/MacOS/buzz-backend-kiingo",
};

const PROBE_RESULT = {
  ok: true,
  name: "Kiingo Compute",
  version: "0.3.5",
  protocol_version: 2,
  description: "Run agents on Kiingo Compute.",
  capabilities: { lifecycle_operations: ["delete", "preflight"] },
  config_schema: {
    type: "object",
    "x-buzz-owns-execution-profile": true,
    properties: {
      harness: {
        type: "string",
        title: "Harness",
        enum: ["codex", "claude-code"],
        "x-enum-labels": { codex: "Codex", "claude-code": "Claude Code" },
        default: "codex",
      },
      model_mode: {
        type: "string",
        title: "Model",
        enum: ["auto", "version"],
        "x-enum-labels": {
          auto: "Default for this harness",
          version: "Choose a model",
        },
        default: "auto",
      },
      model_selector: {
        type: "string",
        title: "Which model",
        default: "",
        "x-visible-when": { field: "model_mode", not: "auto" },
        "x-options-by-fields": {
          fields: ["harness", "model_mode"],
          options: {
            "codex|version": [{ label: "GPT-5.6", value: "gpt-5.6" }],
            "claude-code|version": [
              { label: "Claude Opus 4.6", value: "claude-opus-4-6" },
            ],
          },
        },
      },
      profile_revision: {
        type: "integer",
        readOnly: true,
        default: 1,
        "x-hidden": true,
      },
    },
    required: ["harness", "model_mode", "profile_revision"],
  },
};

const NOTICE =
  "People who message this agent use their own connected Codex or Claude Code subscription.";

function preflight(ready: boolean) {
  return ready
    ? {
        supported: true,
        ready: true,
        message: "Your Codex subscription is connected.",
        actionLabel: null,
        actionUrl: null,
        notice: NOTICE,
      }
    : {
        supported: true,
        ready: false,
        message: "Connect your Codex subscription to create this agent.",
        actionLabel: "Connect",
        actionUrl: "https://example.com/connections",
        notice: NOTICE,
      };
}

async function openCreate(page: Page, ready: boolean) {
  await installMockBridge(page, {
    backendProviders: [PROVIDER],
    backendProviderProbeResult: PROBE_RESULT,
    backendProviderPreflight: preflight(ready),
    globalAgentConfig: {
      env_vars: {},
      model: null,
      preferred_runtime: null,
      provider: null,
    },
  } as Parameters<typeof installMockBridge>[1]);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-agents-view").click();
  await page.getByTestId("new-agent-card").click();
  const dialog = page.getByTestId("persona-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

async function commandLog(page: Page): Promise<CommandLogEntry[]> {
  return page.evaluate(
    () =>
      (window as Window & { __BUZZ_E2E_COMMAND_LOG__?: CommandLogEntry[] })
        .__BUZZ_E2E_COMMAND_LOG__ ?? [],
  );
}

test("leads with Kiingo Compute and blocks Create until the subscription is connected", async ({
  page,
}) => {
  const dialog = await openCreate(page, false);
  // No Advanced click: where it runs is the first thing in the form.
  const runOn = dialog.locator("#agent-run-on");
  await expect(runOn).toBeVisible();
  await expect(runOn).toContainText("Kiingo Compute");
  await expect(dialog.getByText("Where it runs")).toBeVisible();
  await expect(dialog.getByTestId("agent-run-on-shipped-note")).toBeVisible();
  await expect(dialog.getByText(/will receive your agent/)).toHaveCount(0);
  await expect(dialog.locator("#provider-cfg-harness")).toContainText("Codex");
  await expect(dialog.locator("#provider-cfg-model_mode")).toContainText(
    "Default for this harness",
  );
  await expect(dialog.locator("#provider-cfg-model_selector")).toHaveCount(0);
  await expect(dialog.locator("#persona-display-name")).toHaveValue(
    "Assistant",
  );
  await expect(dialog.getByTestId("provider-preflight-blocked")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Connect" })).toBeVisible();
  await expect(dialog.getByTestId("provider-preflight-notice")).toHaveText(
    NOTICE,
  );
  await expect(dialog.getByTestId("persona-dialog-submit")).toBeDisabled();

  await waitForAnimations(page);
  await dialog.screenshot({
    path: "test-results/screenshots/preferred-run-on-01-connect-subscription.png",
  });
});

test("creates on Kiingo Compute with the harness default model once ready", async ({
  page,
}) => {
  const dialog = await openCreate(page, true);
  await expect(dialog.getByTestId("provider-preflight-ready")).toBeVisible();
  const submit = dialog.getByTestId("persona-dialog-submit");
  await expect(submit).toBeEnabled();

  await waitForAnimations(page);
  await dialog.screenshot({
    path: "test-results/screenshots/preferred-run-on-02-ready.png",
  });

  await submit.click();
  await expect
    .poll(
      async () =>
        (await commandLog(page)).filter(
          (entry) => entry.command === "create_managed_agent",
        ).length,
    )
    .toBe(1);
  const instance = (await commandLog(page)).find(
    (entry) => entry.command === "create_managed_agent",
  )?.payload.input;
  expect(JSON.parse(JSON.stringify(instance))).toMatchObject({
    name: "Assistant",
    backend: {
      type: "provider",
      id: "kiingo",
      config: { harness: "codex", model_mode: "auto", model_selector: "" },
    },
  });
});

test("This Mac stays one choice away and restores the local form", async ({
  page,
}) => {
  const dialog = await openCreate(page, true);
  const runOn = dialog.locator("#agent-run-on");
  await expect(runOn).toContainText("Kiingo Compute");
  await runOn.press("Enter");
  const local = page.getByRole("menuitemradio", {
    name: /^This (Mac|computer)$/,
  });
  await expect(local).toBeVisible();
  await expect(page.getByRole("menuitemradio")).toHaveCount(2);
  await local.press("Enter");
  await expect(runOn).toContainText(/This (Mac|computer)/);
  await expect(dialog.locator("#provider-cfg-harness")).toHaveCount(0);
  await expect(dialog.getByTestId("provider-preflight")).toHaveCount(0);
});

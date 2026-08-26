/** Provider-backed agents use the ordinary channel/mention start boundary. */
import { expect, test } from "@playwright/test";

import { installMockBridge } from "../../helpers/bridge";

const ADA_PUBKEY = "ad".repeat(32);
const ADA_BACKEND = {
  type: "provider" as const,
  id: "remote-execution",
  config: { harness: "codex", model: "gpt-5.6", reasoning: "high" },
};

async function readCommands(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      (window as Window & { __BUZZ_E2E_COMMANDS__?: string[] })
        .__BUZZ_E2E_COMMANDS__ ?? [],
  );
}

function count(commands: string[], command: string) {
  return commands.filter((entry) => entry === command).length;
}

test("channel mention starts a provider-backed agent", async ({ page }) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: ADA_PUBKEY,
        name: "Ada",
        status: "stopped",
        channelNames: ["general"],
        backend: ADA_BACKEND,
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  const input = page.getByTestId("message-input");
  await input.fill("Please help @ad");
  await expect(
    page
      .getByTestId("mention-autocomplete")
      .locator("button", { hasText: "Ada" }),
  ).toBeVisible();
  await input.press("Enter");
  const baseline = await readCommands(page);
  await page.getByTestId("send-message").click();

  await expect
    .poll(async () => count(await readCommands(page), "start_managed_agent"))
    .toBeGreaterThan(count(baseline, "start_managed_agent"));
  await expect(page.getByTestId("message-timeline")).toContainText(
    "Please help",
  );
});

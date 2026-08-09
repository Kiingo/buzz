import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("interactive EVENT publication is independent of query backoff", async () => {
  const sessionSource = await readFile(
    new URL("./relayClientSession.ts", import.meta.url),
    "utf8",
  );
  const publishStart = sessionSource.indexOf("  async publishEvent(");
  const handlerStart = sessionSource.indexOf(
    "  private async handleWsMessage(",
    publishStart,
  );

  assert.notEqual(publishStart, -1, "publishEvent method exists");
  assert.notEqual(handlerStart, -1, "publishEvent method boundary exists");

  const publishSource = sessionSource.slice(publishStart, handlerStart);
  assert.doesNotMatch(publishSource, /waitForRateLimit/);
  assert.match(publishSource, /this\.sendRaw\(\["EVENT", event\]\)/);
});

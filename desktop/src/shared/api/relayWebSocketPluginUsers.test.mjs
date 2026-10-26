import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The native `websocket` plugin is for relay connections only. It drops
 * inbound text frames that are not readable relay messages and re-serializes
 * verified `EVENT` frames (see `src-tauri/src/native_websocket_events.rs`).
 * A non-relay socket opened through it would silently lose frames, so its
 * renderer users are pinned here: a new one must be a relay client.
 */
const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const relayClients = [
  "shared/api/readOnlyRelayClient.ts",
  "shared/api/relayClientSession.ts",
];

// The e2e mock bridge answers the command itself; it never reaches Rust.
const mockBridge = "testing/e2eBridge.ts";

function sourceFiles() {
  return readdirSync(sourceRoot, { recursive: true })
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => /\.(ts|tsx|js|jsx|mjs)$/.test(file))
    .filter((file) => !/\.(test|jsdom-test)\.mjs$/.test(file));
}

test("only relay clients open sockets through the native websocket plugin", () => {
  const openers = sourceFiles()
    .filter((file) =>
      readFileSync(path.join(sourceRoot, file), "utf8").includes(
        "plugin:websocket|connect",
      ),
    )
    .sort();

  assert.deepEqual(openers, [...relayClients, mockBridge].sort());
});

test("nothing reaches the plugin through its JavaScript package", () => {
  const importers = sourceFiles().filter((file) =>
    readFileSync(path.join(sourceRoot, file), "utf8").includes(
      "@tauri-apps/plugin-websocket",
    ),
  );

  assert.deepEqual(importers, []);
});

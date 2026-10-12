import assert from "node:assert/strict";
import test from "node:test";

import { freshestDownloadedUpdate } from "./updaterFreshness.ts";

function handle(version, log) {
  return {
    version,
    download: async () => {
      log.push(`download ${version}`);
    },
    close: async () => {
      log.push(`close ${version}`);
    },
  };
}

test("a parked download superseded on the feed is replaced by the newest release", async () => {
  const log = [];
  const parked = handle("0.5.22-kiingo.6", log);
  const latest = handle("0.5.22-kiingo.8", log);
  const downloading = [];
  const result = await freshestDownloadedUpdate(parked, {
    check: async () => latest,
    onDownloading: (version) => downloading.push(version),
  });
  assert.equal(result, latest);
  assert.deepEqual(downloading, ["0.5.22-kiingo.8"]);
  // The newer release is downloaded before the stale handle is released.
  assert.deepEqual(log, ["download 0.5.22-kiingo.8", "close 0.5.22-kiingo.6"]);
});

test("the parked download is kept when the feed still serves it", async () => {
  const log = [];
  const parked = handle("0.5.22-kiingo.8", log);
  const result = await freshestDownloadedUpdate(parked, {
    check: async () => handle("0.5.22-kiingo.8", log),
  });
  assert.equal(result, parked);
  assert.deepEqual(log, ["close 0.5.22-kiingo.8"]);
});

test("an unreachable feed or no newer release installs the parked download", async () => {
  const log = [];
  const parked = handle("0.5.22-kiingo.6", log);
  assert.equal(
    await freshestDownloadedUpdate(parked, {
      check: async () => {
        throw new Error("network down");
      },
    }),
    parked,
  );
  assert.equal(
    await freshestDownloadedUpdate(parked, { check: async () => null }),
    parked,
  );
  assert.deepEqual(log, []);
});

test("a failed download of the newer release surfaces and keeps the parked handle open", async () => {
  const log = [];
  const parked = handle("0.5.22-kiingo.6", log);
  const latest = {
    ...handle("0.5.22-kiingo.8", log),
    download: async () => {
      throw new Error("download failed");
    },
  };
  await assert.rejects(
    freshestDownloadedUpdate(parked, { check: async () => latest }),
    /download failed/,
  );
  assert.deepEqual(log, []);
});

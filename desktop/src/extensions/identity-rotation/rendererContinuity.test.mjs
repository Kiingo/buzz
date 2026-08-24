import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { migrateIdentityRotationRendererContinuity } from "./rendererContinuity.ts";

const oldKey = "a".repeat(64);
const newKey = "b".repeat(64);
const unrelatedKey = "c".repeat(64);
const relay = "wss://chat.example.com";
const status = {
  contractVersion: 1,
  rotationId: "20000000-0000-4000-8000-000000000001",
  oldOwnerPublicKey: oldKey,
  newOwnerPublicKey: newKey,
};

class MemoryStorage {
  values = new Map();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  key(index) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key) {
    this.values.delete(key);
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

function seededStorage() {
  const storage = new MemoryStorage();
  storage.setItem(`buzz-machine-onboarding-complete.v2:${oldKey}`, "true");
  storage.setItem(`buzz-onboarding-complete.v1:${oldKey}`, "true");
  storage.setItem(
    `buzz-community-onboarding-complete.v1:${encodeURIComponent(relay)}:${oldKey}`,
    "true",
  );
  storage.setItem(
    "buzz-communities",
    JSON.stringify([
      {
        id: "active",
        name: "Kiingo",
        relayUrl: relay,
        token: "preserve-without-reading",
        pubkey: oldKey,
        addedAt: "2026-08-01T00:00:00Z",
      },
      {
        id: "other",
        name: "Other",
        relayUrl: "wss://other.example.com",
        pubkey: unrelatedKey,
        addedAt: "2026-08-01T00:00:00Z",
      },
    ]),
  );
  storage.setItem("buzz-active-community-id", "active");
  storage.setItem(
    "buzz-community-onboarding-transaction.v1",
    JSON.stringify({ pubkey: oldKey, stage: "profile" }),
  );
  storage.setItem(`buzz-thread-follows.v1:${oldKey}`, '["do-not-copy"]');
  return storage;
}

test("migrates exact onboarding and community identity continuity only", () => {
  const storage = seededStorage();
  const transaction = storage.getItem(
    "buzz-community-onboarding-transaction.v1",
  );
  const result = migrateIdentityRotationRendererContinuity(status, storage);

  assert.deepEqual(result, {
    eligible: true,
    migratedCompletionCount: 3,
    migratedCommunityCount: 1,
  });
  assert.equal(
    storage.getItem(`buzz-machine-onboarding-complete.v2:${newKey}`),
    "true",
  );
  assert.equal(
    storage.getItem(`buzz-onboarding-complete.v1:${newKey}`),
    "true",
  );
  assert.equal(
    storage.getItem(
      `buzz-community-onboarding-complete.v1:${encodeURIComponent(relay)}:${newKey}`,
    ),
    "true",
  );
  const communities = JSON.parse(storage.getItem("buzz-communities"));
  assert.equal(communities[0].pubkey, newKey);
  assert.equal(communities[0].token, "preserve-without-reading");
  assert.equal(communities[1].pubkey, unrelatedKey);
  assert.equal(storage.getItem("buzz-active-community-id"), "active");
  assert.equal(
    storage.getItem("buzz-community-onboarding-transaction.v1"),
    transaction,
  );
  assert.equal(storage.getItem(`buzz-thread-follows.v1:${newKey}`), null);
});

test("is idempotent and never invents completion from an absent source", () => {
  const storage = seededStorage();
  migrateIdentityRotationRendererContinuity(status, storage);
  const snapshot = JSON.stringify([...storage.values]);
  const second = migrateIdentityRotationRendererContinuity(status, storage);
  assert.deepEqual(second, {
    eligible: true,
    migratedCompletionCount: 0,
    migratedCommunityCount: 0,
  });
  assert.equal(JSON.stringify([...storage.values]), snapshot);

  const blank = new MemoryStorage();
  const blankResult = migrateIdentityRotationRendererContinuity(status, blank);
  assert.equal(blankResult.migratedCompletionCount, 0);
  assert.equal(blank.length, 0);
});

test("rejects invalid or no-op identity projections without touching storage", () => {
  for (const invalid of [
    { ...status, contractVersion: 2 },
    { ...status, oldOwnerPublicKey: "not-a-public-key" },
    { ...status, newOwnerPublicKey: oldKey },
  ]) {
    const storage = seededStorage();
    const before = JSON.stringify([...storage.values]);
    assert.equal(
      migrateIdentityRotationRendererContinuity(invalid, storage).eligible,
      false,
    );
    assert.equal(JSON.stringify([...storage.values]), before);
  }
});

test("bootstrap awaits continuity before providers and onboarding gates render", async () => {
  const source = await readFile(
    new URL("../../main.tsx", import.meta.url),
    "utf8",
  );
  const migration = source.indexOf(
    "await migrateIdentityRotationRendererContinuityBeforeRender()",
  );
  assert.ok(migration > source.indexOf("async function bootstrap()"));
  assert.ok(migration < source.indexOf("renderApp();"));
});

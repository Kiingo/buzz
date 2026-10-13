import assert from "node:assert/strict";
import test from "node:test";

import {
  idlePreflight,
  preflightAllowsSubmit,
  preflightKey,
  providerAdvertisesPreflight,
} from "./providerPreflightState.ts";

const ready = {
  supported: true,
  ready: true,
  message: null,
  actionLabel: null,
  actionUrl: null,
  notice: null,
};
const blocked = {
  ...ready,
  ready: false,
  message: "Connect your subscription.",
};

test("preflight is used only when the probe advertises it", () => {
  assert.equal(
    providerAdvertisesPreflight({
      capabilities: { lifecycle_operations: ["delete", "preflight"] },
    }),
    true,
  );
  for (const probe of [
    null,
    {},
    { capabilities: null },
    { capabilities: { lifecycle_operations: ["delete"] } },
    { capabilities: { lifecycle_operations: "preflight" } },
  ]) {
    assert.equal(providerAdvertisesPreflight(probe), false);
  }
});

test("the check key ignores key order but not values", () => {
  assert.equal(
    preflightKey("p", { harness: "codex", model_mode: "auto" }),
    preflightKey("p", { model_mode: "auto", harness: "codex" }),
  );
  assert.notEqual(
    preflightKey("p", { harness: "codex" }),
    preflightKey("p", { harness: "claude-code" }),
  );
});

test("providers without preflight never block create", () => {
  assert.equal(
    preflightAllowsSubmit({
      advertised: false,
      currentKey: "k",
      state: idlePreflight,
    }),
    true,
  );
});

test("create waits for a ready check of the current configuration", () => {
  const allows = (state, currentKey = "k") =>
    preflightAllowsSubmit({ advertised: true, currentKey, state });
  assert.equal(allows(idlePreflight), false);
  assert.equal(allows({ status: "checking", key: "k" }), false);
  assert.equal(
    allows({ status: "error", key: "k", message: "offline" }),
    false,
  );
  assert.equal(allows({ status: "done", key: "k", result: blocked }), false);
  assert.equal(allows({ status: "done", key: "k", result: ready }), true);
  // A ready answer for a different harness does not count.
  assert.equal(allows({ status: "done", key: "old", result: ready }), false);
  // A provider that answered "unsupported" does not block.
  assert.equal(
    allows({
      status: "done",
      key: "k",
      result: { ...blocked, supported: false },
    }),
    true,
  );
});

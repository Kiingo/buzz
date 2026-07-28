import assert from "node:assert/strict";
import test from "node:test";

import { nextInstallOutputLine } from "./useInstallOutputLine.ts";

function event(runtimeId, attempt, line) {
  return { runtime_id: runtimeId, attempt, line };
}

test("nextInstallOutputLine: adopts the first line for the watched runtime", () => {
  assert.deepEqual(
    nextInstallOutputLine(null, event("goose", 1, "downloading"), "goose"),
    { attempt: 1, line: "downloading" },
  );
});

test("nextInstallOutputLine: replaces the line within the same attempt", () => {
  const current = { attempt: 1, line: "downloading" };

  assert.deepEqual(
    nextInstallOutputLine(current, event("goose", 1, "unpacking"), "goose"),
    { attempt: 1, line: "unpacking" },
  );
});

test("nextInstallOutputLine: ignores a line from another runtime", () => {
  const current = { attempt: 1, line: "downloading" };

  assert.equal(
    nextInstallOutputLine(current, event("codex", 1, "other work"), "goose"),
    current,
  );
});

test("nextInstallOutputLine: ignores a line from a superseded attempt", () => {
  const current = { attempt: 2, line: "retrying" };

  assert.equal(
    nextInstallOutputLine(current, event("goose", 1, "stale line"), "goose"),
    current,
  );
});

test("nextInstallOutputLine: adopts the first line of a new attempt", () => {
  const current = { attempt: 1, line: "download failed" };

  assert.deepEqual(
    nextInstallOutputLine(current, event("goose", 2, "downloading"), "goose"),
    { attempt: 2, line: "downloading" },
  );
});

test("nextInstallOutputLine: a first event from a later attempt is adopted", () => {
  assert.deepEqual(
    nextInstallOutputLine(null, event("goose", 3, "downloading"), "goose"),
    { attempt: 3, line: "downloading" },
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  findPreferredProvider,
  isBundledProviderPath,
  localRunOnLabel,
  normalizePreferredRunOn,
  providerRunOnLabel,
  runOnOptions,
} from "./preferredRunOn.ts";

const bundled = {
  id: "example",
  binaryPath: "/Applications/Buzz.app/Contents/MacOS/buzz-backend-example",
};
const other = {
  id: "kubernetes",
  binaryPath: "/usr/local/bin/buzz-backend-kubernetes",
};

test("only id-shaped build settings name a preferred destination", () => {
  assert.equal(normalizePreferredRunOn(" Example "), "example");
  assert.equal(normalizePreferredRunOn(""), null);
  assert.equal(normalizePreferredRunOn(undefined), null);
  assert.equal(normalizePreferredRunOn("../evil"), null);
  assert.equal(normalizePreferredRunOn("a b"), null);
});

test("the preferred provider must actually be discovered", () => {
  assert.equal(findPreferredProvider([other, bundled], "example"), bundled);
  assert.equal(findPreferredProvider([other], "example"), null);
  assert.equal(findPreferredProvider([other, bundled], null), null);
});

test("only a provider inside an app bundle counts as shipped with the app", () => {
  assert.equal(isBundledProviderPath(bundled.binaryPath, "example"), true);
  assert.equal(
    isBundledProviderPath(
      "/Users/me/.local/bin/buzz-backend-example",
      "example",
    ),
    false,
  );
  assert.equal(
    isBundledProviderPath(
      bundled.binaryPath.replace("example", "other"),
      "example",
    ),
    false,
  );
});

test("labels are human: platform name locally, probed name remotely", () => {
  assert.equal(localRunOnLabel(true), "This Mac");
  assert.equal(localRunOnLabel(false), "This computer");
  assert.equal(
    providerRunOnLabel("example", { ok: true, name: "Example Compute" }),
    "Example Compute",
  );
  assert.equal(
    providerRunOnLabel("remote-execution", null),
    "Remote Execution",
  );
});

test("a preferred destination offers exactly itself and this computer", () => {
  assert.deepEqual(
    runOnOptions({
      providers: [other, bundled],
      preferred: bundled,
      preferredProbe: { ok: true, name: "Example Compute" },
      isMac: true,
    }),
    [
      { label: "Example Compute", value: "example" },
      { label: "This Mac", value: "local" },
    ],
  );
});

test("without a preferred destination the generic list is unchanged", () => {
  assert.deepEqual(
    runOnOptions({
      providers: [other],
      preferred: null,
      preferredProbe: null,
      isMac: true,
    }),
    [
      { label: "This computer", value: "local" },
      { label: "kubernetes", value: "kubernetes" },
    ],
  );
});

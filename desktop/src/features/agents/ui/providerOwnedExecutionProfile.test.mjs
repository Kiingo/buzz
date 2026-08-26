import assert from "node:assert/strict";
import test from "node:test";

import { emptyWhereToRunDraft } from "./whereToRunIntent.ts";
import { providerOwnsExecutionProfile } from "./providerOwnedExecutionProfile.ts";

const owning = {
  ...emptyWhereToRunDraft,
  runOn: "remote-execution",
  probedProvider: {
    ok: true,
    config_schema: { "x-buzz-owns-execution-profile": true },
  },
};

test("only a literal remote-provider capability owns execution", () => {
  assert.equal(providerOwnsExecutionProfile(owning), true);
  for (const marker of [false, "true", 1, null, undefined]) {
    assert.equal(
      providerOwnsExecutionProfile({
        ...owning,
        probedProvider: {
          ok: true,
          config_schema: { "x-buzz-owns-execution-profile": marker },
        },
      }),
      false,
    );
  }
  assert.equal(
    providerOwnsExecutionProfile({ ...owning, runOn: "local" }),
    false,
  );
});

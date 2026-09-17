import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldRefreshOwnerSessionAfterRotation } from "./shouldRefreshOwnerSessionAfterRotation.ts";

test("refreshes only after a completed owner identity rotation", () => {
  assert.equal(shouldRefreshOwnerSessionAfterRotation(true, "human"), true);
  assert.equal(shouldRefreshOwnerSessionAfterRotation(true, "all"), true);
  assert.equal(shouldRefreshOwnerSessionAfterRotation(true, "agent"), false);
  assert.equal(shouldRefreshOwnerSessionAfterRotation(false, "human"), false);
  assert.equal(shouldRefreshOwnerSessionAfterRotation(false, "all"), false);
  assert.equal(shouldRefreshOwnerSessionAfterRotation(true, null), false);
});

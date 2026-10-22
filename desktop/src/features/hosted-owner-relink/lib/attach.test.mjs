import assert from "node:assert/strict";
import test from "node:test";

import {
  attachChoices,
  currentAttachChoice,
  describeAttachFailure,
} from "./attach.ts";

const scout = {
  kiingoAgentId: "0a1b2c3d-0000-4000-8000-00000000abcd",
  displayName: "Scout",
  ownerPrincipalType: "User",
};
const helper = {
  kiingoAgentId: "0a1b2c3d-0000-4000-8000-00000000abce",
  displayName: "Mail Helper",
  ownerPrincipalType: "Organization",
};

test("choices keep the provider's order, once each, named only", () => {
  assert.deepEqual(
    attachChoices([
      scout,
      { ...helper, displayName: "  " },
      helper,
      { ...scout, displayName: "Scout again" },
    ]),
    [scout, helper],
  );
});

test("a choice no longer on offer falls back to a new agent", () => {
  assert.equal(
    currentAttachChoice(scout.kiingoAgentId, [scout]),
    scout.kiingoAgentId,
  );
  assert.equal(currentAttachChoice(scout.kiingoAgentId, [helper]), null);
  assert.equal(currentAttachChoice(null, [scout]), null);
  assert.equal(currentAttachChoice(undefined, [scout]), null);
});

test("attach failures become plain words; other failures pass through", () => {
  for (const code of [
    "buzz_hosted_already_has_buzz_identity",
    "already_has_buzz_identity",
    "buzz_hosted_not_agent_owner",
    "buzz_hosted_agent_spec_required",
    "kiingo_agent_id_invalid",
  ]) {
    const text = describeAttachFailure(`The service said no. (${code})`);
    assert.ok(text, code);
    assert.doesNotMatch(text, /_/, `${code}: no codes in the words`);
  }
  assert.match(
    describeAttachFailure("(buzz_hosted_already_has_buzz_identity)"),
    /already on Buzz/,
  );
  assert.equal(
    describeAttachFailure(
      "Kiingo Compute could not start. (provisioning_failed)",
    ),
    null,
  );
});

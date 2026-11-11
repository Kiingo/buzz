import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeOutsideAppCards,
  isOutsideCardsCursor,
} from "./outsideAppCards.ts";

const card = {
  surfaceId: "0192a6b0-0000-7000-8000-0000000000ac",
  conversationId: "0192a6b0-0000-7000-8000-0000000000ad",
  revision: 3,
  title: "Launch readiness",
  conversationTitle: "From Claude",
  appName: "Claude",
};
test("outside card metadata preserves the conversation and exact opaque cursor", () => {
  const nextBefore = "v1.ABCdef0123456789_-ABCdef01234567";
  assert.deepEqual(decodeOutsideAppCards({ surfaces: [card], nextBefore }), {
    surfaces: [card],
    nextBefore,
  });
  assert.equal(isOutsideCardsCursor("../surfaces"), false);
});
test("malformed or unbounded card pages never become native card reads", () => {
  for (const value of [
    null,
    {},
    { surfaces: [card], nextBefore: "../surfaces" },
    { surfaces: Array(51).fill(card), nextBefore: null },
    ...[
      { revision: 0 },
      { surfaceId: "../calls" },
      { conversationId: "other" },
      { appName: null },
    ].map((change) => ({
      surfaces: [{ ...card, ...change }],
      nextBefore: null,
    })),
  ]) {
    assert.throws(() => decodeOutsideAppCards(value));
  }
});

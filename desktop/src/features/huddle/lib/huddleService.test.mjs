import assert from "node:assert/strict";
import test from "node:test";

import {
  isHuddleServiceNotice,
  parseHuddleServicePubkeys,
} from "./huddleService.ts";

const SERVICE = "ab".repeat(32);
const PERSON = "cd".repeat(32);

test("parseHuddleServicePubkeys keeps well-formed hex keys only", () => {
  const keys = parseHuddleServicePubkeys({
    huddle_service_pubkeys: [SERVICE.toUpperCase(), "short", 7, null],
  });
  assert.deepEqual([...keys], [SERVICE]);
  assert.equal(parseHuddleServicePubkeys({}).size, 0);
  assert.equal(parseHuddleServicePubkeys(null).size, 0);
  assert.equal(
    parseHuddleServicePubkeys({ huddle_service_pubkeys: "x" }).size,
    0,
  );
});

test("isHuddleServiceNotice matches only a service's huddle start", () => {
  const services = new Set([SERVICE]);
  assert.equal(
    isHuddleServiceNotice({ kind: 48100, pubkey: SERVICE }, services),
    true,
  );
  assert.equal(
    isHuddleServiceNotice({ kind: 48100, pubkey: PERSON }, services),
    false,
  );
  assert.equal(
    isHuddleServiceNotice({ kind: 9, pubkey: SERVICE }, services),
    false,
  );
  assert.equal(
    isHuddleServiceNotice(
      { kind: 48100, pubkey: PERSON, signerPubkey: SERVICE },
      services,
    ),
    true,
    "the signer decides, not a delegated author",
  );
});

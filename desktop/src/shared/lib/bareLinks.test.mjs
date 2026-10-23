import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FILE_EXTENSION_TLDS,
  findBareLinks,
  peelTrailing,
} from "./bareLinks.ts";

// Shared with mobile (bare_links_test.dart): both platforms must detect the
// same links for every case in this table. See docs/bare-links.md.
const TABLE = JSON.parse(
  readFileSync(
    new URL("../../../../test-fixtures/bare-links.json", import.meta.url),
    "utf8",
  ),
);

test("file-extension TLDs match the shared table", () => {
  assert.deepEqual(
    [...FILE_EXTENSION_TLDS].sort(),
    [...TABLE.fileExtensionTlds].sort(),
  );
});

for (const testCase of TABLE.cases) {
  test(`findBareLinks: ${testCase.name}`, () => {
    const found = findBareLinks(testCase.input).map(({ text, href, kind }) => ({
      text,
      href,
      kind,
    }));
    assert.deepEqual(found, testCase.links);
    for (const link of findBareLinks(testCase.input)) {
      assert.equal(testCase.input.slice(link.start, link.end), link.text);
    }
  });
}

test("peelTrailing keeps balanced brackets and drops the rest", () => {
  assert.equal(peelTrailing("example.com/a_(b)"), "example.com/a_(b)");
  assert.equal(peelTrailing("example.com/a_(b))"), "example.com/a_(b)");
  assert.equal(peelTrailing("example.com/a]."), "example.com/a");
  assert.equal(peelTrailing("example.com?!"), "example.com");
});

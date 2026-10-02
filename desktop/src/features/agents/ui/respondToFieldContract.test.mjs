import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const respondToFieldSource = await readFile(
  new URL("./RespondToField.tsx", import.meta.url),
  "utf8",
);

/**
 * Copy assertions run against this rather than the raw source: JSX text wraps
 * wherever the formatter decides, and a sentence split across lines should not
 * fail a copy test.
 */
const collapsedSource = respondToFieldSource.replace(/\s+/g, " ");

for (const label of ["Only me (default)", "Selected people", "Anyone"]) {
  test(`respond-to control uses the plain-language label: ${label}`, () => {
    assert.ok(respondToFieldSource.includes(`label: "${label}"`));
  });
}

test("native and persona controls share one option list", () => {
  assert.match(
    respondToFieldSource,
    /<select[\s\S]*RESPOND_TO_OPTIONS\.map\(\(option\) => \([\s\S]*<option/,
  );
});

test("every shared-access mode renders a persistent warning", () => {
  // Anyone and Selected people both hand host access to someone other than the
  // owner, so both warn; only the audience phrase differs.
  assert.match(respondToFieldSource, /mode === "anyone" \? accessWarning/);
  assert.match(respondToFieldSource, /mode === "allowlist" \? accessWarning/);
});

test("the Selected people warning sits after the people picker", () => {
  // It must not sit between the user and the selection they came here to make.
  const pickerAt = respondToFieldSource.indexOf("<AllowlistPicker");
  const warningAt = respondToFieldSource.indexOf(
    'mode === "allowlist" ? accessWarning',
  );
  assert.ok(pickerAt > 0 && warningAt > pickerAt);
});

test("the warning copy comes from the shared helper, not inline text", () => {
  // Guards against a surface hand-rolling its own wording, which is how the
  // machine name drifts out of sync with the actual run location.
  // An explicit prop wins over the AgentRunLocationContext fallback, so the
  // call site must keep that precedence rather than reading only one source.
  assert.match(
    collapsedSource,
    /agentAccessWarningText\( mode, runLocation \?\? inheritedRunLocation, \)/,
  );
  assert.match(collapsedSource, /<p aria-live="polite"[^>]*> \{warningText\}/);
});

test("the Only me line names the owner's agents, not the owner alone", () => {
  // The harness gate admits the owner and every verified same-owner agent
  // (`managed_agents/access_policy.rs`), and the built-in Welcome team depends
  // on that, so a line promising the owner alone would overstate the boundary.
  assert.match(
    collapsedSource,
    /mode === "owner-only" \? \( <p[^>]*> Only you and your agents can send instructions\./,
  );
});

test("primary respond-to copy does not expose implementation jargon", () => {
  const primaryFieldSource = respondToFieldSource.slice(
    respondToFieldSource.indexOf('data-testid="agent-respond-to"'),
    respondToFieldSource.indexOf("function AllowlistPicker"),
  );

  for (const jargon of ["Nostr authors", "!shutdown"]) {
    assert.doesNotMatch(primaryFieldSource, new RegExp(jargon));
  }
});

test("a pasted npub or hex key can be added whatever the search returns", () => {
  // Someone whose profile the relay search misses must still be addable, so
  // direct entry parses npub and hex through the shared canonical parser and
  // renders ahead of — not instead of — the search-result branches.
  assert.match(
    respondToFieldSource,
    /const queryPubkey = parseCanonicalPubkey\(deferredQuery\);/,
  );
  const directAt = respondToFieldSource.indexOf(
    'data-testid="agent-respond-to-add-raw-pubkey"',
  );
  const loadingAt = respondToFieldSource.indexOf("{searchIsLoading ? (");
  assert.ok(directAt > 0 && loadingAt > directAt);
  assert.match(collapsedSource, /\) : directPubkey \? null : \( <p/);
});

test("the people search asks for the same page as the member picker", () => {
  assert.match(
    collapsedSource,
    /useUserSearchQuery\(deferredQuery, \{[^}]*limit: 25,/,
  );
});

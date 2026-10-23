import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import {
  clearMarkdownNodeCache,
  renderCachedMarkdown,
} from "../ui/markdown/nodeCache.ts";

// Binds the production parse pipeline (remark plugins + urlTransform), so a
// guard removed from remarkBareLinks or the plugin dropped from nodeCache
// fails here.
function render(content, extra = {}) {
  clearMarkdownNodeCache();
  return renderToStaticMarkup(
    renderCachedMarkdown({
      components: {},
      content,
      variant: "bare-links-test",
      ...extra,
    }),
  );
}

function hrefs(html) {
  return [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]);
}

test("bare domain becomes an https link with its text as the label", () => {
  const html = render("visit kiingo.com/docs, today");
  assert.match(
    html,
    /<a href="https:\/\/kiingo.com\/docs">kiingo.com\/docs<\/a>, today/,
  );
});

test("phone numbers keep their tel: href through the url transform", () => {
  assert.deepEqual(hrefs(render("call +1 (555) 123-4567")), [
    "tel:+15551234567",
  ]);
});

test("GFM www literals open over https", () => {
  assert.deepEqual(hrefs(render("see www.example.com")), [
    "https://www.example.com",
  ]);
});

test("emails stay mailto links", () => {
  assert.deepEqual(hrefs(render("mail alex@example.com")), [
    "mailto:alex@example.com",
  ]);
});

test("never inside inline or fenced code", () => {
  assert.deepEqual(hrefs(render("run `curl kiingo.com/x` now")), []);
  assert.deepEqual(hrefs(render("```\nkiingo.com +1 555 123 4567\n```")), []);
});

test("never inside an existing link label or destination", () => {
  assert.deepEqual(hrefs(render("[see kiingo.com](https://other.example/x)")), [
    "https://other.example/x",
  ]);
  assert.deepEqual(hrefs(render("[docs](https://x.example) and kiingo.com")), [
    "https://x.example",
    "https://kiingo.com",
  ]);
});

test("mentions stay mentions", () => {
  const html = render("@alice see kiingo.com", { mentionNames: ["alice"] });
  assert.match(html, /<mention>@alice<\/mention>/);
  assert.deepEqual(hrefs(html), ["https://kiingo.com"]);
});

test("filenames and versions stay text", () => {
  assert.deepEqual(hrefs(render("edit README.md and main.rs for 1.2.3")), []);
});

test("links inside emphasis, lists and blockquotes", () => {
  assert.deepEqual(
    hrefs(render("**kiingo.com**\n\n- docs.example.org/a\n\n> x.ai")),
    ["https://kiingo.com", "https://docs.example.org/a", "https://x.ai"],
  );
});

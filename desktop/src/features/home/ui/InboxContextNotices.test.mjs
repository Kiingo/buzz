import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  InboxRepliesLoadNotice,
  InboxUnavailableContextRow,
} from "./InboxContextNotices.tsx";

describe("Inbox context notices", () => {
  it("renders a quiet inline placeholder for an unavailable message", () => {
    const html = renderToStaticMarkup(
      createElement(InboxUnavailableContextRow, { eventId: "a".repeat(64) }),
    );
    assert.match(html, /data-testid="home-inbox-context-unavailable"/);
    assert.match(html, /This message is unavailable/);
    // Never the old page-level destructive banner.
    assert.doesNotMatch(html, /text-destructive|bg-destructive/);
    assert.doesNotMatch(html, /could not be loaded/);
  });

  it("offers a retry for replies without destructive styling", () => {
    const html = renderToStaticMarkup(
      createElement(InboxRepliesLoadNotice, { onRetry: () => {} }),
    );
    assert.match(html, /data-testid="home-inbox-context-retry"/);
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /text-destructive|bg-destructive/);
  });
});

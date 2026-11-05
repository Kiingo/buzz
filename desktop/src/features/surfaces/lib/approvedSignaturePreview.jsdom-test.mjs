import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { cleanup, render } from "@testing-library/react";
import {
  decodeSurface,
  offSurfaceApi,
  SurfaceController,
} from "../core/index.ts";
import { SurfaceView } from "../view/SurfaceView.tsx";

afterEach(cleanup);

const payload = (overrides = {}) => ({
  id: "0192a6b0-0000-7000-8000-0000000000ac",
  catalog: "kiingo.ui/v1",
  template: "email_draft",
  title: "Email",
  revision: 1,
  state: "active",
  root: "root",
  viewer: { canEdit: false, canAct: false },
  components: [
    {
      id: "root",
      type: "Stack",
      props: { children: ["mailbox_signature_preview"] },
    },
    {
      id: "mailbox_signature_preview",
      type: "Text",
      props: { text: "Signature setup" },
    },
  ],
  data: {},
  actions: {},
  ...overrides,
});

function show(value) {
  const surface = decodeSurface(value);
  assert.ok(surface);
  const controller = new SurfaceController(surface, {
    api: offSurfaceApi,
    client: "buzz",
    editsDisabled: true,
  });
  return render(
    React.createElement(SurfaceView, {
      controller,
      host: { apiOrigin: "https://api.kiingo.com", openUrl() {} },
    }),
  );
}

test("Buzz renders the entire server-approved signature in an isolated frame", () => {
  const { container } = show(
    payload({
      emailSignaturePreview: {
        versionId: "version-1",
        contentHash: "a".repeat(64),
        html: '<p>Owner</p><img src="data:image/png;base64,fixture"><p>Complete legal footer</p>',
      },
    }),
  );
  const frame = container.querySelector("iframe");
  assert.ok(frame);
  assert.equal(frame.title, "Complete approved email signature");
  assert.equal(frame.getAttribute("sandbox"), "");
  assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
  assert.match(frame.srcdoc, /Complete legal footer/);
  assert.match(frame.srcdoc, /default-src 'none'/);
  assert.match(frame.srcdoc, /img-src data:/);
});

test("agent component props cannot supply a signature preview", () => {
  const value = payload();
  value.components[1].props.html = "<p>Untrusted HTML</p>";
  value.components[1].props.emailSignaturePreview = {
    html: "<p>Untrusted HTML</p>",
  };
  const { container } = show(value);
  assert.equal(container.querySelector("iframe"), null);
  assert.doesNotMatch(container.innerHTML, /Untrusted HTML/);
});

test("an unrelated template cannot opt into the mailbox signature renderer", () => {
  const { container } = show(
    payload({
      template: "custom",
      emailSignaturePreview: {
        versionId: "version-1",
        contentHash: "a".repeat(64),
        html: "<p>Unrelated template content</p>",
      },
    }),
  );
  assert.equal(container.querySelector("iframe"), null);
});

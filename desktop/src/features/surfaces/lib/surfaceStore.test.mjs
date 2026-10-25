import assert from "node:assert/strict";
import test from "node:test";

import {
  setSurfaceReadForTests,
  surfaceApiOrigin,
  surfaceStore,
} from "./surfaceStore.ts";

const ID = "0192a6b0-0000-7000-8000-0000000000ac";

const payload = (revision) => ({
  id: ID,
  root: "r",
  revision,
  state: "active",
  viewer: { canEdit: true, canAct: true },
  components: [
    { id: "r", type: "Stack", props: { children: ["f"] } },
    { id: "f", type: "TextField", props: { value: { path: "/name" } } },
  ],
  data: { name: "a" },
  actions: {
    more: { kind: "ask_agent", label: "More" },
    chat: { kind: "send_message", label: "Chat", text: "hi" },
  },
});

test("surfaces load view only through the signed read, and the host origin is learned", async () => {
  const reads = [];
  const restore = setSurfaceReadForTests(async (surfaceId) => {
    reads.push(surfaceId);
    return {
      status: 200,
      body: payload(reads.length),
      origin: "https://api.example.com",
    };
  });
  try {
    const controller = await surfaceStore().load(ID, 1);
    assert.ok(controller);
    assert.equal(surfaceApiOrigin(), "https://api.example.com");
    assert.equal(controller.client, "buzz");
    assert.equal(controller.editsDisabled, true);
    assert.equal(controller.runAvailable, false);
    assert.equal(controller.acceptsEdits, false);
    assert.equal(
      controller.canTap(controller.surface.actions.get("more")),
      false,
    );
    assert.equal(
      controller.canTap(controller.surface.actions.get("chat")),
      true,
    );
    // The same revision reuses the controller; a newer one reads again.
    assert.equal(await surfaceStore().load(ID, 1), controller);
    await surfaceStore().load(ID, 2);
    assert.deepEqual(reads, [ID, ID]);
    assert.equal(controller.surface.revision, 2);
  } finally {
    restore();
  }
});

test("a refused or missing surface leaves the message plain", async () => {
  const restore = setSurfaceReadForTests(async () => ({
    status: 404,
    body: { error: "ui_surface_not_found" },
  }));
  try {
    assert.equal(await surfaceStore().load(ID, 1), undefined);
  } finally {
    restore();
  }
});

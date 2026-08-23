import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://buzz.local/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.DocumentFragment = dom.window.DocumentFragment;
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.EventTarget = dom.window.EventTarget;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});

const handlers = new Map();
const eventHandlers = new Map();
let callbackId = 1;
const callbacks = new Map();
const tauriInternals = {
  invoke(command, args) {
    const handler = handlers.get(command);
    if (!handler)
      return Promise.reject(new Error(`unmocked command: ${command}`));
    return Promise.resolve(handler(args));
  },
  transformCallback(callback) {
    const id = callbackId++;
    callbacks.set(id, callback);
    return id;
  },
};
window.__TAURI_INTERNALS__ = tauriInternals;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
globalThis.__TAURI_INTERNALS__ = tauriInternals;

const React = await import("react");
const { act, cleanup, fireEvent, render, screen, waitFor } = await import(
  "@testing-library/react"
);
const { IdentityRotationExtension } = await import(
  "./IdentityRotationExtension.tsx"
);
const { ThemeProvider } = await import("@/shared/theme/ThemeProvider");

const handoff = {
  id: "handoff-1",
  contractVersion: 1,
  rotationId: "20000000-0000-4000-8000-000000000001",
  resume: false,
  recoveryBackupRequired: true,
  assistedReminder: false,
};

function setup(preview, pending = handoff) {
  handlers.set("take_pending_identity_rotation", () => pending);
  handlers.set("inspect_identity_rotation_handoff", () => preview);
  handlers.set("plugin:event|listen", ({ event, handler }) => {
    eventHandlers.set(event, callbacks.get(handler));
    return handler;
  });
  handlers.set("plugin:event|unlisten", () => null);
  handlers.set("acknowledge_pending_identity_rotation", () => true);
}

function renderExtension() {
  return render(
    React.createElement(
      ThemeProvider,
      { defaultTheme: "buzz" },
      React.createElement(IdentityRotationExtension),
    ),
  );
}

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  handlers.clear();
  callbacks.clear();
  eventHandlers.clear();
});

test("renders authoritative all-identity scope and gates start on backup plus consent", async () => {
  setup({
    mode: "all",
    managedAgentCount: 3,
    hostedAgentCount: 2,
    agentNames: ["High Agency", "Research", "Local Helper"],
    recoveryBackupRequired: true,
  });
  let runRequest;
  handlers.set("run_identity_rotation", ({ request }) => {
    runRequest = request;
    return { state: "complete" };
  });

  renderExtension();
  assert.match(
    (await screen.findByLabelText("Verified rotation scope")).textContent,
    /human identity and 3 managed agents/i,
  );
  const start = screen.getByRole("button", {
    name: /verify backup and rotate/i,
  });
  assert.equal(start.disabled, true);
  fireEvent.change(document.getElementById("rotation-passphrase"), {
    target: { value: "correct horse battery" },
  });
  fireEvent.change(document.getElementById("rotation-passphrase-confirm"), {
    target: { value: "correct horse battery" },
  });
  assert.equal(start.disabled, true);
  fireEvent.click(
    screen.getByRole("checkbox", { name: /prior authority.*will be revoked/i }),
  );
  assert.equal(start.disabled, false);
  fireEvent.click(start);
  await waitFor(() => assert.ok(runRequest));
  assert.equal(runRequest.handoffId, "handoff-1");
  assert.equal(runRequest.recoveryPassphrase, "correct horse battery");
});

test("agent-only scope does not request a human backup but still requires hard-cutover consent", async () => {
  setup({
    mode: "agent",
    managedAgentCount: 1,
    hostedAgentCount: 1,
    agentNames: ["High Agency"],
    recoveryBackupRequired: false,
  });
  handlers.set("run_identity_rotation", () => new Promise(() => {}));

  renderExtension();
  assert.match(
    (await screen.findByLabelText("Verified rotation scope")).textContent,
    /one managed agent \(High Agency\)/i,
  );
  assert.equal(screen.queryByLabelText("Recovery backup passphrase"), null);
  const start = screen.getByRole("button", {
    name: /verify backup and rotate/i,
  });
  fireEvent.click(
    screen.getByRole("checkbox", { name: /prior authority.*will be revoked/i }),
  );
  assert.equal(start.disabled, false);
});

test("renders durable progress, rejects secret-bearing event text, and prevents post-commit dismissal while running", async () => {
  setup({
    mode: "agent",
    managedAgentCount: 1,
    hostedAgentCount: 1,
    agentNames: ["High Agency"],
    recoveryBackupRequired: false,
  });
  handlers.set("run_identity_rotation", () => new Promise(() => {}));

  renderExtension();
  await screen.findByLabelText("Verified rotation scope");
  fireEvent.click(
    screen.getByRole("checkbox", { name: /prior authority.*will be revoked/i }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /verify backup and rotate/i }),
  );
  await screen.findByText(/verifying the signed rotation plan/i);
  await waitFor(() =>
    assert.equal(
      typeof eventHandlers.get("identity-rotation-progress"),
      "function",
    ),
  );
  await act(async () => {
    eventHandlers.get("identity-rotation-progress")({
      event: "identity-rotation-progress",
      id: 1,
      payload: {
        rotationId: handoff.rotationId,
        state: "committed",
        message: "Running signed relay and hosted-agent canaries…",
        terminal: false,
        errorCode: null,
      },
    });
  });
  await screen.findByText(/hosted-agent canaries/i);
  assert.equal(screen.getByRole("button", { name: "Not now" }).disabled, true);

  await act(async () => {
    eventHandlers.get("identity-rotation-progress")({
      event: "identity-rotation-progress",
      id: 2,
      payload: {
        rotationId: handoff.rotationId,
        state: "recoverable",
        message: "nsec1must-never-render password",
        terminal: true,
        errorCode: "raw provider response with ciphertext",
      },
    });
  });
  await screen.findByText("Identity rotation status updated.");
  assert.equal(
    document.body.textContent.includes("nsec1must-never-render"),
    false,
  );
  assert.equal(document.body.textContent.includes("ciphertext"), false);
});

test("resume handoffs preserve the exact scope and invoke the existing handoff instead of minting a new plan", async () => {
  const resumed = { ...handoff, id: "handoff-resume", resume: true };
  setup(
    {
      mode: "all",
      managedAgentCount: 2,
      hostedAgentCount: 1,
      agentNames: ["High Agency", "Local Helper"],
      recoveryBackupRequired: false,
    },
    resumed,
  );
  let request;
  handlers.set("run_identity_rotation", ({ request: value }) => {
    request = value;
    return { state: "complete" };
  });

  renderExtension();
  assert.match(
    (await screen.findByLabelText("Verified rotation scope")).textContent,
    /human identity and 2 managed agents/i,
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: /prior authority.*will be revoked/i }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /verify backup and rotate/i }),
  );
  await waitFor(() => assert.equal(request?.handoffId, "handoff-resume"));
  assert.equal(request.recoveryPassphrase, null);
});

test("command failures render actionable guidance instead of a raw internal fallback", async () => {
  setup({
    mode: "agent",
    managedAgentCount: 1,
    hostedAgentCount: 1,
    agentNames: ["High Agency"],
    recoveryBackupRequired: false,
  });
  handlers.set("run_identity_rotation", () =>
    Promise.reject("identity_rotation_internal"),
  );

  renderExtension();
  await screen.findByLabelText("Verified rotation scope");
  fireEvent.click(
    screen.getByRole("checkbox", { name: /prior authority.*will be revoked/i }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /verify backup and rotate/i }),
  );

  await screen.findByText(/unexpected error before cutover/i);
  assert.match(document.body.textContent, /old keys remain active/i);
  assert.match(
    document.body.textContent,
    /support code: identity_rotation_internal/i,
  );
});

test("durable recoverable progress is not overwritten by a later generic command failure", async () => {
  setup({
    mode: "agent",
    managedAgentCount: 1,
    hostedAgentCount: 1,
    agentNames: ["High Agency"],
    recoveryBackupRequired: false,
  });
  let rejectRun;
  handlers.set(
    "run_identity_rotation",
    () =>
      new Promise((_, reject) => {
        rejectRun = reject;
      }),
  );

  renderExtension();
  await screen.findByLabelText("Verified rotation scope");
  fireEvent.click(
    screen.getByRole("checkbox", { name: /prior authority.*will be revoked/i }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /verify backup and rotate/i }),
  );
  await waitFor(() =>
    assert.equal(
      typeof eventHandlers.get("identity-rotation-progress"),
      "function",
    ),
  );

  await act(async () => {
    eventHandlers.get("identity-rotation-progress")({
      event: "identity-rotation-progress",
      id: 3,
      payload: {
        rotationId: handoff.rotationId,
        state: "recoverable",
        message: "Rotation paused safely.",
        terminal: true,
        errorCode: "identity_rotation_old_membership_missing",
      },
    });
  });
  await screen.findByText(/could not verify the source relay membership/i);

  await act(async () => {
    rejectRun("identity_rotation_internal");
  });
  assert.match(
    document.body.textContent,
    /support code: identity_rotation_old_membership_missing/i,
  );
  assert.equal(
    document.body.textContent.includes(
      "Support code: identity_rotation_internal",
    ),
    false,
  );
});

test("pre-commit dismissal leaves the handoff unacknowledged and returns focus", async () => {
  setup({
    mode: "human",
    managedAgentCount: 0,
    hostedAgentCount: 0,
    agentNames: [],
    recoveryBackupRequired: true,
  });
  let acknowledgements = 0;
  handlers.set("acknowledge_pending_identity_rotation", () => {
    acknowledgements += 1;
    return true;
  });

  renderExtension();
  await screen.findByLabelText("Verified rotation scope");
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  await waitFor(() =>
    assert.equal(screen.queryByRole("dialog", { name: /rotate buzz/i }), null),
  );
  assert.equal(acknowledgements, 0);
});

// Generated from the Kiingo surface renderer packages at 8a4382a01c1d2046b63e7c78a1220c2c33e419a3; do not edit here.
import {
  idempotencyKey,
  type Confirmation,
  type LookupItem,
  type Result,
  type SurfaceApi,
  type TapFeedback,
  type TapOutcome,
} from "./api";
import { isObject, type JsonObject, type JsonValue } from "./json";
import {
  surfaceMessage,
  RUN_UNAVAILABLE_HINT,
  VIEW_ONLY_HINT,
} from "./messages";
import {
  acceptsEdits,
  acceptsTaps,
  allowsRun,
  editedNote,
  emailSendUnknown,
  type EntityKey,
  type EntityType,
  type Surface,
  type SurfaceAction,
} from "./model";
import {
  applyPatch,
  applyPatchOp,
  coalescePatch,
  MAX_PATCH_OPS,
  opForEdit,
  type PatchOp,
} from "./patch";
import {
  parsePointer,
  readAt,
  resolvePointer,
  ROOT,
  type Pointer,
} from "./pointer";
import { surfaceProblems } from "./rules";
import {
  messageSend,
  SENDS_BLOCKED_TEXT,
  sendBlockedText,
  sentText,
  type MessageSend,
  type SurfaceTapRef,
} from "./sends";
import {
  RUN_ACTIONS_OFF,
  type RunActionGate,
  type RunAuthorization,
} from "./run-gate";

/**
 * One surface on screen (§7.2 semantics, from the Swift reference
 * `UiSurfaceController`): the server's revision, the user's local edits on
 * top (saved 600 ms after the last change, kept and retried while offline),
 * validation and the actions. Taps are never queued: a tap happens now or
 * not at all. Every view of one surface (inline and expanded) shares one
 * controller through `SurfaceStore`.
 */

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  /** Edits kept on this device, waiting to be saved. */
  | { kind: "offline"; pending: number }
  /** The server refused the edit; the field is back to its value. */
  | { kind: "refused"; text: string };

/** What a tap asks the host to do; the controller opens and sends nothing itself. */
export type Intent =
  /**
   * Send `text` as the person's message, carrying `tap` (the Buzz
   * `buzz-surface-tap` tag, the dashboard turn's `ui_surface_tap`): the only
   * way a surface sends words ({@link SurfaceController.sendMessage}).
   */
  | { kind: "sendMessage"; text: string; tap: SurfaceTapRef }
  | { kind: "openUrl"; url: string }
  | { kind: "openEntity"; entity: EntityKey }
  | { kind: "openExpanded" }
  | { kind: "openFullScreen" };

/** The busy id while "Check again" runs (never an action's id). */
export const CHECK_EMAIL_SEND_BUSY_ID = "#checkEmailSend";

/** A check that found nothing: the card stays as it is. */
export const EMAIL_SEND_NOT_FOUND_YET =
  "Not in Sent Items yet. Kiingo keeps checking.";

export type ControllerSnapshot = {
  surface: Surface;
  /** The server's data with local edits applied: what the views draw. */
  data: JsonObject;
  saveState: SaveState;
  /** Problems under inputs, by child key (`componentId@scope`). */
  problems: ReadonlyMap<string, string>;
  /** One line under the surface (stale, refused, offline). */
  notice?: string;
  /** A run waiting for the user's confirmation (server text only). */
  confirmation?: Confirmation;
  /** The action being sent, for a spinner on its button. */
  busyActionId?: string;
  /** The open text box of an ask_agent with `feedback` (one per surface). */
  feedback?: FeedbackDraft;
  pendingCount: number;
};

/**
 * The text box an ask_agent with `feedback` opens in the card (Ross,
 * 2026-11-02: "Ask agent to revise" opens "a text box below (within the
 * card)", and "Send Revision Request" sends it). `editing` → `sending` →
 * `sent` or `failed` (Retry sends again).
 */
export type FeedbackDraft = {
  actionId: string;
  text: string;
  phase: "editing" | "sending" | "sent" | "failed";
  /** One per Send: kept for a retry that got no answer (tap-feedback.ts). */
  requestId: string;
  /** With `failed`: what to tell the person. */
  error?: string;
  /** With `sent`: the words that went, and the card's revision then. */
  sentText?: string;
  sentRevision?: number;
};

export const FEEDBACK_SEND_FAILED = "Couldn’t send. Try again.";
export const FEEDBACK_DRAFT_CHANGED =
  "The draft changed. Check it, then send again.";

/** A fresh request id (one per Send). */
export const newFeedbackRequestId = (): string => {
  const crypto = globalThis.crypto as Crypto | undefined;
  if (crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (crypto && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
};

export type ControllerOptions = {
  api: SurfaceApi;
  /** The client name on edits and taps: dashboard, buzz, … */
  client: string;
  /** Run buttons: off unless the client has an approved gate. */
  runGate?: RunActionGate;
  /**
   * A host that may show a surface but not change it yet (Buzz until its
   * signed edit routes are reviewed): inputs, `set_state`, `ask_agent`,
   * `dismiss` and `run` draw disabled and send nothing, whatever `runGate`
   * says (79). `open` and `send_message` (the user's own message) are
   * unchanged.
   */
  editsDisabled?: boolean;
  debounceMs?: number;
  now?: () => number;
};

const MAX_STALE_RETRIES = 2;

export class SurfaceController {
  readonly id: string;
  readonly client: string;
  /** See `ControllerOptions.editsDisabled`. */
  readonly editsDisabled: boolean;
  private snapshot: ControllerSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly api: SurfaceApi;
  private readonly runGate: RunActionGate;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private pending: PatchOp[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private failures = 0;
  private mediaRefreshedAt: number | undefined;
  private disposed = false;
  /** Words typed in a text box that was cancelled, by action. */
  private readonly feedbackKept = new Map<string, string>();

  constructor(surface: Surface, options: ControllerOptions) {
    this.id = surface.id;
    this.client = options.client;
    this.editsDisabled = options.editsDisabled === true;
    this.api = options.api;
    this.runGate = options.runGate ?? RUN_ACTIONS_OFF;
    this.debounceMs = options.debounceMs ?? 600;
    this.now = options.now ?? (() => Date.now());
    this.snapshot = {
      surface,
      data: surface.data,
      saveState: { kind: "idle" },
      problems: new Map(),
      pendingCount: 0,
    };
  }

  // --- Observation (React's useSyncExternalStore and friends) ---------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ControllerSnapshot => this.snapshot;

  private set(patch: Partial<ControllerSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      pendingCount: this.pending.length,
    };
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  get surface(): Surface {
    return this.snapshot.surface;
  }

  get data(): JsonObject {
    return this.snapshot.data;
  }

  /** Edits are taken here: the surface accepts them and this host may send them. */
  get acceptsEdits(): boolean {
    return !this.editsDisabled && acceptsEdits(this.snapshot.surface);
  }

  /** Whether run buttons may be tapped on this client at all. */
  get runAvailable(): boolean {
    return this.runGate.available && !this.editsDisabled;
  }

  /** "Edited on Mac", "Changed by Claude", or nothing. */
  get editedNote(): string | undefined {
    return editedNote(this.snapshot.surface, this.client);
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.listeners.clear();
  }

  // --- Server updates ---------------------------------------------------------

  /** A newer revision from the feed or a read. Local edits stay on top. */
  receive(updated: Surface): void {
    if (
      updated.id !== this.id ||
      updated.revision < this.snapshot.surface.revision
    ) {
      return;
    }
    const feedback = this.snapshot.feedback;
    this.set({
      surface: updated,
      data: applyPatch(updated.data, this.pending),
      // The sent row goes once the card moves on (the agent revised it).
      ...(feedback?.phase === "sent" &&
      feedback.sentRevision !== undefined &&
      updated.revision > feedback.sentRevision
        ? { feedback: undefined }
        : {}),
    });
  }

  async refresh(): Promise<void> {
    try {
      const result = await this.api.surface(this.id);
      if (result.kind === "done") {
        this.receive(result.value);
      } else if (result.kind === "refused") {
        this.set({ notice: result.message ?? surfaceMessage(result.code) });
      }
    } catch {
      // Kept as is; the next save or tap reads it again.
    }
  }

  /**
   * A media load answered 401/410: read the surface again so its URLs are
   * re-signed. At most once a minute, so a URL that keeps failing shows its
   * alt text instead of looping. False when skipped.
   */
  async refreshForExpiredMedia(): Promise<boolean> {
    const now = this.now();
    if (
      this.mediaRefreshedAt !== undefined &&
      now - this.mediaRefreshedAt < 60_000
    ) {
      return false;
    }
    this.mediaRefreshedAt = now;
    await this.refresh();
    return true;
  }

  // --- Edits ------------------------------------------------------------------

  value(pointer: Pointer): JsonValue | undefined {
    return readAt(this.snapshot.data, pointer);
  }

  /** A user's change to a bound input; undefined removes the value. */
  edit(pointer: Pointer, value: JsonValue | undefined): void {
    const surface = this.snapshot.surface;
    if (!this.acceptsEdits) {
      this.set({
        notice: this.editsDisabled
          ? VIEW_ONLY_HINT
          : surface.viewer.canEdit
            ? "This is no longer open."
            : surfaceMessage("ui_surface_not_editor"),
      });
      return;
    }
    const data = this.snapshot.data;
    const op = opForEdit(data, pointer, value);
    if (!op) {
      return;
    }
    const next = applyPatch(data, []);
    if (!applyPatchOp(next, op)) {
      return;
    }
    this.pending.push(op);
    let problems = this.snapshot.problems;
    if (problems.size > 0) {
      const current = surfaceProblems(surface, next);
      problems = new Map([...problems].filter(([key]) => current.has(key)));
    }
    this.set({ data: next, problems });
    this.scheduleSave();
  }

  private scheduleSave(delay = this.debounceMs): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (!this.disposed) {
        void this.startFlush();
      }
    }, delay);
  }

  /** Saves what's pending now (before a tap, or when the view closes). */
  async saveNow(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.flushing) {
      await this.flushing;
    }
    if (this.pending.length > 0) {
      await this.startFlush();
    }
  }

  private startFlush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.runFlush().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  private async runFlush(): Promise<void> {
    let staleRetries = 0;
    while (this.pending.length > 0 && !this.disposed) {
      const batch = this.pending.slice(0, MAX_PATCH_OPS);
      const sent = batch.length;
      const ops = coalescePatch(batch);
      this.set({ saveState: { kind: "saving" } });
      let result: Result<Surface>;
      try {
        result = await this.api.editSurface(
          this.id,
          this.snapshot.surface.revision,
          ops,
          this.client,
        );
      } catch {
        this.failures += 1;
        this.set({
          saveState: { kind: "offline", pending: this.pending.length },
        });
        this.scheduleSave(
          Math.min(60_000, 1000 * 2 ** Math.min(this.failures, 6)),
        );
        return;
      }
      this.failures = 0;
      if (result.kind === "done") {
        this.pending.splice(0, Math.min(sent, this.pending.length));
        const updated =
          result.value.revision >= this.snapshot.surface.revision
            ? result.value
            : this.snapshot.surface;
        this.set({
          surface: updated,
          data: applyPatch(updated.data, this.pending),
          saveState: { kind: "saved", at: this.now() },
        });
        continue;
      }
      if (
        result.kind === "refused" &&
        result.code === "ui_surface_revision_stale" &&
        staleRetries < MAX_STALE_RETRIES
      ) {
        // Someone else saved first: read theirs, put ours on top, try again.
        staleRetries += 1;
        await this.refresh();
        continue;
      }
      this.pending.splice(0, Math.min(sent, this.pending.length));
      const text =
        result.kind === "refused"
          ? (result.message ?? surfaceMessage(result.code))
          : "Changes can’t be saved here.";
      const surface = this.snapshot.surface;
      this.set({
        data: applyPatch(surface.data, this.pending),
        saveState: { kind: "refused", text },
        ...(result.kind === "refused" ? { notice: text } : {}),
      });
      return;
    }
  }

  // --- Lookups (empty when off, refused or unreachable) -------------------------

  private async lookup(
    call: () => Promise<{ kind: string; value?: LookupItem[] }>,
  ): Promise<LookupItem[]> {
    try {
      const result = await call();
      return result.kind === "done" ? (result.value ?? []) : [];
    } catch {
      return [];
    }
  }

  lookupRecipients(query: string): Promise<LookupItem[]> {
    return this.lookup(() => this.api.lookupRecipients(query));
  }

  lookupEntities(
    type: EntityType | undefined,
    query: string,
  ): Promise<LookupItem[]> {
    return this.lookup(() => this.api.lookupEntities(type, query));
  }

  resolveRefs(keys: EntityKey[]): Promise<LookupItem[]> {
    return this.lookup(() => this.api.resolveRefs(keys));
  }

  private refTitles = new Map<string, Promise<string | undefined>>();
  private refBatch: {
    keys: EntityKey[];
    resolve: (items: LookupItem[]) => void;
  }[] = [];
  private refTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * One entity's title, looked up once per surface and batched with every
   * other chip drawn in the same moment (79 W8): one request, not one per
   * chip.
   */
  resolveRefTitle(key: EntityKey): Promise<string | undefined> {
    const id = `${key.type}:${key.id}`;
    const known = this.refTitles.get(id);
    if (known) {
      return known;
    }
    const title = new Promise<LookupItem[]>((resolve) => {
      this.refBatch.push({ keys: [key], resolve });
      this.refTimer ??= setTimeout(() => this.flushRefs(), 16);
    }).then(
      // By type and id: two entities of different types may share an id.
      (items) =>
        items.find(
          (item) =>
            item.id === key.id &&
            (item.type === undefined || item.type === key.type),
        )?.title,
    );
    this.refTitles.set(id, title);
    return title;
  }

  private flushRefs(): void {
    this.refTimer = undefined;
    const batch = this.refBatch.splice(0, this.refBatch.length);
    for (let at = 0; at < batch.length; at += 100) {
      const part = batch.slice(at, at + 100);
      void this.resolveRefs(part.flatMap((entry) => entry.keys)).then(
        (items) => {
          for (const entry of part) {
            entry.resolve(items);
          }
        },
        () => {
          for (const entry of part) {
            entry.resolve([]);
          }
        },
      );
    }
  }

  lookupFiles(query: string): Promise<LookupItem[]> {
    return this.lookup(() => this.api.lookupFiles(query));
  }

  // --- Validation ---------------------------------------------------------------

  /** Checks inputs under `paths` (a Steps step, an action's `validate`), or every visible input. */
  validate(paths?: readonly Pointer[]): boolean {
    const problems = surfaceProblems(
      this.snapshot.surface,
      this.snapshot.data,
      paths,
    );
    this.set({
      problems,
      ...(problems.size > 0
        ? { notice: surfaceMessage("ui_validation_failed") }
        : {}),
    });
    return problems.size === 0;
  }

  problem(childKey: string): string | undefined {
    return this.snapshot.problems.get(childKey);
  }

  clearNotice(): void {
    this.set({ notice: undefined });
  }

  // --- Actions --------------------------------------------------------------------

  /** Whether a button for `action` can be tapped here. */
  canTap(action: SurfaceAction): boolean {
    const surface = this.snapshot.surface;
    switch (action.kind) {
      case "open":
        return true;
      case "set_state":
        return this.acceptsEdits;
      case "run":
        return this.runAvailable && allowsRun(surface);
      case "unknown":
        return false;
      case "send_message":
        return (
          acceptsTaps(surface) &&
          sentText(
            messageSend(action.label, action.text, action.hidden === true),
          ) !== undefined
        );
      default:
        return !this.editsDisabled && acceptsTaps(surface);
    }
  }

  /**
   * The single path by which a surface sends words as the person's message
   * (79 H1/W1/M1, tap-trust condition 2): a `send_message` action or a
   * suggestion chip, with the {@link MessageSend} its control drew. A
   * blocked send says why and sends nothing; otherwise the intent carries
   * exactly the drawn words and the tap reference every host must attach.
   */
  sendMessage(send: MessageSend, actionId: string): Intent | undefined {
    const surface = this.snapshot.surface;
    if (!acceptsTaps(surface)) {
      this.set({ notice: surfaceMessage("ui_surface_not_editor") });
      return undefined;
    }
    const text = sentText(send);
    if (text === undefined) {
      this.set({ notice: sendBlockedText(send) ?? SENDS_BLOCKED_TEXT });
      return undefined;
    }
    return {
      kind: "sendMessage",
      text,
      tap: { surfaceId: this.id, actionId, revision: surface.revision },
    };
  }

  /**
   * A tap on an action. Returns what the host should do for client-side
   * kinds; server-side kinds update the controller (and may leave a
   * confirmation to show).
   */
  async tap(
    actionId: string,
    scope: Pointer = ROOT,
  ): Promise<Intent | undefined> {
    const surface = this.snapshot.surface;
    const action = surface.actions.get(actionId);
    if (!action || this.snapshot.busyActionId) {
      return undefined;
    }
    this.set({ notice: undefined });
    switch (action.kind) {
      case "open": {
        const target = action.target;
        if (!target) {
          return undefined;
        }
        if (target.kind === "url") {
          return { kind: "openUrl", url: target.url };
        }
        if (target.kind === "entity") {
          return { kind: "openEntity", entity: target.entity };
        }
        if (target.kind === "fullscreen") {
          return { kind: "openFullScreen" };
        }
        return { kind: "openExpanded" };
      }
      case "send_message":
        return this.sendMessage(
          messageSend(action.label, action.text, action.hidden === true),
          actionId,
        );
      case "set_state": {
        const pointer = action.statePath
          ? resolvePointer(action.statePath, scope)
          : undefined;
        if (pointer) {
          this.edit(pointer, action.stateValue ?? null);
        }
        return undefined;
      }
      case "run":
      case "ask_agent": {
        if (action.kind === "ask_agent" && action.feedback) {
          this.openFeedback(action);
          return undefined;
        }
        if (action.kind === "run" && !this.runAvailable) {
          this.set({ notice: RUN_UNAVAILABLE_HINT });
          return undefined;
        }
        if (action.kind === "ask_agent" && this.editsDisabled) {
          this.set({ notice: VIEW_ONLY_HINT });
          return undefined;
        }
        if (action.kind === "run" && !allowsRun(surface)) {
          this.set({ notice: surfaceMessage("ui_action_not_allowed") });
          return undefined;
        }
        if (!acceptsTaps(surface)) {
          this.set({
            notice: surface.viewer.canAct
              ? "This is no longer open."
              : surfaceMessage("ui_surface_not_editor"),
          });
          return undefined;
        }
        const paths = action.validates
          ?.map((path) => parsePointer(path))
          .filter((path): path is Pointer => Boolean(path));
        if (!this.validate(paths) || !(await this.savedBeforeTap())) {
          return undefined;
        }
        let extra: RunAuthorization | null | undefined;
        const gate = this.runGate;
        if (action.kind === "run" && gate.available && !this.editsDisabled) {
          extra = await gate.authorize("tap", {
            surfaceId: this.id,
            actionId,
            revision: this.snapshot.surface.revision,
          });
          if (!extra) {
            return undefined;
          }
        }
        await this.send(actionId, () =>
          this.api.tap(
            this.id,
            actionId,
            this.snapshot.surface.revision,
            this.client,
            extra ?? undefined,
          ),
        );
        return undefined;
      }
      case "dismiss": {
        if (this.editsDisabled) {
          this.set({ notice: VIEW_ONLY_HINT });
          return undefined;
        }
        if (
          !(acceptsTaps(surface) || surface.state === "submitted") ||
          !(await this.savedBeforeTap())
        ) {
          return undefined;
        }
        await this.send(actionId, () =>
          this.api.dismiss(
            this.id,
            this.snapshot.surface.revision,
            this.client,
          ),
        );
        return undefined;
      }
      default:
        this.set({ notice: "This needs a newer version of the app." });
        return undefined;
    }
  }

  // --- An ask_agent's text box (`feedback`) -----------------------------------

  /** Opens the text box of `action` in the card (a press of its button). */
  openFeedback(action: SurfaceAction): void {
    const surface = this.snapshot.surface;
    if (!action.feedback) {
      return;
    }
    if (this.editsDisabled) {
      this.set({ notice: VIEW_ONLY_HINT });
      return;
    }
    if (!acceptsTaps(surface)) {
      this.set({
        notice: surface.viewer.canAct
          ? "This is no longer open."
          : surfaceMessage("ui_surface_not_editor"),
      });
      return;
    }
    const open = this.snapshot.feedback;
    if (open?.actionId === action.id && open.phase !== "sent") {
      return;
    }
    this.set({
      feedback: {
        actionId: action.id,
        // Words typed before a Cancel come back.
        text:
          open?.actionId === action.id && open.phase !== "sent"
            ? open.text
            : (this.feedbackKept.get(action.id) ?? ""),
        phase: "editing",
        requestId: newFeedbackRequestId(),
      },
    });
  }

  /** The person typed in the box. New words are a new request. */
  setFeedbackText(text: string): void {
    const open = this.snapshot.feedback;
    if (!open || open.phase === "sending" || open.phase === "sent") {
      return;
    }
    this.set({
      feedback: {
        ...open,
        text,
        ...(text !== open.text ? { requestId: newFeedbackRequestId() } : {}),
      },
    });
  }

  /** Cancel or Done: the box closes (typed words are kept for next time). */
  closeFeedback(): void {
    const open = this.snapshot.feedback;
    if (!open || open.phase === "sending") {
      return;
    }
    if (open.phase === "sent") {
      this.feedbackKept.delete(open.actionId);
    } else {
      this.feedbackKept.set(open.actionId, open.text);
    }
    this.set({ feedback: undefined });
  }

  /** Send (or Retry): the tap with the person's words. Empty words never go. */
  async sendFeedback(): Promise<void> {
    const open = this.snapshot.feedback;
    const action = open
      ? this.snapshot.surface.actions.get(open.actionId)
      : undefined;
    const text = open?.text.trim() ?? "";
    if (
      !open ||
      !action?.feedback ||
      open.phase === "sending" ||
      open.phase === "sent" ||
      !text ||
      this.snapshot.busyActionId
    ) {
      return;
    }
    const surface = this.snapshot.surface;
    if (this.editsDisabled || !acceptsTaps(surface)) {
      this.failFeedback(
        open,
        surface.viewer.canAct && !this.editsDisabled
          ? "This is no longer open."
          : VIEW_ONLY_HINT,
        true,
      );
      return;
    }
    const sending: FeedbackDraft = {
      ...open,
      phase: "sending",
      error: undefined,
    };
    this.set({ feedback: sending, notice: undefined });
    if (!(await this.savedBeforeTap())) {
      this.failFeedback(
        sending,
        this.snapshot.notice ?? FEEDBACK_SEND_FAILED,
        false,
      );
      return;
    }
    const revision = this.snapshot.surface.revision;
    const words: TapFeedback = { text, requestId: open.requestId };
    this.set({ busyActionId: action.id });
    let outcome: TapOutcome;
    try {
      outcome = await this.api.tap(
        this.id,
        action.id,
        revision,
        this.client,
        undefined,
        words,
      );
    } catch {
      // No answer: a Retry keeps the request id, so it never sends twice.
      this.set({ busyActionId: undefined });
      this.failFeedback(sending, FEEDBACK_SEND_FAILED, false);
      return;
    }
    this.set({ busyActionId: undefined });
    switch (outcome.kind) {
      case "done":
        this.feedbackKept.delete(action.id);
        this.set({
          feedback: {
            ...sending,
            phase: "sent",
            sentText: text,
            sentRevision: revision,
          },
        });
        if (outcome.surface) {
          this.receive(outcome.surface);
        } else {
          await this.refresh();
        }
        return;
      case "stale":
        if (outcome.surface) {
          this.receive(outcome.surface);
        } else {
          await this.refresh();
        }
        this.failFeedback(sending, FEEDBACK_DRAFT_CHANGED, true);
        return;
      case "refused":
        this.failFeedback(
          sending,
          outcome.message ?? FEEDBACK_SEND_FAILED,
          true,
        );
        return;
      default:
        this.failFeedback(sending, "This isn’t available here yet.", true);
    }
  }

  /** `answered`: the server refused, so a Retry is a new request. */
  private failFeedback(
    draft: FeedbackDraft,
    error: string,
    answered: boolean,
  ): void {
    if (this.snapshot.feedback?.actionId !== draft.actionId) {
      return;
    }
    this.set({
      feedback: {
        ...draft,
        phase: "failed",
        error,
        ...(answered ? { requestId: newFeedbackRequestId() } : {}),
      },
    });
  }

  /** The server resolves a tap from its stored revision, so local edits go first. */
  private async savedBeforeTap(): Promise<boolean> {
    await this.saveNow();
    if (this.pending.length > 0) {
      this.set({
        notice:
          "Your changes haven’t saved yet. Try again when you’re back online.",
      });
      return false;
    }
    return true;
  }

  /** Confirms the shown run with the server's revision and nonce exactly as they came (R5). */
  async confirm(
    confirmation: Confirmation | undefined = this.snapshot.confirmation,
  ): Promise<void> {
    if (!confirmation) {
      return;
    }
    if (this.snapshot.confirmation === confirmation) {
      this.set({ confirmation: undefined });
    }
    const gate = this.runGate;
    if (!gate.available || this.editsDisabled) {
      this.set({ notice: RUN_UNAVAILABLE_HINT });
      return;
    }
    if (
      confirmation.expiresAt &&
      Date.parse(confirmation.expiresAt) <= this.now()
    ) {
      // A stale nonce is never sent: tap again for a fresh confirmation.
      const again = await gate.authorize("tap", {
        surfaceId: this.id,
        actionId: confirmation.actionId,
        revision: this.snapshot.surface.revision,
      });
      if (!again) {
        return;
      }
      await this.send(confirmation.actionId, () =>
        this.api.tap(
          this.id,
          confirmation.actionId,
          this.snapshot.surface.revision,
          this.client,
          again,
        ),
      );
      return;
    }
    const authorization = await gate.authorize("confirm", {
      surfaceId: confirmation.surfaceId,
      actionId: confirmation.actionId,
      revision: confirmation.revision,
      confirmation,
    });
    if (!authorization) {
      return;
    }
    await this.send(confirmation.actionId, () =>
      this.api.confirm(
        confirmation.surfaceId,
        confirmation.actionId,
        confirmation.revision,
        confirmation.nonce,
        this.client,
        authorization,
      ),
    );
  }

  cancelConfirmation(): void {
    this.set({ confirmation: undefined });
  }

  /**
   * "Check again" on an email card whose send Outlook never confirmed
   * (M-4916): Kiingo reads Sent Items again and the card then shows what the
   * server says. Only the server's own read settles it; nothing is sent.
   */
  async checkEmailSend(): Promise<void> {
    const surface = this.snapshot.surface;
    if (!emailSendUnknown(surface) || this.snapshot.busyActionId) {
      return;
    }
    this.set({
      busyActionId: CHECK_EMAIL_SEND_BUSY_ID,
      notice: undefined,
    });
    try {
      const result = await this.api.checkEmailSend(
        surface.id,
        surface.status?.operationId,
        this.client,
      );
      switch (result.kind) {
        case "done":
          await this.refresh();
          if (result.value === "unknown") {
            this.set({ notice: EMAIL_SEND_NOT_FOUND_YET });
          }
          break;
        case "refused":
          this.set({ notice: result.message ?? surfaceMessage(result.code) });
          break;
        case "off":
          this.set({ notice: "This isn’t available here yet." });
          break;
      }
    } catch {
      this.set({ notice: "Couldn’t reach Kiingo. Try again." });
    } finally {
      this.set({ busyActionId: undefined });
    }
  }

  private async send(
    actionId: string,
    call: () => Promise<TapOutcome>,
  ): Promise<void> {
    this.set({ busyActionId: actionId });
    try {
      const outcome = await call();
      this.set({ busyActionId: undefined });
      switch (outcome.kind) {
        case "done":
          if (outcome.surface) {
            this.receive(outcome.surface);
          } else {
            await this.refresh();
          }
          break;
        case "confirm":
          this.set({ confirmation: outcome.confirmation });
          break;
        case "stale":
          if (outcome.surface) {
            this.receive(outcome.surface);
          } else {
            await this.refresh();
          }
          this.set({ notice: surfaceMessage("ui_surface_revision_stale") });
          break;
        case "refused":
          this.set({ notice: outcome.message ?? surfaceMessage(outcome.code) });
          break;
        default:
          this.set({ notice: "This isn’t available here yet." });
      }
    } catch {
      // Taps are never queued: a run happens now or not at all.
      this.set({
        busyActionId: undefined,
        notice: "Couldn’t reach Kiingo. Try again.",
      });
    }
  }
}

/** The idempotency key the confirm carries (exported for hosts that send their own confirm). */
export const confirmKey = (confirmation: Confirmation): string =>
  idempotencyKey(
    confirmation.surfaceId,
    confirmation.actionId,
    confirmation.revision,
  );

/** One controller per surface id, shared by the inline card and the expanded view. */
export class SurfaceStore {
  static readonly capacity = 64;
  private readonly controllers = new Map<string, SurfaceController>();
  private order: string[] = [];

  constructor(private readonly options: ControllerOptions) {}

  get api(): SurfaceApi {
    return this.options.api;
  }

  get client(): string {
    return this.options.client;
  }

  get runAvailable(): boolean {
    return (this.options.runGate ?? RUN_ACTIONS_OFF).available;
  }

  controller(id: string): SurfaceController | undefined {
    return this.controllers.get(id);
  }

  /** The controller for `surface`, made on first use; a newer revision updates it. */
  controllerFor(surface: Surface): SurfaceController {
    this.touch(surface.id);
    const existing = this.controllers.get(surface.id);
    if (existing) {
      existing.receive(surface);
      return existing;
    }
    const controller = new SurfaceController(surface, this.options);
    this.controllers.set(surface.id, controller);
    this.trim();
    return controller;
  }

  /** Reads a surface the chat only pointed at. */
  async load(
    surfaceId: string,
    revision?: number,
  ): Promise<SurfaceController | undefined> {
    const existing = this.controllers.get(surfaceId);
    if (existing) {
      if (revision !== undefined && revision > existing.surface.revision) {
        await existing.refresh();
      }
      this.touch(surfaceId);
      return existing;
    }
    try {
      const result = await this.options.api.surface(surfaceId);
      return result.kind === "done"
        ? this.controllerFor(result.value)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Saves every pending edit (page hidden or closing). */
  async saveAll(): Promise<void> {
    await Promise.all(
      [...this.controllers.values()]
        .filter((c) => c.getSnapshot().pendingCount > 0)
        .map((c) => c.saveNow()),
    );
  }

  private touch(id: string): void {
    this.order = this.order.filter((item) => item !== id);
    this.order.push(id);
  }

  private trim(): void {
    while (this.controllers.size > SurfaceStore.capacity) {
      const victim = this.order.find(
        (id) => this.controllers.get(id)?.getSnapshot().pendingCount === 0,
      );
      if (!victim) {
        return;
      }
      this.controllers.get(victim)?.dispose();
      this.controllers.delete(victim);
      this.order = this.order.filter((id) => id !== victim);
    }
  }
}

/** True when the value is a JSON object (re-exported for renderers). */
export const isJsonObject = isObject;

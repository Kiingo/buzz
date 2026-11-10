// Generated from the Kiingo surface renderer packages at 1055d96f74fb6ac27bf0ebcd3c7fa12aee50be9c; do not edit here.
import { idempotencyKey, type Confirmation, type SurfaceApi } from "./api";
import type { JsonObject } from "./json";
import type { EntityKey, Surface } from "./model";
import type { RunActionGate } from "./run-gate";
import type { SurfaceTapRef } from "./sends";

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
   * way a surface sends words (`SurfaceController.sendMessage`).
   */
  | { kind: "sendMessage"; text: string; tap: SurfaceTapRef }
  | { kind: "openUrl"; url: string }
  | { kind: "openEntity"; entity: EntityKey }
  | { kind: "openExpanded" }
  | { kind: "openFullScreen" };

/** The busy id while "Check again" runs (never an action's id). */
export const CHECK_EMAIL_SEND_BUSY_ID = "#checkEmailSend";
export const RESOLVE_EMAIL_SEND_BUSY_ID = "#resolveEmailSend";

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

/** The idempotency key the confirm carries (exported for hosts that send their own confirm). */
export const confirmKey = (confirmation: Confirmation): string =>
  idempotencyKey(
    confirmation.surfaceId,
    confirmation.actionId,
    confirmation.revision,
  );

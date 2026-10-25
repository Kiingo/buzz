// Generated from the Kiingo surface renderer packages; do not edit here.
import type { JsonValue } from "./json";
import type { Confirmation } from "./api";

/**
 * THE hook point for `run` (direct action) buttons on clients that need a
 * second factor before a run goes, such as the web dashboard's passkey
 * (WebAuthn user verification) gate, which security review has not
 * approved yet. While a client's gate is `RUN_ACTIONS_OFF`, run buttons
 * are drawn disabled with "Open in the Kiingo app" and nothing is sent.
 *
 * When the passkey flow lands, its client passes an available gate whose
 * `authorize` asks for the passkey and returns what the server needs with
 * the request (for example a `deviceProof` body field), or null when the
 * person cancels. Nothing else in the renderer changes.
 */
export type RunAuthorization = {
  body?: Record<string, JsonValue>;
  headers?: Record<string, string>;
};

export type RunActionGate =
  | { available: false; reason?: string }
  | {
      available: true;
      /**
       * Called before the tap that asks for the confirmation (`stage: 'tap'`)
       * and before the confirm itself (`stage: 'confirm'`, with the server's
       * confirmation). Null stops: nothing is sent.
       */
      authorize: (
        stage: "tap" | "confirm",
        request: {
          surfaceId: string;
          actionId: string;
          revision: number;
          confirmation?: Confirmation;
        },
      ) => Promise<RunAuthorization | null>;
    };

/** Run buttons off on this client (the default everywhere but Tasks and Companion). */
export const RUN_ACTIONS_OFF: RunActionGate = { available: false };

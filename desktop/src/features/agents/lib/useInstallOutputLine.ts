import * as React from "react";
import { listen } from "@tauri-apps/api/event";

/** Mirror of the Rust `InstallOutputEvent` payload (install_report.rs). */
export type InstallOutputEvent = {
  runtime_id: string;
  attempt: number;
  line: string;
};

/** The line being shown, and which attempt produced it. */
export type InstallOutputState = {
  attempt: number;
  line: string;
};

/**
 * Fold one event into the displayed line.
 *
 * Events from another runtime are ignored — every install card listens to the
 * same channel. So is an event from a superseded attempt: install retries with
 * backoff, and a line emitted just as attempt 2 starts would otherwise sit
 * under the spinner while attempt 2 runs, showing the user the failure they
 * already had instead of current progress.
 */
export function nextInstallOutputLine(
  current: InstallOutputState | null,
  event: InstallOutputEvent,
  runtimeId: string,
): InstallOutputState | null {
  if (event.runtime_id !== runtimeId) return current;
  if (current && event.attempt < current.attempt) return current;
  return { attempt: event.attempt, line: event.line };
}

/**
 * The install command's most recent output line for `runtimeId`, or null when
 * nothing has been printed yet.
 *
 * An install runs for up to 15 minutes with no other feedback than a spinner;
 * this turns that wait into observable progress. The backend throttles
 * emission, so this re-renders a few times a second at most.
 *
 * Pass `isInstalling` so the line clears when the install settles — a finished
 * install must not leave its last line under a fresh Install button.
 */
export function useInstallOutputLine(
  runtimeId: string,
  isInstalling: boolean,
): string | null {
  const [state, setState] = React.useState<InstallOutputState | null>(null);

  React.useEffect(() => {
    if (!isInstalling) {
      setState(null);
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const stop = await listen<InstallOutputEvent>(
          "acp-install-output",
          (event) => {
            if (cancelled) return;
            setState((current) =>
              nextInstallOutputLine(current, event.payload, runtimeId),
            );
          },
        );
        if (cancelled) {
          stop();
        } else {
          unlisten = stop;
        }
      } catch {
        // Event system unavailable (web/e2e) — the spinner shows alone.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isInstalling, runtimeId]);

  return state?.line ?? null;
}

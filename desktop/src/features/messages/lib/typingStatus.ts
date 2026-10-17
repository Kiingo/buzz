/**
 * Optional status carried in a kind:20002 typing indicator's content:
 * `{"v":1,"phase":"working"}`. Ephemeral only, never chat or timeline.
 *
 * An empty or unrecognised payload is an ordinary "is typing…" signal, so
 * senders and clients can adopt phases independently. `idle` ends the
 * sender's typing in that scope at once instead of waiting for the TTL.
 */
export type TypingPhase =
  | "starting"
  | "warming"
  | "reconnecting"
  | "working"
  | "typing"
  | "idle";

const KNOWN_PHASES: ReadonlySet<string> = new Set<TypingPhase>([
  "starting",
  "warming",
  "reconnecting",
  "working",
  "typing",
  "idle",
]);

/** Typing content is bounded on the relay; refuse anything larger here too. */
const MAX_TYPING_CONTENT_LENGTH = 512;

export function parseTypingPhase(
  content: string | undefined,
): TypingPhase | null {
  if (!content || content.length > MAX_TYPING_CONTENT_LENGTH) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const { v, phase } = value as { v?: unknown; phase?: unknown };
    return v === 1 && typeof phase === "string" && KNOWN_PHASES.has(phase)
      ? (phase as TypingPhase)
      : null;
  } catch {
    return null;
  }
}

/** The status-line verb phrase after the sender's name, e.g. "is starting up…". */
export function typingPhaseSentence(
  phase: TypingPhase | null | undefined,
): string {
  switch (phase) {
    case "starting":
      return "is starting up…";
    case "warming":
      return "is warming up a session…";
    case "reconnecting":
      return "is reconnecting…";
    case "working":
      return "is working…";
    default:
      return "is typing…";
  }
}

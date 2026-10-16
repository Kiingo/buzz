/**
 * Where an agent guest alert's "Review" goes, from its
 * `buzz-guest-alert-kind` tag (contracts §5.3).
 */

export type AlertDestination =
  | { type: "admin" }
  | { type: "agent"; tab: "requests" | "digest" }
  | null;

/** `null` means the alert is informational and has nothing to review. */
export function alertDestination(
  kind: string | null | undefined,
): AlertDestination {
  switch (kind) {
    case "daily_digest":
      return { type: "agent", tab: "digest" };
    case "requester_suspended":
    case "org_pattern":
      return { type: "admin" };
    case "agent_request_outcome":
      return null;
    default:
      // high_block, requester_rate_limited, budget_exhausted, and alerts
      // from routes that predate the kind tag.
      return { type: "agent", tab: "requests" };
  }
}

export function alertReviewLabel(destination: AlertDestination): string | null {
  if (!destination) return null;
  if (destination.type === "admin") return "Review in Settings";
  return destination.tab === "digest" ? "Open digest" : "Review requests";
}

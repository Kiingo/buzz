import type { GuestAdminAlert } from "./wire";

const REASON_TEXT: Record<string, string> = {
  two_high_flags_24h: "Two high-risk requests within 24 hours",
};

/** Plain-language reason for a suspension code. */
export function suspensionReasonText(reason: string): string {
  return REASON_TEXT[reason] ?? reason;
}

/** Plain-language line for one org-admin alert. */
export function adminAlertText(alert: GuestAdminAlert, name: string): string {
  const count = alert.count;
  if (alert.kind === "requester_suspended") {
    return `${name} can't ask anyone's agents anything until an admin restores access. Their requests were flagged high-risk${count ? ` ${count} times` : ""} in 24 hours.`;
  }
  if (alert.kind === "org_pattern") {
    if (alert.pattern === "flagged_across_owners") {
      return `${name} sent flagged requests to ${count ?? "several"} different people's agents in 24 hours.`;
    }
    if (alert.pattern === "approval_requests_across_agents") {
      return `${name} asked ${count ?? "many"} different agents for things that need their owner's approval in 24 hours.`;
    }
    return `Unusual pattern of requests from ${name}.`;
  }
  return "Something about agent guest access needs an admin's attention.";
}

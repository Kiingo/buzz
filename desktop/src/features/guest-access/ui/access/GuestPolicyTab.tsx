import { Switch } from "@/shared/ui/switch";

import { guestAccessApi } from "../../lib/client";
import type { EndpointStatus } from "../../lib/store";
import type { GuestOwnerAgent } from "../../lib/wire";
import { useOwnerMutation } from "../../ownerQueries";
import { MutationError, formatRelative } from "./shared";

/** Plain-language description of who reaches the agent, per access mode. */
export function respondToSummary(respondTo: string | null | undefined) {
  switch (respondTo) {
    case "anyone":
      return "Anyone in the community can ask. Their questions are answered through the hosted guest route, never on your Mac.";
    case "allowlist":
      return "The people you selected can ask. Their questions are answered through the hosted guest route, never on your Mac.";
    case "nobody":
      return "Nobody can ask, including you.";
    default:
      return "Only you and your own agents can ask. Other people get a short note that this agent only works for you.";
  }
}

/**
 * Default policy: who can ask (from "Who can send instructions"), whether
 * other people are answered through the hosted route or refused, and the
 * route's registration status for this agent.
 */
export function GuestPolicyTab({
  endpoint,
  endpointStatus,
  respondTo,
}: {
  endpoint: GuestOwnerAgent | null;
  endpointStatus: EndpointStatus | null;
  respondTo: string | null | undefined;
}) {
  const toggle = useOwnerMutation((enabled: boolean) =>
    guestAccessApi.setAgentEnabled(endpoint?.guestEndpointId ?? "", enabled),
  );
  const status = endpointStatus?.status ?? null;

  return (
    <div className="space-y-4" data-testid="guest-policy-tab">
      <section className="space-y-1">
        <h4 className="text-sm font-medium">Who can ask</h4>
        <p className="text-sm text-muted-foreground">
          {respondToSummary(respondTo)} Change this with “Who can send
          instructions” above.
        </p>
      </section>

      <section className="space-y-2 rounded-xl border border-border/60 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-medium">
              Answer other people through the hosted route
            </h4>
            <p className="text-sm text-muted-foreground">
              Replies use only what both you and the person asking can see.
              Anything only you can see waits for your approval. Turn this off
              to keep the agent owner-only: other people get a short note.
            </p>
          </div>
          <Switch
            aria-label="Answer other people through the hosted route"
            checked={endpoint?.enabled ?? false}
            data-testid="guest-policy-enabled"
            disabled={!endpoint || toggle.isPending}
            onCheckedChange={(checked) => toggle.mutate(checked)}
          />
        </div>
        {!endpoint ? (
          <p className="text-xs text-muted-foreground">
            {status === "owner_unlinked"
              ? "Link your account (Settings → Profile) so this agent can register for guest access."
              : status === "error"
                ? "The agent couldn't register for guest access. It retries automatically."
                : "This agent registers for guest access when it starts. Start it to manage this setting."}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Last seen {formatRelative(endpoint.lastSeenAt)}
            {endpointStatus?.classifierMode
              ? ` · safety check: ${endpointStatus.classifierMode === "enforce" ? "on" : "watching only"}`
              : ""}
          </p>
        )}
        <MutationError error={toggle.error} />
      </section>
    </div>
  );
}

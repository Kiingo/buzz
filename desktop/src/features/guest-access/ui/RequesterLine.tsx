import { FlaskConical, Link2, Link2Off } from "lucide-react";

import { Badge } from "@/shared/ui/badge";

import {
  linkedAgoLabel,
  requestCountLabel,
  requesterKindLabel,
  requesterLabel,
} from "../lib/copy";
import type { GuestRequester } from "../lib/wire";

/**
 * Who is asking, in one line: name, a TEST badge for seeded test identities,
 * how the route classified them, how long ago they linked, and whether this is
 * their first request. Every part beyond the name and link state is optional,
 * so older routes render exactly as before.
 */
export function RequesterLine({
  requester,
  nowMs,
}: {
  requester: GuestRequester;
  nowMs?: number;
}) {
  const name = requesterLabel(requester);
  const linkedAgo =
    requester.linked && requester.linkedAt
      ? linkedAgoLabel(requester.linkedAt, nowMs)
      : null;
  const details = [
    linkedAgo,
    requester.priorRequestCount !== null
      ? requestCountLabel(requester.priorRequestCount)
      : null,
    requester.viaAgentPubkey ? "asked through their agent" : null,
  ].filter((part): part is string => Boolean(part));
  const kind =
    requester.kind && requester.kind !== "test" && requester.kind !== "unlinked"
      ? requesterKindLabel(requester.kind)
      : null;

  return (
    <span
      className="inline-flex flex-wrap items-center gap-2"
      data-testid="guest-approval-requester"
    >
      <span className="font-medium">{name}</span>
      {requester.isTest ? (
        <Badge
          data-testid="guest-approval-requester-test"
          variant="destructive"
        >
          <FlaskConical aria-hidden className="mr-1 h-3 w-3" />
          TEST
        </Badge>
      ) : null}
      {kind ? (
        <Badge data-testid="guest-approval-requester-kind" variant="info">
          {kind}
        </Badge>
      ) : null}
      {requester.linked ? (
        <Badge variant="success">
          <Link2 aria-hidden className="mr-1 h-3 w-3" />
          Linked account
        </Badge>
      ) : (
        <Badge variant="warning">
          <Link2Off aria-hidden className="mr-1 h-3 w-3" />
          Not linked
        </Badge>
      )}
      {details.length > 0 ? (
        <span className="text-xs text-muted-foreground">
          {details.join(" · ")}
        </span>
      ) : null}
    </span>
  );
}

import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";

import {
  classifierReason,
  dataSourceLabel,
  outcomeLabel,
  outcomeTone,
  requesterLabel,
  scorePercent,
  tierLabel,
} from "../../lib/copy";
import { guestAccessApi } from "../../lib/client";
import type { GuestAccessLogEntry } from "../../lib/wire";
import {
  useOwnerAccessLog,
  useOwnerBlocks,
  useOwnerMutation,
} from "../../ownerQueries";
import { MutationError, QueryState, formatDate } from "./shared";

const TONE_VARIANT = {
  positive: "success",
  warning: "warning",
  danger: "destructive",
  neutral: "secondary",
} as const;

export function AccessLogRow({
  blocked,
  entry,
  onBlock,
  pending,
}: {
  blocked: boolean;
  entry: GuestAccessLogEntry;
  onBlock: () => void;
  pending: boolean;
}) {
  const scores = Object.entries(entry.classifier.topScores);
  return (
    <li className="space-y-1 py-3 text-sm" data-testid="guest-request-row">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{requesterLabel(entry.requester)}</span>
          {!entry.requester.linked ? (
            <Badge variant="outline">Not linked</Badge>
          ) : null}
          <Badge variant={TONE_VARIANT[outcomeTone(entry.outcome)]}>
            {outcomeLabel(entry.outcome)}
          </Badge>
          {tierLabel(entry.tier) ? (
            <span className="text-xs text-muted-foreground">
              {tierLabel(entry.tier)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {formatDate(entry.at)}
          </span>
          {entry.requester.pubkey ? (
            <Button
              data-testid="guest-request-block"
              disabled={pending || blocked}
              onClick={onBlock}
              size="xs"
              type="button"
              variant="ghost"
            >
              {blocked ? "Blocked" : "Block"}
            </Button>
          ) : null}
        </div>
      </div>
      {entry.questionText ? (
        <p className="whitespace-pre-wrap break-words rounded-md bg-muted/30 px-2 py-1 text-xs">
          “{entry.questionText}”
        </p>
      ) : null}
      {entry.dataSources.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Used: {entry.dataSources.map(dataSourceLabel).join(", ")}
        </p>
      ) : null}
      {entry.classifier.categories.length > 0 ? (
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {entry.classifier.categories.map((category) => (
            <li key={category}>{classifierReason(category)}</li>
          ))}
        </ul>
      ) : null}
      {scores.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Safety check {entry.classifier.route ?? ""}:{" "}
          {scores
            .map(
              ([name, score]) =>
                `${name.replace(/_/g, " ")} ${scorePercent(score)}`,
            )
            .join(" · ")}
        </p>
      ) : entry.classifier.route ? (
        <p className="text-xs text-muted-foreground">
          Safety check: {entry.classifier.route}
          {entry.classifier.severity ? ` (${entry.classifier.severity})` : ""}
        </p>
      ) : null}
    </li>
  );
}

/** Recent guest requests: who asked, the outcome, and classifier results. */
export function GuestRequestsTab({
  guestEndpointId,
}: {
  guestEndpointId: string | null;
}) {
  const log = useOwnerAccessLog(guestEndpointId, guestEndpointId !== null);
  const blocks = useOwnerBlocks();
  const block = useOwnerMutation((pubkey: string) =>
    guestAccessApi.block({ pubkey, guestEndpointId: null }),
  );
  const blocked = new Set((blocks.data ?? []).map((row) => row.pubkey));
  const entries = log.data?.items ?? [];

  return (
    <div data-testid="guest-requests-tab">
      <p className="text-sm text-muted-foreground">
        Questions other people asked this agent. Message text is kept only for
        blocked or high-risk requests, for 30 days.
      </p>
      <QueryState
        empty={entries.length === 0}
        emptyText={
          guestEndpointId
            ? "No guest requests yet."
            : "This agent hasn't registered for guest access yet."
        }
        error={log.error}
        isLoading={log.isLoading && guestEndpointId !== null}
        onRetry={() => void log.refetch()}
      >
        <ul className="divide-y divide-border/60">
          {entries.map((entry) => (
            <AccessLogRow
              blocked={blocked.has(entry.requester.pubkey)}
              entry={entry}
              key={entry.entryId}
              onBlock={() => block.mutate(entry.requester.pubkey)}
              pending={block.isPending}
            />
          ))}
        </ul>
      </QueryState>
      <MutationError error={block.error} />
    </div>
  );
}

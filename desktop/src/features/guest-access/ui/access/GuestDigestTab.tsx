import * as React from "react";

import { Input } from "@/shared/ui/input";

import { outcomeLabel, requesterLabel } from "../../lib/copy";
import type { GuestDigest } from "../../lib/wire";
import { defaultDigestDate, useOwnerDigest } from "../../ownerQueries";
import { QueryState } from "./shared";

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/60 px-3 py-2">
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

export function DigestSummary({ digest }: { digest: GuestDigest }) {
  const outcomes = Object.entries(digest.byOutcome).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-4" data-testid="guest-digest-summary">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Requests" value={digest.total} />
        <Stat label="Flagged" value={digest.flaggedRequests} />
        <Stat label="Waiting for you" value={digest.pendingApprovals} />
        <Stat label="Suggestions" value={digest.openSuggestions} />
      </div>
      {outcomes.length > 0 ? (
        <section>
          <h4 className="mb-1 text-sm font-medium">Outcomes</h4>
          <ul className="space-y-0.5 text-sm">
            {outcomes.map(([outcome, count]) => (
              <li className="flex justify-between" key={outcome}>
                <span>{outcomeLabel(outcome)}</span>
                <span className="tabular-nums text-muted-foreground">
                  {count}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {digest.byRequester.length > 0 ? (
        <section>
          <h4 className="mb-1 text-sm font-medium">Who asked</h4>
          <ul className="space-y-0.5 text-sm">
            {[...digest.byRequester]
              .sort((a, b) => b.count - a.count)
              .map((row) => (
                <li className="flex justify-between" key={row.pubkey}>
                  <span>{requesterLabel(row)}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {row.count}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Daily digest across all of your agents. */
export function GuestDigestTab() {
  const [date, setDate] = React.useState(defaultDigestDate);
  const digest = useOwnerDigest(date);

  return (
    <div className="space-y-3" data-testid="guest-digest-tab">
      <div className="flex items-center gap-2">
        <label
          className="text-sm text-muted-foreground"
          htmlFor="guest-digest-date"
        >
          Day (UTC)
        </label>
        <Input
          className="w-44"
          id="guest-digest-date"
          max={new Date().toISOString().slice(0, 10)}
          onChange={(event) => {
            if (event.target.value) setDate(event.target.value);
          }}
          type="date"
          value={date}
        />
      </div>
      <QueryState
        empty={false}
        emptyText=""
        error={digest.error}
        isLoading={digest.isLoading}
        onRetry={() => void digest.refetch()}
      >
        {digest.data ? (
          digest.data.total === 0 && digest.data.pendingApprovals === 0 ? (
            <p className="text-sm text-muted-foreground">
              No guest requests that day.
            </p>
          ) : (
            <DigestSummary digest={digest.data} />
          )
        ) : null}
      </QueryState>
    </div>
  );
}

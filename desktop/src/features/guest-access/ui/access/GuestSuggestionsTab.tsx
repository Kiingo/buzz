import { Button } from "@/shared/ui/button";

import { dataSourceLabel, scopeLabel } from "../../lib/copy";
import { guestAccessApi } from "../../lib/client";
import type { GuestSuggestion } from "../../lib/wire";
import { useOwnerMutation, useOwnerSuggestions } from "../../ownerQueries";
import { MutationError, QueryState } from "./shared";

/** "Always allow Jess on pipeline?" from a learned-grant suggestion. */
export function suggestionQuestion(suggestion: GuestSuggestion): string {
  const who = suggestion.grantee.displayName ?? "this person";
  const topic = suggestion.questionKind
    ? suggestion.questionKind.replace(/_/g, " ")
    : suggestion.dataSources.map(dataSourceLabel).join(", ") ||
      "these questions";
  const scope =
    suggestion.proposedScope === "always"
      ? "Always allow"
      : `${scopeLabel(suggestion.proposedScope)}:`;
  return `${scope} ${who} on ${topic}?`;
}

export function GuestSuggestionsTab({
  guestEndpointId,
}: {
  guestEndpointId: string | null;
}) {
  const suggestions = useOwnerSuggestions();
  const decide = useOwnerMutation((input: { id: string; accept: boolean }) =>
    guestAccessApi.decideSuggestion(input.id, input.accept),
  );
  const rows = (suggestions.data ?? []).filter(
    (row) =>
      row.guestEndpointId === null || row.guestEndpointId === guestEndpointId,
  );

  return (
    <div data-testid="guest-suggestions-tab">
      <p className="text-sm text-muted-foreground">
        Based on what you keep approving. Accepting creates a grant you can
        revoke any time.
      </p>
      <QueryState
        empty={rows.length === 0}
        emptyText="No suggestions right now."
        error={suggestions.error}
        isLoading={suggestions.isLoading}
        onRetry={() => void suggestions.refetch()}
      >
        <ul className="divide-y divide-border/60">
          {rows.map((row) => (
            <li
              className="flex items-center justify-between gap-3 py-3 text-sm"
              data-testid="guest-suggestion-row"
              key={row.suggestionId}
            >
              <div className="min-w-0">
                <p className="font-medium">{suggestionQuestion(row)}</p>
                <p className="text-xs text-muted-foreground">
                  You approved {row.approvalsCount} similar{" "}
                  {row.approvalsCount === 1 ? "request" : "requests"}.
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  disabled={decide.isPending}
                  onClick={() =>
                    decide.mutate({ id: row.suggestionId, accept: false })
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Dismiss
                </Button>
                <Button
                  data-testid="guest-suggestion-accept"
                  disabled={decide.isPending}
                  onClick={() =>
                    decide.mutate({ id: row.suggestionId, accept: true })
                  }
                  size="sm"
                  type="button"
                >
                  Allow
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </QueryState>
      <MutationError error={decide.error} />
    </div>
  );
}

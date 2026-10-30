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
      : `${scopeLabel(suggestion.proposedScope, suggestion.days)}:`;
  return `${scope} ${who} on ${topic}?`;
}

/**
 * The line under the question: who proposed it (an agent or your MCP client,
 * Kiingo 79 ruling 5), or how many similar requests you approved.
 */
export function suggestionDetail(suggestion: GuestSuggestion): string {
  if (suggestion.source === "agent_proposed") {
    const who =
      suggestion.proposedBy?.agentName ??
      (suggestion.proposedBy?.via === "mcp_client"
        ? "Your MCP client"
        : "Your agent");
    return `${who} proposed this. Nothing is shared until you allow it.`;
  }
  const count = suggestion.approvalsCount;
  return `You approved ${count} similar ${count === 1 ? "request" : "requests"}.`;
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
        Proposed by your agents, or based on what you keep approving. Accepting
        creates a grant you can revoke any time.
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
                  {suggestionDetail(row)}
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

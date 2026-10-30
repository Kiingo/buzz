import { Button } from "@/shared/ui/button";

import {
  grantSourcesLabel,
  questionKindWords,
  scopeLabel,
} from "../../lib/copy";
import { guestAccessApi } from "../../lib/client";
import type { GuestSuggestion } from "../../lib/wire";
import { useOwnerMutation, useOwnerSuggestions } from "../../ownerQueries";
import { MutationError, QueryState } from "./shared";

/**
 * "Always allow Jess for questions that need your calendar events?" from a
 * suggestion. Besides the grantee's name, the words come from fixed strings
 * and known codes; a crafted question kind or data source is quoted
 * (`questionKindWords`, `grantSourceLabel`). A thread proposal's question
 * (agent text) is never part of it and goes on its own quoted line
 * (`suggestionThreadQuote`).
 */
export function suggestionQuestion(suggestion: GuestSuggestion): string {
  const who = suggestion.grantee.displayName ?? "this person";
  const topic = suggestion.questionKind
    ? `for ${questionKindWords(suggestion.questionKind)}`
    : `on ${grantSourcesLabel(suggestion.dataSources) || "these questions"}`;
  if (suggestion.proposedScope === "always") {
    return `Always allow ${who} ${topic}?`;
  }
  if (suggestion.proposedScope === "question_kind" && suggestion.questionKind) {
    return `Allow ${who} ${topic}?`;
  }
  return `${suggestionScopeLabel(suggestion)}: ${who} ${topic}?`;
}

/**
 * The scope words for a suggestion row, fixed strings only. A list has no
 * "this thread": a thread proposal points at the quoted question under it
 * when there is one (`thread_question`), else names a short root id.
 */
export function suggestionScopeLabel(suggestion: GuestSuggestion): string {
  if (suggestion.proposedScope !== "thread") {
    return scopeLabel(suggestion.proposedScope, suggestion.days);
  }
  if (suggestion.threadQuestion) return "In the thread quoted below";
  return suggestion.threadRootEventId
    ? `In one thread (${suggestion.threadRootEventId.slice(0, 8)}…)`
    : "In one thread";
}

/** The visible label on a thread proposal's quoted question. */
export const THREAD_QUESTION_LABEL = "The question you were asked there:";

/** What a screen reader hears first on that line: it is quoted agent text. */
export const THREAD_QUESTION_SPOKEN =
  "Quoted agent text, not part of the grant.";

/**
 * A thread proposal's question, quoted: “When is the offsite?”. It is
 * agent-written text that can carry outside content (79
 * LOW-GRANT-ROW-THREAD-QUESTION-AGENT-TEXT), so it is already inert
 * (`inertLine`, wire.ts) and is shown on its own de-emphasized line, never
 * in the grant sentence. Null for any other scope or when none is on record.
 */
export function suggestionThreadQuote(
  suggestion: GuestSuggestion,
): string | null {
  if (suggestion.proposedScope !== "thread" || !suggestion.threadQuestion) {
    return null;
  }
  return `“${suggestion.threadQuestion}”`;
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

/**
 * The asked question under a thread proposal: labeled, quoted, italic and
 * muted, inside a blockquote whose first words for a screen reader say it is
 * quoted agent text.
 */
export function ThreadQuestionLine({
  suggestion,
}: {
  suggestion: GuestSuggestion;
}) {
  const quote = suggestionThreadQuote(suggestion);
  if (!quote) return null;
  return (
    <blockquote
      className="my-1 border-l-2 border-border pl-2 text-xs text-muted-foreground"
      data-testid="guest-suggestion-thread-question"
    >
      <span className="sr-only">{THREAD_QUESTION_SPOKEN} </span>
      <span>{THREAD_QUESTION_LABEL}</span>{" "}
      <span className="italic">{quote}</span>
    </blockquote>
  );
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
                <ThreadQuestionLine suggestion={row} />
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

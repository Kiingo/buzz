import { MessageSquareDashed } from "lucide-react";

/**
 * Inline stand-in for a thread root or ancestor that could not be loaded
 * (deleted, or no longer readable by this identity). It occupies the missing
 * message's slot instead of raising a page-level error, so the rest of the
 * thread reads normally.
 */
export function InboxUnavailableContextRow({ eventId }: { eventId: string }) {
  return (
    <div
      className="mx-4 mb-2 flex items-center gap-2 px-3 py-1.5 text-sm italic text-muted-foreground"
      data-event-id={eventId}
      data-testid="home-inbox-context-unavailable"
    >
      <MessageSquareDashed aria-hidden className="h-4 w-4 shrink-0" />
      <span>This message is unavailable. It may have been deleted.</span>
    </div>
  );
}

/**
 * Quiet notice when the thread's replies could not be fetched after a retry.
 * Whatever context is already known (cached channel window, the selected
 * message) still renders; this only offers another attempt.
 */
export function InboxRepliesLoadNotice({ onRetry }: { onRetry?: () => void }) {
  return (
    <div
      className="mx-4 mb-2 flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground"
      data-testid="home-inbox-context-replies-unavailable"
      role="status"
    >
      <span>Some replies couldn’t be loaded.</span>
      {onRetry ? (
        <button
          className="rounded font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="home-inbox-context-retry"
          onClick={onRetry}
          type="button"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

// Generated from the Kiingo surface renderer packages at 1055d96f74fb6ac27bf0ebcd3c7fa12aee50be9c; do not edit here.
import { useEffect, useId, useRef } from "react";
import type { SurfaceAction } from "../core";
import { useNodeContext } from "./context";
import { fieldClass, Spinner, SurfaceButton } from "./ui";
import { cn } from "./cn";

/**
 * The text box an ask_agent with `feedback` opens in the card, under the
 * control that holds it (Ross, 2026-11-02: "the "Ask agent to revise"
 * button should open up a text box below (within the card) where you can
 * give your feedback then you can click "Send Revision Request""). The
 * controller holds its state, so the inline card and the expanded view
 * share it. No length cap; empty words never go.
 */
export const FeedbackBox = ({
  actions,
}: {
  /** The actions of the control this box sits under. */
  actions: readonly SurfaceAction[];
}) => {
  const context = useNodeContext();
  const draft = context.snapshot.feedback;
  const action = draft
    ? actions.find((item) => item.id === draft.actionId)
    : undefined;
  const fieldId = useId();
  const errorId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const opened = draft?.phase === "editing" ? draft.actionId : undefined;
  useEffect(() => {
    if (opened) {
      field.current?.focus();
    }
  }, [opened]);
  if (!draft || !action?.feedback) {
    return null;
  }
  const { controller } = context;
  const agent = context.surface.agentName ?? "your agent";
  if (draft.phase === "sent") {
    return (
      <div
        role="status"
        className="flex w-full flex-col gap-1.5 rounded-md border border-border bg-muted/40 p-3"
      >
        <p className="text-sm font-medium text-foreground">Sent to {agent}.</p>
        {draft.sentText ? (
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {draft.sentText}
          </p>
        ) : null}
        <div>
          <SurfaceButton
            variant="plain"
            onClick={() => controller.closeFeedback()}
          >
            Done
          </SurfaceButton>
        </div>
      </div>
    );
  }
  const sending = draft.phase === "sending";
  const empty = draft.text.trim() === "";
  const send = () => void controller.sendFeedback();
  return (
    <div className="flex w-full flex-col gap-2 rounded-md border border-border p-3">
      <label htmlFor={fieldId} className="text-sm font-medium text-foreground">
        {action.feedback.label}
      </label>
      <textarea
        ref={field}
        id={fieldId}
        rows={3}
        value={draft.text}
        placeholder={action.feedback.placeholder}
        readOnly={sending}
        aria-invalid={draft.phase === "failed" || undefined}
        aria-describedby={draft.error ? errorId : undefined}
        onChange={(event) => controller.setFeedbackText(event.target.value)}
        onKeyDown={(event) => {
          // ⌘/Ctrl-Enter sends; Enter is a new line.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!empty && !sending) {
              send();
            }
          }
        }}
        className={cn(fieldClass, "min-h-[4.5rem] resize-y")}
      />
      {draft.phase === "failed" && draft.error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {draft.error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <SurfaceButton
          variant="primary"
          disabled={empty || sending}
          aria-busy={sending || undefined}
          onClick={send}
        >
          {sending ? <Spinner /> : null}
          <span>
            {sending
              ? "Sending…"
              : draft.phase === "failed"
                ? "Retry"
                : action.feedback.submitLabel}
          </span>
        </SurfaceButton>
        <SurfaceButton
          variant="plain"
          disabled={sending}
          onClick={() => controller.closeFeedback()}
        >
          Cancel
        </SurfaceButton>
      </div>
    </div>
  );
};

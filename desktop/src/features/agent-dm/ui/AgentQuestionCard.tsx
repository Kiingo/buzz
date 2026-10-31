import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Lock, Send } from "lucide-react";
import { toast } from "sonner";

import type { TimelineMessage } from "@/features/messages/types";
import { useIdentityQuery } from "@/shared/api/hooks";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import {
  ANSWER_OTHER_MAX,
  buildAnswerMessage,
  pickFor,
  sendsOnTap,
  setOtherText,
  toggleOption,
  toggleOther,
  type AnswerSelection,
} from "../lib/answer";
import {
  parseQuestion,
  type AgentQuestion,
  type AgentQuestionItem,
} from "../lib/markers";
import {
  getAgentDmStateVersion,
  isQuestionAnsweredLocally,
  markQuestionAnsweredLocally,
  subscribeAgentDmState,
} from "../lib/registry";
import { sendAgentDmTaggedMessage } from "../lib/send";

export type CardStatus = "open" | "answered" | "closed";

/** Answered beats open; a closing state event beats both. */
export function questionCardStatus(
  projected: TimelineMessage["agentDmQuestionState"],
  answeredLocally: boolean,
): CardStatus {
  if (projected === "closed") return "closed";
  if (projected === "answered" || answeredLocally) return "answered";
  return "open";
}

export function AgentQuestionCard({
  channelId,
  message,
}: {
  channelId: string;
  message: TimelineMessage;
}) {
  const question = React.useMemo(
    () => parseQuestion(message.tags),
    [message.tags],
  );
  const queryClient = useQueryClient();
  const senderPubkey = useIdentityQuery().data?.pubkey;
  React.useSyncExternalStore(
    subscribeAgentDmState,
    getAgentDmStateVersion,
    getAgentDmStateVersion,
  );
  if (!question) return null;

  return (
    <QuestionCardView
      onSend={async (answer) => {
        await sendAgentDmTaggedMessage({
          queryClient,
          channelId,
          senderPubkey,
          content: answer.content,
          markerTags: answer.tags,
        });
        markQuestionAnsweredLocally(message.id);
      }}
      question={question}
      status={questionCardStatus(
        message.agentDmQuestionState,
        isQuestionAnsweredLocally(message.id),
      )}
    />
  );
}

/**
 * The ask card itself: options, "Other" text and Send. The agent's own
 * questions answer with a DM message; a worker's ask (delegation board)
 * answers through the host. `title` replaces "Question", e.g.
 * "from worker: <title>".
 */
export function QuestionCardView({
  question,
  status,
  title,
  onSend,
}: {
  question: AgentQuestion;
  status: CardStatus;
  title?: string;
  onSend: (answer: { content: string; tags: string[][] }) => Promise<void>;
}) {
  const [selection, setSelection] = React.useState<AnswerSelection>({});
  const [sending, setSending] = React.useState(false);
  const titleId = React.useId();
  const locked = status !== "open" || sending;
  const immediate = sendsOnTap(question);

  const send = async (next: AnswerSelection) => {
    const answer = buildAnswerMessage(question, next);
    if (!answer || locked) return;
    setSending(true);
    try {
      await onSend(answer);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to send your answer.",
      );
    } finally {
      setSending(false);
    }
  };

  const onOption = (item: AgentQuestionItem, label: string) => {
    const next = toggleOption(selection, item, label);
    setSelection(next);
    if (immediate) void send(next);
  };

  const ready = buildAnswerMessage(question, selection) !== null;
  const showSend =
    !immediate ||
    pickFor(selection, question.items[0]?.qid ?? "").other !== null;

  return (
    <section
      aria-labelledby={titleId}
      className="mt-2 max-w-xl rounded-xl border border-border bg-muted/30 p-3"
      data-question-status={status}
      data-testid="agent-question-card"
    >
      <div className="flex items-center justify-between gap-2">
        <h4
          className="text-xs font-semibold text-muted-foreground"
          id={titleId}
        >
          {title ?? (question.items.length === 1 ? "Question" : "Questions")}
        </h4>
        {status === "open" ? null : (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-2xs font-medium text-muted-foreground"
            data-testid="agent-question-status"
          >
            {status === "answered" ? (
              <CircleCheck aria-hidden className="h-3 w-3" />
            ) : (
              <Lock aria-hidden className="h-3 w-3" />
            )}
            {status === "answered" ? "Answered" : "Closed"}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-col gap-3">
        {question.items.map((item, index) => {
          const pick = pickFor(selection, item.qid);
          const prefix = question.items.length > 1 ? `${index + 1}. ` : "";
          return (
            <fieldset className="min-w-0" disabled={locked} key={item.qid}>
              <legend className="text-sm font-medium text-foreground">
                {item.header ? (
                  <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {item.header}
                  </span>
                ) : null}
                {prefix}
                {item.question}
              </legend>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {item.options.map((option) => {
                  const selected = pick.labels.includes(option.label);
                  return (
                    <Button
                      aria-pressed={immediate ? undefined : selected}
                      className={cn(
                        "h-auto min-h-8 flex-col items-start whitespace-normal py-1.5 text-left",
                        selected && "border-primary bg-primary/10",
                      )}
                      key={option.label}
                      onClick={() => onOption(item, option.label)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <span>{option.label}</span>
                      {option.description ? (
                        <span className="text-2xs font-normal text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                    </Button>
                  );
                })}
                {item.allowOther ? (
                  <Button
                    aria-pressed={pick.other !== null}
                    className={cn(
                      pick.other !== null && "border-primary bg-primary/10",
                    )}
                    onClick={() => setSelection(toggleOther(selection, item))}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Other
                  </Button>
                ) : null}
              </div>
              {pick.other !== null ? (
                <Input
                  aria-label={`Your answer to: ${item.question}`}
                  className="mt-1.5 h-8 text-sm"
                  maxLength={ANSWER_OTHER_MAX}
                  onChange={(event) =>
                    setSelection(
                      setOtherText(selection, item, event.target.value),
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send(selection);
                    }
                  }}
                  placeholder="Type your answer"
                  value={pick.other}
                />
              ) : null}
            </fieldset>
          );
        })}
      </div>
      {showSend && status === "open" ? (
        <div className="mt-3 flex justify-end">
          <Button
            disabled={!ready || locked}
            onClick={() => void send(selection)}
            size="sm"
            type="button"
          >
            <Send aria-hidden />
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

// Generated from the Kiingo surface renderer packages at 5736645688767c7e713cc125961539139af6ba91; do not edit here.
import { useId, useState, type ReactNode } from "react";
import { formatDateText, sentRecipientsLine, type SentEmail } from "../core";
import { cn } from "./cn";
import { Glyphs } from "./icons";
import { toneText } from "./ui";

/**
 * A sent email card, collapsed (Ross, 2026-10-31: "once an email is sent can
 * we have its generative ui card be removed or collapsed to indicate that
 * it's sent?"): a check, "Sent", the recipients, the subject and the sent
 * time, all from the server's sent record (never the agent's words). The row
 * is a button that shows the card read-only below it: no Send, no edits.
 * Bcc shows only open; a dismissed or closed card is a plain Sent.
 */
export const SentEmailRow = ({
  sent,
  initiallyOpen = false,
  plain = false,
  children,
}: {
  sent: SentEmail;
  initiallyOpen?: boolean;
  /**
   * A dismissed or closed card: a plain "Sent", no recipients, subject or
   * body, and nothing to open (79 SHOULD-DISMISSED-SHOWS-BCC).
   */
  plain?: boolean;
  /** The card body, drawn read-only when open. */
  children: ReactNode;
}) => {
  const [open, setOpen] = useState(initiallyOpen);
  const bodyId = useId();
  if (plain) {
    return (
      <p
        className="flex items-center gap-2 text-sm text-muted-foreground"
        data-surface-sent=""
      >
        <Glyphs.success
          aria-hidden
          className={cn("h-4 w-4 shrink-0", toneText("success"))}
        />
        Sent
      </p>
    );
  }
  const time = sent.at ? formatDateText(sent.at) : undefined;
  // Bcc only open: the compact row never shows it (79), and the server
  // sends it to the sender alone.
  const recipients = sentRecipientsLine(sent, { bcc: open });
  const Chevron = open ? Glyphs.down : Glyphs.right;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={`Sent ${recipients}${sent.subject ? `, subject ${sent.subject}` : ""}${time ? `, ${time}` : ""}. ${open ? "Hide" : "Show"} what was sent`}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full min-w-0 items-start gap-2 rounded-md bg-muted/60 px-2.5 py-2 text-left",
          "transition-colors hover:bg-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        data-surface-sent=""
      >
        <Glyphs.success
          aria-hidden
          className={cn("mt-0.5 h-4 w-4 shrink-0", toneText("success"))}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className={cn("text-sm font-semibold", toneText("success"))}>
              Sent
            </span>
            {time ? (
              <span className="text-xs text-muted-foreground">{time}</span>
            ) : null}
          </span>
          <span className="break-words text-xs text-foreground">
            {recipients}
          </span>
          {sent.subject ? (
            <span className="break-words text-xs text-muted-foreground">
              {sent.subject}
            </span>
          ) : null}
        </span>
        <Chevron
          aria-hidden
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
        />
      </button>
      {open ? (
        <div id={bodyId} className="flex min-w-0 flex-col gap-2.5">
          {children}
        </div>
      ) : null}
    </div>
  );
};

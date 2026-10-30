// Generated from the Kiingo surface renderer packages at 7bc569bf4968cc5b06bdc6a9ea3b371d7d21efc7; do not edit here.
import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import {
  COPIED_LABEL,
  COPY_CONFIRM_MS,
  COPY_LABEL,
  copyableText,
  copyLabel,
} from "../core";
import { cn } from "./cn";

/**
 * Plain text to the clipboard (`text/plain` only). The async Clipboard API
 * first; where a host frame withholds it, a hidden textarea and the
 * selection copy, both inside the person's own click.
 */
export const copyToClipboard = async (text: string): Promise<boolean> => {
  const plain = copyableText(text);
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(plain);
      return true;
    }
  } catch {
    // Fall through to the selection copy.
  }
  if (typeof document === "undefined") {
    return false;
  }
  const area = document.createElement("textarea");
  area.value = plain;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
};

/**
 * The one copy control (Ross, 2026-10-29): "Copy <what>" for screen
 * readers, a brief "Copied" both shown and announced. Client-only: no spec
 * field or action reaches it, and it copies exactly the plain text shown.
 */
export const CopyButton = ({
  text,
  what,
  compact = false,
  className,
}: {
  /** The plain text the control copies (what the person sees). */
  text: string;
  /** "code", "Amount": completes the accessible name "Copy …". */
  what?: string;
  /** Icon only (KeyValue values, inputs); the name stays for screen readers. */
  compact?: boolean;
  className?: string;
}) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const Glyph = copied ? Check : Copy;
  return (
    <>
      <button
        type="button"
        aria-label={copied ? COPIED_LABEL : copyLabel(what)}
        title={copied ? COPIED_LABEL : copyLabel(what)}
        disabled={text.length === 0}
        onClick={() => {
          void copyToClipboard(text).then((ok) => setCopied(ok));
        }}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded text-2xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40",
          className,
        )}
      >
        <Glyph aria-hidden className="h-3.5 w-3.5" />
        {compact ? null : (
          <span aria-hidden>{copied ? COPIED_LABEL : COPY_LABEL}</span>
        )}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? COPIED_LABEL : ""}
      </span>
    </>
  );
};

/** An input box with its Copy control beside it (top-aligned for a text area). */
export const WithCopy = ({
  text,
  what,
  top = false,
  copyable = true,
  children,
}: {
  text: string;
  what: string;
  top?: boolean;
  /** The component's `copyable` (default on). */
  copyable?: boolean;
  children: ReactNode;
}) =>
  !copyable ? (
    <>{children}</>
  ) : (
    <div className={cn("flex gap-1.5", top ? "items-start" : "items-center")}>
      <div className="min-w-0 flex-1">{children}</div>
      <CopyButton
        text={text}
        what={what}
        compact
        className={top ? "mt-2" : undefined}
      />
    </div>
  );

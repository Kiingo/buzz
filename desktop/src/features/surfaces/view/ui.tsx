// Generated from the Kiingo surface renderer packages at c6609e08a498bb4161d453f1ac533d04f66d8bbc; do not edit here.
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ownEntry } from "../core";
import { cn } from "./cn";
import { CopyButton } from "./copy";
import { Glyphs } from "./icons";

// The app's own controls for surfaces. Colours come from the app's theme
// tokens only (§10.1: agents never set colours, CSS or HTML).

export type ToneName =
  | "default"
  | "muted"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "error";

/** Text colour for a tone. */
export const toneText = (tone: string | undefined): string => {
  switch (tone) {
    case "success":
      return "text-emerald-700";
    case "warning":
      return "text-amber-800";
    case "danger":
    case "error":
      return "text-destructive";
    case "info":
      return "text-sky-700";
    case "muted":
      return "text-muted-foreground";
    default:
      return "text-foreground";
  }
};

/** A quiet background for a tone (badges, callouts). */
export const toneSurface = (tone: string | undefined): string => {
  switch (tone) {
    case "success":
      return "bg-emerald-50 text-emerald-700";
    case "warning":
      return "bg-amber-50 text-amber-800";
    case "danger":
    case "error":
      return "bg-destructive/10 text-destructive";
    case "info":
      return "bg-sky-50 text-sky-700";
    case "muted":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-secondary text-secondary-foreground";
  }
};

export const ToneGlyph = ({
  tone,
  className,
}: {
  tone: string | undefined;
  className?: string;
}) => {
  const Icon =
    tone === "success"
      ? Glyphs.success
      : tone === "warning"
        ? Glyphs.warning
        : tone === "danger" || tone === "error"
          ? Glyphs.danger
          : Glyphs.info;
  return <Icon aria-hidden className={cn("h-4 w-4 shrink-0", className)} />;
};

export type ButtonStyle = "primary" | "secondary" | "destructive" | "plain";

const BUTTON_STYLES: Record<ButtonStyle, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary:
    "border border-border bg-background text-foreground hover:bg-muted",
  destructive:
    "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  plain: "text-primary hover:underline",
};

export type SurfaceButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonStyle;
  size?: "sm" | "md";
  fullWidth?: boolean;
};

export const SurfaceButton = forwardRef<HTMLButtonElement, SurfaceButtonProps>(
  (
    { variant = "secondary", size = "md", fullWidth, className, type, ...rest },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cn(
          "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          "disabled:cursor-not-allowed disabled:opacity-50",
          // Labels wrap and grow the button: a label is always drawn in
          // full (79 W6 parity #1), never clipped to one fixed-height line.
          "max-w-full whitespace-pre-wrap break-words text-left",
          variant === "plain"
            ? "px-1 py-0.5 text-sm"
            : size === "sm"
              ? "min-h-8 px-3 py-1 text-xs"
              : "min-h-9 px-3.5 py-1.5 text-sm",
          ownEntry(BUTTON_STYLES, variant) ?? BUTTON_STYLES.secondary,
          fullWidth && "w-full",
          className,
        )}
        {...rest}
      />
    );
  },
);

export const fieldClass = cn(
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground",
  "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  "disabled:cursor-not-allowed disabled:opacity-60",
);

export const Spinner = ({ className }: { className?: string }) => (
  <span
    aria-hidden
    className={cn(
      "inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent",
      className,
    )}
  />
);

/** A modal sheet (Modal, the expanded view, the run confirmation, an enlarged image). */
export const SurfaceDialog = ({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <Dialog.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col",
          "rounded-lg border border-border bg-background text-foreground shadow-lg focus:outline-none",
          wide ? "max-w-3xl" : "max-w-lg",
        )}
        {...(description ? {} : { "aria-describedby": undefined })}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
          <Dialog.Title className="text-base font-semibold">
            {title}
          </Dialog.Title>
          <Dialog.Close
            className="rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close"
          >
            <Glyphs.close aria-hidden className="h-4 w-4" />
          </Dialog.Close>
        </div>
        {description ? (
          <Dialog.Description className="sr-only">
            {description}
          </Dialog.Description>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>
        {footer ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </div>
        ) : null}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);

export type MenuEntry = {
  key: string;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  hint?: string;
  onSelect: () => void;
};

/** A "More" menu of actions. */
export const SurfaceMenu = ({
  label,
  entries,
  disabled,
}: {
  label: string;
  entries: MenuEntry[];
  disabled?: boolean;
}) => (
  <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild disabled={disabled}>
      <SurfaceButton variant="secondary" aria-label={label}>
        <Glyphs.more aria-hidden className="h-4 w-4" />
        <span>{label}</span>
      </SurfaceButton>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align="start"
        sideOffset={4}
        className="z-50 min-w-[10rem] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      >
        {entries.map((entry) => (
          <DropdownMenu.Item
            key={entry.key}
            disabled={entry.disabled}
            title={entry.hint}
            onSelect={entry.onSelect}
            className={cn(
              "cursor-default select-none rounded px-2 py-1.5 text-sm outline-none",
              "data-[highlighted]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
              entry.destructive && "text-destructive",
            )}
          >
            {entry.label}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
);

/** Outside material, always quoted (§10): a bar, the source, plain text. */
export const QuoteBox = ({
  text,
  source,
  copy = false,
}: {
  text: string;
  source?: string;
  /** A Copy control for the quoted words (Quote, outside Code). */
  copy?: boolean;
}) => (
  <figure className="flex gap-2">
    <span
      aria-hidden
      className="w-[3px] shrink-0 rounded bg-muted-foreground/40"
    />
    <div className="min-w-0 flex-1">
      <figcaption className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{source ? `Quoted from ${source}` : "Quoted"}</span>
        {copy ? <CopyButton text={text} what="quote" /> : null}
      </figcaption>
      <blockquote className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
        {text}
      </blockquote>
    </div>
  </figure>
);

/** Outside material inline (a table cell, a list row): a bar and plain text, never a link. */
export const QuotedText = ({ text }: { text: string }) => (
  <q
    className="inline-block border-l-[3px] border-muted-foreground/40 pl-1.5 text-xs text-muted-foreground before:content-none after:content-none"
    title="Quoted"
  >
    <span className="sr-only">Quoted: </span>
    <span className="whitespace-pre-wrap break-words">{text}</span>
  </q>
);

/**
 * Where a Table, List or Chart stops at the surface's cell budget (79 W6):
 * the rest is not drawn here.
 */
export const TooLargeRow = ({
  text = "The rest is too large to show here. Open it in Kiingo.",
}: {
  text?: string;
}) => (
  <p className="flex items-center gap-1.5 py-1.5 text-xs text-muted-foreground">
    <Glyphs.newer aria-hidden className="h-3.5 w-3.5 shrink-0" />
    {text}
  </p>
);

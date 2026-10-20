import * as React from "react";

import { cn } from "@/shared/lib/cn";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import {
  POPOVER_CUSTOM_ENTER_MOTION_CLASS,
  POPOVER_SHADOW_STYLE,
  POPOVER_SURFACE_CLASS,
} from "@/shared/ui/popoverSurface";

import type { AgentSlashCommand } from "../lib/slashCommands";
import type { UseAgentSlashCommandsResult } from "./useAgentSlashCommands";

function commandDescription(command: AgentSlashCommand) {
  return command.kind === "session"
    ? command.description || command.usage
    : command.description;
}

/**
 * The agent DM composer's "/" menu (Claude Code style). The editor keeps
 * focus and owns the keys (arrows move, Tab/Enter choose, Esc closes);
 * pointer users choose with a click. While the composer holds just a
 * skill's `/<name>`, its argument hint shows instead.
 */
export function AgentSlashCommandMenu({
  composerOwnsFocus,
  onChoose,
  slash,
}: {
  composerOwnsFocus: boolean;
  onChoose: (command: AgentSlashCommand) => void;
  slash: UseAgentSlashCommandsResult;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();
  const { argumentHint, isOpen, selectedIndex, suggestions } = slash;

  React.useEffect(() => {
    const active = listRef.current?.children[selectedIndex] as
      | HTMLElement
      | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // The confirm takes focus from the editor, so it renders regardless of
  // focus ownership; only the composer that opened it has one pending.
  const confirm = (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) slash.cancelPending();
      }}
      open={slash.pendingConfirm !== null}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Start a new session?</AlertDialogTitle>
          <AlertDialogDescription>
            The agent ends its current session. Your next message starts a fresh
            one.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={slash.confirmPending}>
            Start
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (slash.pendingConfirm) return confirm;
  if (!composerOwnsFocus) return null;
  if (!isOpen) {
    return argumentHint ? (
      <div className="absolute bottom-full left-0 right-0 z-50 mb-1 px-3 sm:px-4">
        <p
          className="inline-block rounded-lg bg-muted px-2 py-1 text-xs text-muted-foreground"
          data-testid="agent-slash-argument-hint"
        >
          {argumentHint}
        </p>
      </div>
    ) : null;
  }

  return (
    <div className="absolute bottom-full left-0 right-0 z-50 mb-1 px-3 sm:px-4">
      {/* The mousedown guard keeps a press on the list padding from blurring the editor, which owns keyboard interaction. */}
      <div
        aria-label="Commands"
        className={cn(
          "max-h-64 overflow-y-auto rounded-xl p-1 origin-bottom slide-in-from-bottom-1",
          POPOVER_CUSTOM_ENTER_MOTION_CLASS,
          POPOVER_SURFACE_CLASS,
        )}
        data-testid="agent-slash-menu"
        id={listId}
        onMouseDown={(event) => event.preventDefault()}
        ref={listRef}
        role="listbox"
        style={POPOVER_SHADOW_STYLE}
      >
        {suggestions.map((command, index) => {
          const description = commandDescription(command);
          return (
            <button
              aria-selected={index === selectedIndex}
              className={cn(
                "flex w-full cursor-pointer flex-col items-start rounded-lg px-3 py-1.5 text-left",
                index === selectedIndex
                  ? "bg-accent text-accent-foreground"
                  : "text-popover-foreground hover:bg-accent/50",
              )}
              data-command-kind={command.kind}
              key={`${command.kind}:${command.name}`}
              onMouseDown={(event) => {
                event.preventDefault();
                onChoose(command);
              }}
              role="option"
              tabIndex={-1}
              type="button"
            >
              <span className="flex items-baseline gap-2 text-sm">
                <span className="font-medium">/{command.name}</span>
                {command.kind === "skill" && command.argumentHint ? (
                  <span className="text-xs text-muted-foreground">
                    {command.argumentHint}
                  </span>
                ) : null}
              </span>
              {description ? (
                <span className="line-clamp-1 text-xs text-muted-foreground">
                  {description}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

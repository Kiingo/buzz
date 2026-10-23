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

import {
  SLASH_SECTION_LABELS,
  slashCommandSection,
  type SlashCommandSection,
} from "../lib/slashQuery";
import type {
  SlashMenuItem,
  UseAgentSlashCommandsResult,
} from "./useAgentSlashCommands";

function itemDescription(item: SlashMenuItem) {
  if (item.kind === "agent") return null;
  return item.kind === "session"
    ? item.description || item.usage
    : item.description;
}

function itemSection(item: SlashMenuItem): SlashCommandSection | "agents" {
  return item.kind === "agent" ? "agents" : slashCommandSection(item);
}

function sectionLabel(
  section: SlashCommandSection | "agents",
  targetLabel: string | null,
) {
  if (section === "agents") return "Choose an agent";
  // In a channel the agent's own skills are named after it.
  if (section === "agent-skills" && targetLabel) {
    return `Skills for @${targetLabel}`;
  }
  return SLASH_SECTION_LABELS[section];
}

/**
 * The composer's "/" menu (Claude Code style): sections for the session
 * commands, the agent's own skills and the other registry skills; in a
 * channel with several agents, first the agents to choose from.
 * The editor keeps focus and owns the keys (arrows move, Tab/Enter choose,
 * Esc closes); pointer users choose with a click. While the composer holds
 * just a skill's `/<name>`, its argument hint shows instead.
 */
export function AgentSlashCommandMenu({
  composerOwnsFocus,
  onChoose,
  slash,
}: {
  composerOwnsFocus: boolean;
  onChoose: (item: SlashMenuItem) => void;
  slash: UseAgentSlashCommandsResult;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();
  const { argumentHint, isOpen, selectedIndex, suggestions, targetLabel } =
    slash;

  React.useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(
      `[data-option-index="${selectedIndex}"]`,
    );
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
          "max-h-80 overflow-y-auto rounded-xl p-1 origin-bottom slide-in-from-bottom-1",
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
        {suggestions.map((item, index) => {
          const description = itemDescription(item);
          const section = itemSection(item);
          const previous = index > 0 ? suggestions[index - 1] : undefined;
          const startsSection = !previous || itemSection(previous) !== section;
          const secondary = item.kind === "skill" ? item.displayName : null;
          const key =
            item.kind === "agent"
              ? `agent:${item.pubkey}`
              : `${item.kind}:${item.name}`;
          return (
            <React.Fragment key={key}>
              {startsSection ? (
                <div
                  aria-hidden="true"
                  className="px-3 pb-0.5 pt-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground"
                  data-testid="agent-slash-section"
                  role="presentation"
                >
                  {sectionLabel(section, targetLabel)}
                </div>
              ) : null}
              <button
                aria-selected={index === selectedIndex}
                className={cn(
                  "flex w-full cursor-pointer flex-col items-start rounded-lg px-3 py-1.5 text-left",
                  index === selectedIndex
                    ? "bg-accent text-accent-foreground"
                    : "text-popover-foreground hover:bg-accent/50",
                )}
                data-command-kind={item.kind}
                data-command-source={
                  item.kind === "skill" ? item.source : undefined
                }
                data-option-index={index}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChoose(item);
                }}
                role="option"
                tabIndex={-1}
                type="button"
              >
                <span className="flex items-baseline gap-2 text-sm">
                  <span className="font-medium">
                    {item.kind === "agent" ? `@${item.label}` : `/${item.name}`}
                  </span>
                  {secondary ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {secondary}
                    </span>
                  ) : null}
                  {item.kind === "skill" && item.argumentHint ? (
                    <span className="text-xs text-muted-foreground">
                      {item.argumentHint}
                    </span>
                  ) : null}
                </span>
                {description ? (
                  <span className="line-clamp-1 text-xs text-muted-foreground">
                    {description}
                  </span>
                ) : null}
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

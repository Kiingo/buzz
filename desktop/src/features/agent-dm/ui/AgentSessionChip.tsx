import * as React from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";

import { useKnownAgentPubkeys } from "@/features/agents/useKnownAgentPubkeys";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

import {
  availableModes,
  changeSessionSetup,
  currentModelEfforts,
  effortLabel,
  ensureSessionSetup,
  getSessionSetup,
  getSessionSetupVersion,
  modeNote,
  setupChangeErrorSentence,
  setupChipText,
  speedFooter,
  speedRows,
  subscribeSessionSetup,
  takeSetupPickerRequest,
  vitalsLines,
  type SessionSetupPanel,
  type SetupChoice,
} from "../lib/sessionSetup";
import {
  ensureSessionBuiltins,
  getSessionViewsVersion,
  renameSession,
  requestSessionView,
  sessionViewErrorSentence,
  type SessionView,
  subscribeSessionViews,
  takeSessionViewRequest,
} from "../lib/sessionViews";
import { AgentRefPicker } from "./AgentRefPicker";
import { AgentSessionView } from "./AgentSessionView";

/** The header re-reads the panel this often while the DM shows. */
const REFRESH_MS = 60_000;

function ChoiceRow({
  disabled,
  label,
  onChoose,
  selected,
  testId,
}: {
  disabled: boolean;
  label: string;
  onChoose: () => void;
  selected: boolean;
  testId: string;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm",
        "hover:bg-accent focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-60",
      )}
      data-testid={testId}
      disabled={disabled || selected}
      onClick={onChoose}
      type="button"
    >
      <span className="min-w-0 truncate">{label}</span>
      {selected ? <Check aria-hidden className="h-3.5 w-3.5 shrink-0" /> : null}
    </button>
  );
}

/** Rename: one field. Saved empty, the session's own title shows again. */
function RenameRow({ agentPubkey }: { agentPubkey: string }) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const save = async () => {
    setSaving(true);
    try {
      toast.success(await renameSession(agentPubkey, draft ?? ""));
      setDraft(null);
    } catch (error) {
      toast.error(sessionViewErrorSentence(error));
    } finally {
      setSaving(false);
    }
  };
  if (draft === null) {
    return (
      <button
        className="w-full rounded-md px-2 py-1 text-left text-sm hover:bg-accent focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        data-testid="agent-session-rename"
        onClick={() => setDraft("")}
        type="button"
      >
        Rename
      </button>
    );
  }
  return (
    <form
      className="flex items-center gap-1 px-2 py-1"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Input
        aria-label="A name for this session"
        autoFocus
        className="h-7 min-w-0 flex-1 text-sm"
        data-testid="agent-session-rename-field"
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Empty clears the name"
        value={draft}
      />
      <Button disabled={saving} size="xs" type="submit">
        Save
      </Button>
      <Button
        disabled={saving}
        onClick={() => setDraft(null)}
        size="xs"
        type="button"
        variant="outline"
      >
        Cancel
      </Button>
    </form>
  );
}

function SetupPanelBody({
  agentPubkey,
  panel,
}: {
  agentPubkey: string;
  panel: SessionSetupPanel;
}) {
  const [saving, setSaving] = React.useState(false);
  const choose = async (choice: SetupChoice) => {
    setSaving(true);
    try {
      await changeSessionSetup(agentPubkey, choice);
    } catch (error) {
      toast.error(setupChangeErrorSentence(error));
    } finally {
      setSaving(false);
    }
  };
  const efforts = currentModelEfforts(panel);
  const modes = panel.canChangeMode ? availableModes(panel) : [];
  const note = modeNote(panel);
  const speeds = panel.canChangeSpeed ? speedRows(panel) : [];
  const lines = panel.vitals ? vitalsLines(panel.vitals) : [];
  return (
    <div className="flex flex-col gap-3" data-testid="agent-session-panel">
      <p className="text-sm font-medium">{panel.label}</p>
      {panel.canChangeHarness && panel.harnesses.length > 1 ? (
        <section aria-label="Harness" className="flex flex-col gap-0.5">
          <h3 className="px-2 text-xs text-muted-foreground">Harness</h3>
          {panel.harnesses.map((harness) => (
            <ChoiceRow
              disabled={saving || !harness.available}
              key={harness.id}
              label={harness.label}
              onChoose={() =>
                void choose({ harness: harness.id, model: null, effort: null })
              }
              selected={harness.id === panel.harness}
              testId={`agent-session-harness-${harness.id}`}
            />
          ))}
        </section>
      ) : null}
      {panel.canChangeModel && panel.models.length > 0 ? (
        <section aria-label="Model" className="flex flex-col gap-0.5">
          <h3 className="px-2 text-xs text-muted-foreground">Model</h3>
          {panel.models.map((model) => (
            <ChoiceRow
              disabled={saving}
              key={model.id}
              label={model.label}
              onChoose={() => void choose({ model: model.id })}
              selected={model.id === panel.model}
              testId={`agent-session-model-${model.id}`}
            />
          ))}
        </section>
      ) : null}
      {panel.canChangeEffort && efforts.length > 0 ? (
        <section aria-label="Reasoning" className="flex flex-col gap-0.5">
          <h3 className="px-2 text-xs text-muted-foreground">Reasoning</h3>
          {efforts.map((effort) => (
            <ChoiceRow
              disabled={saving}
              key={effort}
              label={effortLabel(panel, effort)}
              onChoose={() => void choose({ effort })}
              selected={effort === panel.effort}
              testId={`agent-session-effort-${effort}`}
            />
          ))}
        </section>
      ) : null}
      {speeds.length > 0 ? (
        <section aria-label="Speed" className="flex flex-col gap-0.5">
          <h3 className="px-2 text-xs text-muted-foreground">Speed</h3>
          {speeds.map((speed) => (
            <ChoiceRow
              disabled={saving || speed.note !== null}
              key={speed.id}
              label={speed.note ? `${speed.label}: ${speed.note}` : speed.label}
              onChoose={() =>
                void choose({
                  speed: speed.id === "standard" ? null : speed.id,
                })
              }
              selected={speed.selected}
              testId={`agent-session-speed-${speed.id}`}
            />
          ))}
          <p
            className="px-2 text-xs text-muted-foreground"
            data-testid="agent-session-speed-note"
          >
            {speedFooter(panel)}
          </p>
        </section>
      ) : null}
      {modes.length > 0 ? (
        <section aria-label="Mode" className="flex flex-col gap-0.5">
          <h3 className="px-2 text-xs text-muted-foreground">Mode</h3>
          {modes.map((mode) => (
            <ChoiceRow
              disabled={saving}
              key={mode.id}
              label={mode.label}
              onChoose={() => void choose({ mode: mode.id })}
              selected={mode.id === panel.mode}
              testId={`agent-session-mode-${mode.id}`}
            />
          ))}
        </section>
      ) : null}
      {note ? (
        <p
          className="px-2 text-xs text-muted-foreground"
          data-testid="agent-session-mode-note"
        >
          {note}
        </p>
      ) : null}
      {panel.canChangeModel ||
      panel.canChangeEffort ||
      speeds.length > 0 ||
      modes.length > 0 ? (
        <p className="px-2 text-xs text-muted-foreground">
          A change applies from the next turn.
        </p>
      ) : null}
      {lines.length > 0 ? (
        <ul
          className="flex flex-col gap-0.5 border-t border-border px-2 pt-2 text-xs text-muted-foreground"
          data-testid="agent-session-vitals"
        >
          {lines.map((line) => (
            <li className="break-words" key={line}>
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      <section
        aria-label="This session"
        className="flex flex-col gap-0.5 border-t border-border pt-2"
      >
        {SESSION_VIEW_ROWS.map((row) => (
          <button
            className="w-full rounded-md px-2 py-1 text-left text-sm hover:bg-accent focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
            data-testid={`agent-session-view-${row.id}`}
            key={row.id}
            onClick={() => requestSessionView(agentPubkey, row.view)}
            type="button"
          >
            {row.label}
          </button>
        ))}
        <RenameRow agentPubkey={agentPubkey} />
      </section>
    </div>
  );
}

/** The panel's read-only views of the session (BUZZPARITY B4). */
const SESSION_VIEW_ROWS: { id: string; label: string; view: SessionView }[] = [
  { id: "files", label: "Files changed", view: { kind: "files" } },
  {
    id: "agents",
    label: "Subagents and background tasks",
    view: { kind: "screen", screen: "agents" },
  },
  { id: "queued", label: "Queued messages", view: { kind: "queued" } },
];

/**
 * The DM header's line for the reader's session with a hosted agent, for
 * example "Claude Code · Opus 5.5 · High · 25%". It opens the session's
 * vitals and the model, reasoning, speed and mode picks; `/model`, `/effort`,
 * `/speed` and the vitals commands open it too. Nothing shows for an agent with no host.
 */
export function AgentSessionChip({
  agentPubkey,
  isAgentHint,
}: {
  agentPubkey: string;
  isAgentHint: boolean;
}) {
  const knownAgents = useKnownAgentPubkeys();
  const isAgent = isAgentHint || knownAgents.has(normalizePubkey(agentPubkey));
  React.useSyncExternalStore(
    subscribeSessionSetup,
    getSessionSetupVersion,
    getSessionSetupVersion,
  );
  React.useSyncExternalStore(
    subscribeSessionViews,
    getSessionViewsVersion,
    getSessionViewsVersion,
  );
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<SessionView | null>(null);

  React.useEffect(() => {
    if (!isAgent) return;
    void ensureSessionSetup(agentPubkey);
    void ensureSessionBuiltins(agentPubkey);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void ensureSessionSetup(agentPubkey);
      }
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [agentPubkey, isAgent]);

  const panel = isAgent ? getSessionSetup(agentPubkey) : null;
  // A `/model` or `/status` from the composer opens this panel.
  React.useEffect(() => {
    if (panel && takeSetupPickerRequest(agentPubkey)) setOpen(true);
  });
  // A view from the panel or from "/" (`/mcp`, `/diff` …) opens here.
  React.useEffect(() => {
    if (!panel) return;
    const asked = takeSessionViewRequest(agentPubkey);
    if (asked) {
      setOpen(false);
      setView(asked);
    }
  });
  // "/task" and "/project" need a host, not a session panel.
  const refPicker = isAgent ? (
    <AgentRefPicker agentPubkey={agentPubkey} />
  ) : null;
  if (!panel) return refPicker;

  const text = setupChipText(panel);
  return (
    <>
      {refPicker}
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <button
            aria-label={`Session: ${text}`}
            className="max-w-56 truncate rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
            data-testid="agent-session-chip"
            title={text}
            type="button"
          >
            {text}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-2">
          <SetupPanelBody agentPubkey={agentPubkey} panel={panel} />
        </PopoverContent>
      </Popover>
      <AgentSessionView
        agentPubkey={agentPubkey}
        onClose={() => setView(null)}
        view={view}
      />
    </>
  );
}

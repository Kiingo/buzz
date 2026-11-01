import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, ChevronRight } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import {
  loadDelegationGroupNotes,
  loadDelegationJournal,
} from "../lib/delegationStore";
import {
  type DelegationResultPreview,
  type GroupNote,
  JOURNAL_KIND_LABELS,
  type JournalEntry,
  previewDiffText,
  previewLinkLabel,
} from "../lib/delegations";

type Loaded<T> =
  | { status: "idle" | "loading" }
  | { status: "ready"; items: T[] }
  | { status: "error" };

/**
 * Reads `load` while `open`, again whenever `revision` changes (the board
 * moved), and drops a result that lands after a newer read or a close.
 */
function useOpenRead<T>(
  open: boolean,
  revision: string,
  load: () => Promise<T[]>,
): Loaded<T> {
  const [state, setState] = React.useState<Loaded<T>>({ status: "idle" });
  const loadRef = React.useRef(load);
  loadRef.current = load;
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is intentional — a moved board re-reads the open section even though the loader (through loadRef) does not use it
  React.useEffect(() => {
    if (!open) return;
    let current = true;
    setState((previous) =>
      previous.status === "ready" ? previous : { status: "loading" },
    );
    loadRef.current().then(
      (items) => {
        if (current) setState({ status: "ready", items });
      },
      () => {
        if (current) setState({ status: "error" });
      },
    );
    return () => {
      current = false;
    };
  }, [open, revision]);
  return state;
}

function Disclosure({
  label,
  testId,
  children,
  open,
  onToggle,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
  open: boolean;
  onToggle: () => void;
}) {
  const id = React.useId();
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div data-testid={testId}>
      <button
        aria-controls={id}
        aria-expanded={open}
        className="flex w-full items-center gap-1 py-1 text-left text-sm font-medium text-foreground hover:text-primary"
        onClick={onToggle}
        type="button"
      >
        {label}
        <Icon aria-hidden className="h-3.5 w-3.5" />
      </button>
      {open ? <div id={id}>{children}</div> : null}
    </div>
  );
}

function Status<T>({
  state,
  empty,
  children,
}: {
  state: Loaded<T>;
  empty: string;
  children: (items: T[]) => React.ReactNode;
}) {
  if (state.status === "error") {
    return (
      <p className="py-1 text-xs text-muted-foreground">
        Couldn’t load this. It tries again when the board changes.
      </p>
    );
  }
  if (state.status !== "ready") {
    return <p className="py-1 text-xs text-muted-foreground">Loading…</p>;
  }
  if (state.items.length === 0) {
    return <p className="py-1 text-xs text-muted-foreground">{empty}</p>;
  }
  return <>{children(state.items)}</>;
}

/**
 * "Plan": the orchestrator's journal (§16.6), its decisions, what it is
 * waiting on and its next step, newest first. Read when opened.
 */
export function DelegationPlanSection({
  agentPubkey,
  revision,
}: {
  agentPubkey: string;
  revision: string;
}) {
  const [open, setOpen] = React.useState(false);
  const state = useOpenRead<JournalEntry>(open, revision, () =>
    loadDelegationJournal(agentPubkey),
  );
  return (
    <Disclosure
      label="Plan"
      onToggle={() => setOpen((value) => !value)}
      open={open}
      testId="agent-delegation-plan"
    >
      <Status empty="No plan written yet." state={state}>
        {(entries) => (
          <ul className="flex flex-col gap-0.5 pb-1">
            {entries.map((entry) => (
              <li
                className="flex min-w-0 items-baseline gap-1.5 text-xs"
                key={entry.id}
              >
                <span className="shrink-0 font-medium text-foreground">
                  {JOURNAL_KIND_LABELS[entry.kind]}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-muted-foreground">
                  {entry.body}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Status>
    </Disclosure>
  );
}

/**
 * One parallel group's shared notes (§16.5): decisions, names and shas the
 * orchestrator and its workers wrote down, oldest first. Read when opened.
 */
export function DelegationGroupNotesSection({
  agentPubkey,
  group,
  revision,
  workerTitles,
}: {
  agentPubkey: string;
  group: string;
  revision: string;
  /** Worker titles by delegation id, to name a note's author. */
  workerTitles: ReadonlyMap<string, string>;
}) {
  const [open, setOpen] = React.useState(false);
  const state = useOpenRead<GroupNote>(open, revision, () =>
    loadDelegationGroupNotes(agentPubkey, group),
  );
  return (
    <Disclosure
      label={`Notes · ${group}`}
      onToggle={() => setOpen((value) => !value)}
      open={open}
      testId="agent-delegation-group-notes"
    >
      <Status empty="No notes in this group yet." state={state}>
        {(notes) => (
          <ul className="flex flex-col gap-0.5 pb-1">
            {notes.map((note) => (
              <li
                className="flex min-w-0 items-baseline gap-1.5 text-xs"
                key={note.id}
              >
                <span className="shrink-0 font-medium text-foreground">
                  {note.authorRole === "orchestrator"
                    ? "Orchestrator"
                    : (note.delegationId &&
                        workerTitles.get(note.delegationId)) ||
                      "Worker"}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-muted-foreground">
                  {note.body}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Status>
    </Disclosure>
  );
}

const PREVIEW_FILES_SHOWN = 5;

function PreviewLink({
  label,
  url,
  linkable,
}: {
  label: string;
  url: string;
  linkable: boolean;
}) {
  if (!linkable) {
    return (
      <span className="min-w-0 truncate" title={url}>
        {label}: {url}
      </span>
    );
  }
  return (
    <button
      aria-label={`Open the ${previewLinkLabel(label, url)}`}
      className="shrink-0 underline-offset-2 hover:text-foreground hover:underline"
      onClick={() =>
        void openUrl(url).catch(() => toast.error("Couldn’t open that link."))
      }
      title={url}
      type="button"
    >
      {previewLinkLabel(label, url)}
    </button>
  );
}

/**
 * The done card's results preview (§10.1): the diff summary, the first
 * files, the PR and the test receipt, as the worker reported them.
 */
export function DelegationResultPreviewView({
  preview,
}: {
  preview: DelegationResultPreview;
}) {
  const diff = previewDiffText(preview);
  const shown = preview.filesChanged.slice(0, PREVIEW_FILES_SHOWN);
  const total = preview.filesChangedCount ?? preview.filesChanged.length;
  const more = Math.max(0, total - shown.length);
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 pl-2 text-2xs text-muted-foreground"
      data-testid="agent-delegation-preview"
    >
      {diff || preview.prUrl || preview.testReceiptUrl ? (
        <div className="flex min-w-0 items-baseline gap-2">
          {diff ? <span className="shrink-0">{diff}</span> : null}
          {preview.prUrl ? (
            <PreviewLink
              label="PR"
              linkable={preview.prUrlLinkable}
              url={preview.prUrl}
            />
          ) : null}
          {preview.testReceiptUrl ? (
            <PreviewLink
              label="Tests"
              linkable={preview.testReceiptUrlLinkable}
              url={preview.testReceiptUrl}
            />
          ) : null}
        </div>
      ) : null}
      {shown.length > 0 ? (
        <p className="min-w-0 truncate font-mono" title={shown.join("\n")}>
          {shown.join(", ")}
          {more > 0 ? ` +${more} more` : ""}
        </p>
      ) : null}
    </div>
  );
}

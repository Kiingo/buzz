import * as React from "react";
import { toast } from "sonner";

import {
  AgentCallApiError,
  newIdempotencyKey,
} from "@/features/agent-call/lib/agentCallApi";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { invokeTauri } from "@/shared/api/tauri";
import { Textarea } from "@/shared/ui/textarea";

import {
  type ExportTurn,
  parseExportPage,
  readSessionExport,
  type SessionExport,
} from "../lib/sessionExport";
import {
  type FileChange,
  loadFileChanges,
  loadQueuedMessages,
  loadSessionScreen,
  loadSubagentPage,
  editQueuedMessage,
  type QueuedMessage,
  type RewindControl,
  type RewindScope,
  rewindRefusal,
  rewindSession,
  type SessionScreen,
  type SessionView,
  sessionViewErrorSentence,
  stopSessionTask,
  stopTaskErrorSentence,
  withdrawQueuedMessage,
} from "../lib/sessionViews";

type Read =
  | { kind: "screen"; screen: SessionScreen }
  | { kind: "files"; changes: FileChange[] }
  | { kind: "queued"; messages: QueuedMessage[] }
  | { kind: "export"; file: SessionExport }
  | { kind: "subagent"; turns: ExportTurn[]; olderCursor: string | null };

const VIEW_TITLE: Record<SessionView["kind"], string> = {
  screen: "Session",
  files: "Files changed",
  queued: "Queued messages",
  export: "Export conversation",
  subagent: "Subagent",
};

/** One page of a subagent, oldest turn first. A bad page is a failed read. */
async function readSubagentPage(
  agent: string,
  sessionId: string,
  before: string | null,
): Promise<{ turns: ExportTurn[]; olderCursor: string | null }> {
  const page = parseExportPage(
    await loadSubagentPage(agent, sessionId, before),
  );
  if (!page) throw new AgentCallApiError(null, "response_malformed");
  return {
    turns: page.turns,
    olderCursor: page.hasMore ? page.olderCursor : null,
  };
}

async function readView(agent: string, view: SessionView): Promise<Read> {
  switch (view.kind) {
    case "screen":
      return {
        kind: "screen",
        screen: await loadSessionScreen(agent, view.screen),
      };
    case "files":
      return { kind: "files", changes: await loadFileChanges(agent) };
    case "queued":
      return { kind: "queued", messages: await loadQueuedMessages(agent) };
    case "export":
      return { kind: "export", file: await readSessionExport(agent) };
    case "subagent":
      return {
        kind: "subagent",
        ...(await readSubagentPage(agent, view.sessionId, null)),
      };
  }
}

/** An Edit in progress: one key per text sent, so a retried Save is a replay. */
type Editing = {
  messageId: string;
  draft: string;
  sent: { text: string; key: string } | null;
};

/**
 * One read-only view of the reader's own session, opened from the panel or
 * "/": a screen, the files it changed, one of its subagents, or their own queued
 * messages (each with Edit and Withdraw). A failed read keeps what showed and says so; it never
 * shows as empty. Every word here is the session's or a tool's: plain text.
 */
export function AgentSessionView({
  agentPubkey,
  onClose,
  view: asked,
}: {
  agentPubkey: string;
  onClose: () => void;
  view: SessionView | null;
}) {
  // A subagent opened from the `agents` screen, with Back to that screen.
  const [child, setChild] = React.useState<SessionView | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new ask resets it
  React.useEffect(() => {
    setChild(null);
  }, [asked]);
  const view = asked ? (child ?? asked) : null;
  const [olderFailed, setOlderFailed] = React.useState<string | null>(null);
  const [read, setRead] = React.useState<Read | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [withdrawing, setWithdrawing] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<Editing | null>(null);
  const [saving, setSaving] = React.useState(false);
  const latest = React.useRef(0);

  const load = React.useCallback(async () => {
    if (!view) return;
    const ticket = latest.current + 1;
    latest.current = ticket;
    setLoading(true);
    setFailed(null);
    try {
      const next = await readView(agentPubkey, view);
      if (latest.current === ticket) setRead(next);
    } catch (error) {
      if (latest.current === ticket) setFailed(sessionViewErrorSentence(error));
    } finally {
      if (latest.current === ticket) setLoading(false);
    }
  }, [agentPubkey, view]);

  React.useEffect(() => {
    setRead(null);
    setOlderFailed(null);
    void load();
  }, [load]);

  const readOlder = async () => {
    if (read?.kind !== "subagent" || !read.olderCursor) return;
    if (view?.kind !== "subagent") return;
    setOlderFailed(null);
    try {
      const older = await readSubagentPage(
        agentPubkey,
        view.sessionId,
        read.olderCursor,
      );
      const shown = new Set(read.turns.map((turn) => turn.id));
      setRead({
        kind: "subagent",
        turns: [
          ...older.turns.filter((turn) => !shown.has(turn.id)),
          ...read.turns,
        ],
        olderCursor: older.olderCursor,
      });
    } catch (error) {
      setOlderFailed(sessionViewErrorSentence(error));
    }
  };

  const withdraw = async (messageId: string) => {
    setWithdrawing(messageId);
    try {
      await withdrawQueuedMessage(agentPubkey, messageId);
      toast.success("Withdrawn. It won't reach the session.");
      await load();
    } catch (error) {
      toast.error(sessionViewErrorSentence(error));
    } finally {
      setWithdrawing(null);
    }
  };

  /**
   * Save once: a failed Save keeps the editor and its key, so Save again is
   * the same edit. Taken meanwhile (409) says so and reloads; never resends.
   */
  const save = async () => {
    if (!editing || saving) return;
    const text = editing.draft;
    const key =
      editing.sent?.text === text ? editing.sent.key : newIdempotencyKey();
    setEditing({ ...editing, sent: { text, key } });
    setSaving(true);
    try {
      await editQueuedMessage(agentPubkey, editing.messageId, text, key);
      setEditing(null);
      toast.success("Edited. The session gets the new text.");
      await load();
    } catch (error) {
      toast.error(sessionViewErrorSentence(error));
      if (error instanceof AgentCallApiError && error.status === 409) {
        setEditing(null);
        await load();
      }
    } finally {
      setSaving(false);
    }
  };

  const title =
    read?.kind === "screen" && read.screen.title
      ? read.screen.title
      : view?.kind === "subagent"
        ? view.name
        : view
          ? VIEW_TITLE[view.kind]
          : "";
  return (
    <Dialog onOpenChange={(open) => (open ? null : onClose())} open={!!view}>
      <DialogContent
        className="max-h-[80vh] max-w-2xl overflow-y-auto"
        data-testid="agent-session-view"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {read?.kind === "screen" && read.screen.description
              ? read.screen.description
              : view?.kind === "subagent"
                ? "Read only: this subagent's messages and tool names, from your own session."
                : view?.kind === "export"
                ? "Saves your conversation with this agent as a file. Nothing is sent anywhere."
                : "Read only, from your own session with this agent."}
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <div className="flex items-center gap-2 text-sm" role="alert">
            <span>{failed}</span>
            <Button
              onClick={() => void load()}
              size="xs"
              type="button"
              variant="outline"
            >
              Try again
            </Button>
          </div>
        ) : null}
        {!read && loading ? (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            Loading…
          </p>
        ) : null}
        {child ? (
          <div>
            <Button
              onClick={() => setChild(null)}
              size="xs"
              type="button"
              variant="outline"
            >
              Back
            </Button>
          </div>
        ) : null}
        {read?.kind === "screen" ? (
          <ScreenBody
            agentPubkey={agentPubkey}
            onOpenSubagent={(sessionId, name) =>
              setChild({ kind: "subagent", sessionId, name })
            }
            onStopped={() => void load()}
            screen={read.screen}
          />
        ) : null}
        {read?.kind === "subagent" ? (
          <SubagentBody
            failed={olderFailed}
            onOlder={read.olderCursor ? () => void readOlder() : null}
            turns={read.turns}
          />
        ) : null}
        {read?.kind === "export" ? <ExportBody file={read.file} /> : null}
        {read?.kind === "files" ? <FilesBody changes={read.changes} /> : null}
        {read?.kind === "queued" ? (
          read.messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing of yours is waiting for this session.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {read.messages.map((message) => (
                <li
                  className="flex items-start gap-2 rounded-md border border-border p-2 text-sm"
                  data-testid="agent-session-queued"
                  key={message.messageId}
                >
                  <div className="min-w-0 flex-1">
                    {editing?.messageId === message.messageId ? (
                      <Textarea
                        aria-label="Edit your queued message"
                        autoFocus
                        className="min-h-20"
                        disabled={saving}
                        onChange={(event) =>
                          setEditing({ ...editing, draft: event.target.value })
                        }
                        value={editing.draft}
                      />
                    ) : (
                      <p className="whitespace-pre-wrap break-words">
                        {message.body}
                      </p>
                    )}
                    {message.idle ? (
                      <p className="text-xs text-muted-foreground">
                        Waits for the session to be idle.
                      </p>
                    ) : null}
                  </div>
                  {editing?.messageId === message.messageId ? (
                    <>
                      <Button
                        disabled={saving || !editing.draft.trim()}
                        onClick={() => void save()}
                        size="xs"
                        type="button"
                      >
                        Save
                      </Button>
                      <Button
                        disabled={saving}
                        onClick={() => setEditing(null)}
                        size="xs"
                        type="button"
                        variant="outline"
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        disabled={withdrawing !== null || editing !== null}
                        onClick={() =>
                          setEditing({
                            messageId: message.messageId,
                            draft: message.body,
                            sent: null,
                          })
                        }
                        size="xs"
                        type="button"
                        variant="outline"
                      >
                        Edit
                      </Button>
                      <Button
                        disabled={withdrawing !== null || editing !== null}
                        onClick={() => void withdraw(message.messageId)}
                        size="xs"
                        type="button"
                        variant="outline"
                      >
                        Withdraw
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ExportBody({ file }: { file: SessionExport }) {
  const [saving, setSaving] = React.useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const saved = await invokeTauri<boolean>("save_text_file", {
        text: file.markdown,
        filename: file.fileName,
      });
      if (saved) toast.success("Saved.");
    } catch {
      toast.error("Couldn't save the file. Try again.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span>
        {file.turns === 1 ? "1 turn" : `${file.turns} turns`} ready to save.
      </span>
      <Button
        disabled={saving}
        onClick={() => void save()}
        size="xs"
        type="button"
      >
        Save…
      </Button>
    </div>
  );
}

/** Stop on one task, with a question first. A request, never "stopped". */
function StopTaskButton({
  agentPubkey,
  onStopped,
  taskId,
  unavailable,
}: {
  agentPubkey: string;
  onStopped: () => void;
  taskId: string;
  unavailable: string | null;
}) {
  const [asking, setAsking] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const stop = async () => {
    setStopping(true);
    try {
      toast.success(await stopSessionTask(agentPubkey, taskId));
      onStopped();
    } catch (error) {
      toast.error(stopTaskErrorSentence(error));
    } finally {
      setStopping(false);
      setAsking(false);
    }
  };
  if (unavailable) {
    return <p className="text-xs text-muted-foreground">{unavailable}</p>;
  }
  return asking ? (
    <div className="mt-1 flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Stop this task?</span>
      <Button
        disabled={stopping}
        onClick={() => void stop()}
        size="xs"
        type="button"
      >
        Stop
      </Button>
      <Button
        disabled={stopping}
        onClick={() => setAsking(false)}
        size="xs"
        type="button"
        variant="outline"
      >
        Cancel
      </Button>
    </div>
  ) : (
    <Button
      className="mt-1"
      data-testid="agent-session-stop-task"
      onClick={() => setAsking(true)}
      size="xs"
      type="button"
      variant="outline"
    >
      Stop
    </Button>
  );
}

/** One subagent's conversation, oldest first: plain text, read only. */
function SubagentBody({
  failed,
  onOlder,
  turns,
}: {
  failed: string | null;
  onOlder: (() => void) | null;
  turns: ExportTurn[];
}) {
  return (
    <div className="flex flex-col gap-3">
      {failed ? (
        <p className="text-sm" role="alert">
          {failed}
        </p>
      ) : null}
      {onOlder ? (
        <div>
          <Button onClick={onOlder} size="xs" type="button" variant="outline">
            Older messages
          </Button>
        </div>
      ) : null}
      {turns.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Kiingo keeps no messages for this subagent yet.
        </p>
      ) : null}
      {turns.map((turn) => (
        <section
          className="flex flex-col gap-1 text-sm"
          data-testid="agent-session-subagent-turn"
          key={turn.id}
        >
          {turn.prompt ? (
            <p className="whitespace-pre-wrap break-words font-medium">
              {turn.prompt.text}
            </p>
          ) : null}
          {turn.omitted > 0 ? (
            <p className="text-xs text-muted-foreground">
              {`${turn.omitted} earlier steps not shown`}
            </p>
          ) : null}
          {turn.items.length > 0 ? (
            <ul className="flex flex-col text-xs text-muted-foreground">
              {turn.items.map((item, index) => (
                // Steps have no id; their order is the turn's.
                // biome-ignore lint/suspicious/noArrayIndexKey: read-only list
                <li className="break-words" key={index}>
                  {[item.action ?? item.name, item.line]
                    .filter(Boolean)
                    .join(" · ")}
                </li>
              ))}
            </ul>
          ) : null}
          {turn.reply ? (
            <p className="whitespace-pre-wrap break-words">{turn.reply.text}</p>
          ) : null}
        </section>
      ))}
    </div>
  );
}

const REWIND_SCOPE_LABEL: Record<RewindScope, string> = {
  conversation: "The conversation",
  files: "The code",
  both: "The conversation and the code",
};

/**
 * /rewind, as in the apps: pick what goes back, then confirm. The confirm says
 * the code is restored when the next message starts, with the edits since, and
 * that there's no undo for the code. How it came out is the chat's own line
 * after that message.
 */
function RewindButton({
  agentPubkey,
  control,
  edits,
  onDone,
}: {
  agentPubkey: string;
  control: RewindControl;
  edits: string | null;
  onDone: () => void;
}) {
  const key = React.useRef(newIdempotencyKey());
  const [open, setOpen] = React.useState(false);
  const [scope, setScope] = React.useState<RewindScope | null>(
    control.scopes[0] ?? null,
  );
  const [sending, setSending] = React.useState(false);
  const [refused, setRefused] = React.useState<string | null>(null);
  if (control.unavailable || control.scopes.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {control.unavailable ?? "Nothing here can go back."}
      </p>
    );
  }
  if (!open) {
    return (
      <Button
        className="mt-1"
        data-testid="agent-session-rewind"
        onClick={() => setOpen(true)}
        size="xs"
        type="button"
        variant="outline"
      >
        Go back to here
      </Button>
    );
  }
  const send = async () => {
    if (!scope) return;
    setSending(true);
    setRefused(null);
    try {
      toast.success(
        await rewindSession(agentPubkey, control, scope, key.current),
      );
      key.current = newIdempotencyKey();
      setOpen(false);
      onDone();
    } catch (error) {
      const refusal = rewindRefusal(error);
      if (refusal.readAgain) {
        key.current = newIdempotencyKey();
        toast.error(refusal.sentence);
        setOpen(false);
        onDone();
      } else {
        setRefused(refusal.sentence);
      }
    } finally {
      setSending(false);
    }
  };
  const restoresCode = scope === "files" || scope === "both";
  return (
    <form
      className="mt-1 flex flex-col gap-1 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        if (!sending) void send();
      }}
    >
      <fieldset className="flex flex-col gap-1">
        <legend className="text-muted-foreground">What goes back</legend>
        {control.scopes.map((option) => (
          <label className="flex items-center gap-1" key={option}>
            <input
              checked={scope === option}
              disabled={sending}
              name={`rewind-${control.turnIndex}`}
              onChange={() => setScope(option)}
              type="radio"
            />
            {REWIND_SCOPE_LABEL[option]}
          </label>
        ))}
      </fieldset>
      <p className="text-muted-foreground">
        {restoresCode
          ? `The code is restored when your next message starts${edits ? ` (${edits.toLowerCase()})` : ""}. There's no undo for the code.`
          : "Your next message continues from here. The code stays as it is."}
        {scope === "conversation" || scope === "both"
          ? " The later messages stay saved, and this session can be loaded again."
          : ""}
      </p>
      {refused ? <p role="alert">{refused}</p> : null}
      <div className="flex items-center gap-2">
        <Button disabled={!scope || sending} size="xs" type="submit">
          {sending ? "Going back…" : "Go back"}
        </Button>
        <Button
          disabled={sending}
          onClick={() => setOpen(false)}
          size="xs"
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ScreenBody({
  agentPubkey,
  onOpenSubagent,
  onStopped,
  screen,
}: {
  agentPubkey: string;
  onOpenSubagent: (sessionId: string, name: string) => void;
  onStopped: () => void;
  screen: SessionScreen;
}) {
  return (
    <div className="flex flex-col gap-3">
      {screen.sections.map((section) => (
        <section
          aria-label={section.title || undefined}
          className="flex flex-col gap-1"
          key={section.id}
        >
          {section.title ? (
            <h3 className="text-xs font-medium text-muted-foreground">
              {section.title}
            </h3>
          ) : null}
          {section.note ? (
            <p className="text-xs text-muted-foreground">{section.note}</p>
          ) : null}
          {section.unavailable ? (
            <p className="text-sm text-muted-foreground">
              Couldn't read this part of the session.
            </p>
          ) : section.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {section.empty ?? "Nothing here."}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {section.rows.map((row, index) => (
                <li
                  className="rounded-md bg-muted/50 px-2 py-1 text-sm"
                  // Rows have no id; their order is the screen's.
                  // biome-ignore lint/suspicious/noArrayIndexKey: read-only list
                  key={index}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={
                        row.mono ? "break-all font-mono text-xs" : "break-words"
                      }
                    >
                      {row.label}
                    </span>
                    {row.value ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {row.value}
                      </span>
                    ) : null}
                  </div>
                  {row.detail ? (
                    <p className="break-words text-xs text-muted-foreground">
                      {row.detail}
                    </p>
                  ) : null}
                  {row.body ? (
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
                      {row.body}
                    </pre>
                  ) : null}
                  {row.openSessionId ? (
                    <Button
                      className="mt-1"
                      data-testid="agent-session-open-subagent"
                      onClick={() =>
                        onOpenSubagent(row.openSessionId as string, row.label)
                      }
                      size="xs"
                      type="button"
                      variant="outline"
                    >
                      Open
                    </Button>
                  ) : null}
                  {row.rewind ? (
                    <RewindButton
                      agentPubkey={agentPubkey}
                      control={row.rewind}
                      edits={row.value}
                      onDone={onStopped}
                    />
                  ) : null}
                  {row.stopTaskId ? (
                    <StopTaskButton
                      agentPubkey={agentPubkey}
                      onStopped={onStopped}
                      taskId={row.stopTaskId}
                      unavailable={row.stopUnavailable}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

const SIGN_CLASS: Record<" " | "+" | "-", string> = {
  " ": "",
  "+": "text-green-700 dark:text-green-400",
  "-": "text-destructive",
};

function FilesBody({ changes }: { changes: FileChange[] }) {
  if (changes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No file changes in this session's recent work.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {changes.map((change) => (
        <li data-testid="agent-session-file" key={change.id}>
          <details>
            <summary className="cursor-pointer text-sm">
              <span className="break-all font-mono text-xs">
                {change.movedTo
                  ? `${change.path} → ${change.movedTo}`
                  : change.path}
              </span>{" "}
              <span className="text-xs text-muted-foreground">
                {`+${change.added} −${change.removed}`}
                {change.failed ? " · may not have applied" : ""}
              </span>
            </summary>
            <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">
              {change.lines.map((line, index) => (
                <div
                  className={SIGN_CLASS[line.sign]}
                  // biome-ignore lint/suspicious/noArrayIndexKey: diff lines
                  key={index}
                >
                  {`${line.sign} ${line.text}`}
                </div>
              ))}
            </pre>
          </details>
        </li>
      ))}
    </ul>
  );
}

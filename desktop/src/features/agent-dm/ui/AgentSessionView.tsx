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

import { readSessionExport, type SessionExport } from "../lib/sessionExport";
import {
  type FileChange,
  loadFileChanges,
  loadQueuedMessages,
  loadSessionScreen,
  editQueuedMessage,
  type QueuedMessage,
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
  | { kind: "export"; file: SessionExport };

const VIEW_TITLE: Record<SessionView["kind"], string> = {
  screen: "Session",
  files: "Files changed",
  queued: "Queued messages",
  export: "Export conversation",
};

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
 * "/": a screen, the files it changed, or their own queued messages (each
 * with Edit and Withdraw). A failed read keeps what showed and says so; it never
 * shows as empty. Every word here is the session's or a tool's: plain text.
 */
export function AgentSessionView({
  agentPubkey,
  onClose,
  view,
}: {
  agentPubkey: string;
  onClose: () => void;
  view: SessionView | null;
}) {
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
    void load();
  }, [load]);

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
        {read?.kind === "screen" ? (
          <ScreenBody
            agentPubkey={agentPubkey}
            onStopped={() => void load()}
            screen={read.screen}
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

function ScreenBody({
  agentPubkey,
  onStopped,
  screen,
}: {
  agentPubkey: string;
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

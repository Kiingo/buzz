// Generated from the Kiingo surface renderer packages at 23394ec833a81a2fb1d9cfb5c0a7fcc34cd1b948; do not edit here.
import { useEffect, useState } from "react";
import {
  WORK_VIEW_POLL_MS,
  isWorkActive,
  workAgentIds,
  workTreeNodes,
  workViewModel,
  workViewSource,
  type TreeNode,
  type WorkNode,
  type WorkViewModel,
} from "../core";
import { useNodeContext, type NodeProps } from "./context";
import { TreeRows } from "./outline";

// WorkView (GENUI-WORKVIEW, 2026-11-05): the workers on a task or in one
// orchestration chat, read through the host's `readWorkView` (the viewer's
// own session, the owner-only delegation reads; never data from the card)
// and re-read every WORK_VIEW_POLL_MS while any worker is still going,
// drawn with GENUI-TREE's TreeRows. A worker with a session opens it, and
// one the server named a Run on opens that Run too; nothing here is a
// surface action.

type Loaded =
  | { kind: "loading" }
  | { kind: "ready"; model: WorkViewModel; readAtMs: number }
  | { kind: "missing" }
  | { kind: "failed" };

/**
 * The workers as GENUI-TREE's `TreeRows` (surface-core `workTreeNodes`): a
 * row opens the worker's session, else its Run; a worker with both has an
 * "Open Run" row under it. Every worker branch starts open.
 */
const WorkTree = ({
  nodes,
  readAtMs,
  nowMs,
  names,
  label,
}: {
  nodes: WorkNode[];
  readAtMs: number;
  nowMs: number;
  names: ReadonlyMap<string, string>;
  label: string;
}) => {
  const { host } = useNodeContext();
  const openSession = host.openWorkerSession;
  const openRun = host.openWorkerRun;
  const tree = workTreeNodes(nodes, {
    names,
    readAtMs,
    nowMs,
    canOpenSession: openSession !== undefined,
    canOpenRun: openRun !== undefined,
  });
  const select = (node: TreeNode) => {
    const action = tree.actions.get(node.id);
    if (action?.kind === "session") {
      openSession?.({
        sessionId: action.sessionId,
        ...(action.agentId ? { agentId: action.agentId } : {}),
      });
    } else if (action?.kind === "run") {
      openRun?.(action.run);
    }
  };
  return (
    <TreeRows
      nodes={tree.nodes}
      expand="all"
      label={label}
      {...(tree.actions.size > 0 ? { onSelect: select } : {})}
    />
  );
};

export const WorkViewView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const read = context.host.readWorkView;
  const controller = context.controller;
  const source = workViewSource(component.props, context.surface.agentId);
  const key = source
    ? source.kind === "task"
      ? `task:${source.taskId}`
      : `thread:${source.agentId}:${source.threadId}`
    : "";
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());

  // Read now, then again every WORK_VIEW_POLL_MS while a worker is going.
  useEffect(() => {
    if (!source || !read) {
      return undefined;
    }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A chat's cards: the last page's rev, so an unchanged re-read costs the
    // server no card or Run work (79 LOW-79-WORKVIEW-RUN-READ-FANOUT).
    let rev: string | undefined;
    // Each read starts one interval after the last one started, so a
    // long-poll that waited does not add its wait to the interval.
    const again = (startedMs: number) => {
      timer = setTimeout(
        once,
        Math.max(0, startedMs + WORK_VIEW_POLL_MS - Date.now()),
      );
    };
    const once = () => {
      const startedMs = Date.now();
      read(source, abort.signal, rev)
        .then((answer) => {
          if (abort.signal.aborted) {
            return;
          }
          if (answer.kind === "missing") {
            setLoaded({ kind: "missing" });
            return;
          }
          if (answer.kind === "unchanged") {
            // Still going (only an active tree re-reads): keep the tree.
            again(startedMs);
            return;
          }
          const model =
            answer.kind === "json"
              ? workViewModel(source, answer.body)
              : undefined;
          if (!model) {
            // Keep the last good tree on a failed re-read.
            setLoaded((was) =>
              was.kind === "ready" ? was : { kind: "failed" },
            );
            again(startedMs);
            return;
          }
          rev = model.rev;
          setLoaded({ kind: "ready", model, readAtMs: Date.now() });
          if (model.active) {
            again(startedMs);
          }
        })
        .catch(() => {
          if (!abort.signal.aborted) {
            setLoaded((was) =>
              was.kind === "ready" ? was : { kind: "failed" },
            );
            again(startedMs);
          }
        });
    };
    setLoaded({ kind: "loading" });
    once();
    return () => {
      abort.abort();
      if (timer) {
        clearTimeout(timer);
      }
    };
    // `key` stands for `source`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, read]);

  // Running times tick each second while the tree has live workers.
  const live = loaded.kind === "ready" && loaded.model.active;
  useEffect(() => {
    if (!live) {
      return undefined;
    }
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [live]);

  // Agent names through the surface's batched ref lookup (79 W8).
  const agentIds =
    loaded.kind === "ready" ? [...workAgentIds(loaded.model.nodes)].sort() : [];
  const agentKey = agentIds.join(",");
  useEffect(() => {
    if (!agentKey) {
      return undefined;
    }
    let cancelled = false;
    for (const id of agentKey.split(",")) {
      void controller.resolveRefTitle({ type: "agent", id }).then((title) => {
        if (!cancelled && title) {
          setNames((was) => new Map(was).set(id, title));
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [controller, agentKey]);

  const title =
    context.text(component, "title", scope, 120) ??
    (loaded.kind === "ready" ? loaded.model.title : undefined) ??
    "Workers";
  const empty =
    context.text(component, "emptyText", scope, 200) ?? "No workers yet.";
  const running =
    loaded.kind === "ready"
      ? countWhere(loaded.model.nodes, (node) => isWorkActive(node.status))
      : 0;
  return (
    <section className="flex flex-col gap-1" aria-label={title}>
      <header className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate font-medium">{title}</span>
        {running > 0 ? (
          <span className="shrink-0 text-muted-foreground" aria-live="polite">
            {running} active
          </span>
        ) : null}
      </header>
      {!source ? (
        <p className="text-xs text-muted-foreground">No task or chat named.</p>
      ) : !read ? (
        <p className="text-xs text-muted-foreground">
          The live worker tree is in the Kiingo app.
        </p>
      ) : loaded.kind === "missing" ? (
        <p className="text-xs text-muted-foreground">Not shown to you.</p>
      ) : loaded.kind === "failed" ? (
        <p className="text-xs text-muted-foreground">
          The workers didn’t load. Trying again…
        </p>
      ) : loaded.kind === "loading" ? (
        <p className="text-xs text-muted-foreground">Loading the workers…</p>
      ) : loaded.model.nodes.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <WorkTree
          nodes={loaded.model.nodes}
          readAtMs={loaded.readAtMs}
          nowMs={nowMs}
          names={names}
          label={title}
        />
      )}
    </section>
  );
};

const countWhere = (
  nodes: readonly WorkNode[],
  test: (node: WorkNode) => boolean,
): number =>
  nodes.reduce(
    (sum, node) => sum + (test(node) ? 1 : 0) + countWhere(node.children, test),
    0,
  );

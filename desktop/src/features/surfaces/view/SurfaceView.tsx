// Generated from the Kiingo surface renderer packages at ecd20c86500467b7da9e4b33426b9a9ba379b523; do not edit here.
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  isKnownCatalog,
  isOver,
  acceptsEdits,
  acceptsTaps,
  openableUrl,
  ROOT,
  unknownTypes,
  urlHost,
  VIEW_ONLY_HINT,
  type ControllerSnapshot,
  type Intent,
  type MessageSend,
  type Pointer,
  type SurfaceController,
} from "../core";
import { cn } from "./cn";
import { ConfirmationDialog } from "./confirm";
import {
  NodeContext,
  NodeContextContext,
  useSurfaceSnapshot,
  type SurfaceMode,
} from "./context";
import {
  defaultIsOutside,
  SurfaceHostContext,
  useSurfaceHost,
  type SurfaceHost,
} from "./host";
import { Glyphs } from "./icons";
import { Node } from "./node";
import { SurfaceButton, SurfaceDialog, toneText, ToneGlyph } from "./ui";

/**
 * Which view of a controller shows its dialogs: the newest one mounted (the
 * expanded sheet over the inline card), so a confirmation or an outside-link
 * prompt never stacks twice (79 nit).
 */
const dialogViews = new WeakMap<SurfaceController, symbol[]>();
const dialogListeners = new Set<() => void>();

const useOwnsDialogs = (controller: SurfaceController): boolean => {
  const [me] = useState(() => Symbol("surface-view"));
  const [, redraw] = useState(0);
  useEffect(() => {
    const stack = dialogViews.get(controller) ?? [];
    dialogViews.set(controller, [...stack, me]);
    const listener = () => redraw((count) => count + 1);
    dialogListeners.add(listener);
    for (const notify of dialogListeners) {
      notify();
    }
    return () => {
      dialogListeners.delete(listener);
      dialogViews.set(
        controller,
        (dialogViews.get(controller) ?? []).filter((view) => view !== me),
      );
      for (const notify of dialogListeners) {
        notify();
      }
    };
  }, [controller, me]);
  const stack = dialogViews.get(controller) ?? [];
  return stack.length === 0 || stack[stack.length - 1] === me;
};

/**
 * A generative UI surface (§7.3), the same semantics as the Swift
 * `UiSurfaceView`: "from <agent>" and the title, the components, then the
 * server's status, the notice and the save line. Everything the agent wrote
 * is plain text in the app's own styles (§10).
 */
export const SurfaceView = ({
  controller,
  mode = "inline",
  host: hostProp,
  className,
}: {
  controller: SurfaceController;
  mode?: SurfaceMode;
  /** Defaults to the nearest `SurfaceHostContext`. */
  host?: SurfaceHost;
  className?: string;
}) => {
  const contextHost = useSurfaceHost();
  const host = hostProp ?? contextHost;
  const snapshot = useSurfaceSnapshot(controller);
  const [outsideUrl, setOutsideUrl] = useState<string | undefined>(undefined);
  const ownsDialogs = useOwnsDialogs(controller);
  const surface = snapshot.surface;

  const openLink = useCallback(
    (raw: string) => {
      const url = openableUrl(raw);
      if (!url) {
        return;
      }
      if ((host.isOutside ?? defaultIsOutside)(url)) {
        setOutsideUrl(url);
      } else {
        host.openUrl(url);
      }
    },
    [host],
  );

  const run = useCallback(
    (intent: Intent | undefined) => {
      if (!intent) {
        return;
      }
      switch (intent.kind) {
        case "sendMessage":
          // Exactly the drawn words, with the tap they came from (r3/r3b).
          host.sendMessage?.(intent.text, intent.tap);
          break;
        case "openEntity":
          if (
            host.openEntity &&
            host.canOpenEntity?.(intent.entity) !== false
          ) {
            host.openEntity(intent.entity);
          }
          break;
        case "openExpanded":
          host.openExpanded?.(controller.id);
          break;
        case "openUrl":
          openLink(intent.url);
          break;
      }
    },
    [controller, host, openLink],
  );

  const perform = useCallback(
    (actionId: string, scope: Pointer = ROOT) => {
      void controller.tap(actionId, scope).then(run);
    },
    [controller, run],
  );

  const sendMessage = useCallback(
    (send: MessageSend, actionId: string) => {
      run(controller.sendMessage(send, actionId));
    },
    [controller, run],
  );

  const context = useMemo(
    () =>
      new NodeContext(
        controller,
        snapshot,
        mode,
        host,
        perform,
        openLink,
        sendMessage,
      ),
    [controller, snapshot, mode, host, perform, openLink, sendMessage],
  );

  // Edits still in the debounce save when the view goes away.
  useEffect(() => () => void controller.saveNow(), [controller]);

  const agentName = surface.agentName ?? "your agent";
  const over = isOver(surface) && mode === "inline";
  const known = isKnownCatalog(surface);
  const collapsed = surface.display === "expanded" && mode === "inline";

  return (
    <SurfaceHostContext.Provider value={host}>
      <NodeContextContext.Provider value={context}>
        <section
          aria-label={surface.title || `Card from ${agentName}`}
          className={cn(
            "flex min-w-0 flex-col gap-2.5 text-foreground",
            className,
          )}
          data-surface-id={surface.id}
        >
          <header className="flex flex-col gap-0.5">
            <p className="text-xs text-muted-foreground">from {agentName}</p>
            {surface.title ? (
              <h3 className="text-sm font-semibold">{surface.title}</h3>
            ) : null}
          </header>
          {over ? (
            <p className="text-sm text-muted-foreground">
              {surface.state === "dismissed" ? "Dismissed" : "Closed"}
            </p>
          ) : !known ? (
            <NewerAppNotice webUrl={surface.webUrl} onOpen={openLink} />
          ) : collapsed ? (
            <SurfaceButton
              className="self-start"
              disabled={!host.openExpanded}
              aria-label={`Open ${surface.title || "this"} in full`}
              onClick={() => host.openExpanded?.(surface.id)}
            >
              Open
            </SurfaceButton>
          ) : (
            <>
              <SurfaceErrorBoundary webUrl={surface.webUrl} onOpen={openLink}>
                <Node componentId={surface.root} scope={ROOT} depth={0} />
              </SurfaceErrorBoundary>
              {unknownTypes(surface).length > 0 ? (
                <NewerAppNotice webUrl={surface.webUrl} onOpen={openLink} />
              ) : null}
            </>
          )}
          <Footer
            snapshot={snapshot}
            controller={controller}
            onRetry={(id) => perform(id, ROOT)}
            onOpen={openLink}
          />
        </section>
        {snapshot.confirmation && ownsDialogs ? (
          <ConfirmationDialog
            confirmation={snapshot.confirmation}
            onCancel={() => controller.cancelConfirmation()}
            onConfirm={() => void controller.confirm(snapshot.confirmation)}
          />
        ) : null}
        {outsideUrl ? (
          <SurfaceDialog
            open
            onOpenChange={(open) => {
              if (!open) {
                setOutsideUrl(undefined);
              }
            }}
            title={
              outsideUrl.startsWith("https://")
                ? `Open ${urlHost(outsideUrl) ?? "this link"}?`
                : "Open in Kiingo?"
            }
            description={outsideUrl}
            footer={
              <>
                <SurfaceButton onClick={() => setOutsideUrl(undefined)}>
                  Cancel
                </SurfaceButton>
                <SurfaceButton
                  variant="primary"
                  onClick={() => {
                    host.openUrl(outsideUrl);
                    setOutsideUrl(undefined);
                  }}
                >
                  {outsideUrl.startsWith("https://")
                    ? "Open in Browser"
                    : "Open"}
                </SurfaceButton>
              </>
            }
          >
            <p className="break-all text-sm text-muted-foreground">
              {outsideUrl}
            </p>
          </SurfaceDialog>
        ) : null}
      </NodeContextContext.Provider>
    </SurfaceHostContext.Provider>
  );
};

/**
 * One surface that fails to draw never takes the page with it (79 W4): it
 * says so, with Open on web, and the conversation around it keeps working.
 */
class SurfaceErrorBoundary extends Component<
  { webUrl?: string; onOpen: (url: string) => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }
    const { webUrl, onOpen } = this.props;
    return (
      <div className="flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground">
        <span className="flex-1">This card couldn’t be shown here.</span>
        {webUrl ? (
          <SurfaceButton
            variant="plain"
            className="text-xs"
            onClick={() => onOpen(webUrl)}
          >
            Open on web
          </SurfaceButton>
        ) : null}
      </div>
    );
  }
}

/** "This needs a newer app" plus Open on web (§7): never a blank or a crash. */
const NewerAppNotice = ({
  webUrl,
  onOpen,
}: {
  webUrl?: string;
  onOpen: (url: string) => void;
}) => (
  <div className="flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground">
    <Glyphs.newer aria-hidden className="h-3.5 w-3.5 shrink-0" />
    <span className="flex-1">
      Part of this needs a newer version of the app.
    </span>
    {webUrl ? (
      <SurfaceButton
        variant="plain"
        className="text-xs"
        onClick={() => onOpen(webUrl)}
      >
        Open on web
      </SurfaceButton>
    ) : null}
  </div>
);

const saveLine = (
  snapshot: ControllerSnapshot,
  note: string | undefined,
): string | undefined => {
  const state = snapshot.saveState;
  switch (state.kind) {
    case "saving":
      return "Saving…";
    case "saved":
      return note ?? "Saved";
    case "offline":
      return state.pending === 1
        ? "1 change waiting to save"
        : `${state.pending} changes waiting to save`;
    case "refused":
      return state.text;
    default:
      return note;
  }
};

const Footer = ({
  snapshot,
  controller,
  onRetry,
  onOpen,
}: {
  snapshot: ControllerSnapshot;
  controller: SurfaceController;
  onRetry: (actionId: string) => void;
  onOpen: (url: string) => void;
}) => {
  const surface = snapshot.surface;
  const webUrl = surface.webUrl;
  // A view-only host says so wherever the surface would take a change.
  const editsDisabled =
    controller.editsDisabled &&
    !isOver(surface) &&
    (acceptsEdits(surface) || acceptsTaps(surface));
  const status = surface.status;
  const retry =
    status?.retryable &&
    status.actionId &&
    surface.actions.has(status.actionId) &&
    acceptsTaps(surface) &&
    !controller.editsDisabled
      ? status.actionId
      : undefined;
  const line = saveLine(snapshot, controller.editedNote);
  if (!status && !snapshot.notice && !line && !editsDisabled) {
    return null;
  }
  return (
    <footer className="flex flex-col gap-1">
      {status ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className={cn(
              "inline-flex items-center gap-1",
              toneText(status.tone),
            )}
          >
            <ToneGlyph tone={status.tone} className="h-3.5 w-3.5" />
            {status.text}
          </span>
          {retry ? (
            <SurfaceButton
              variant="plain"
              className="text-xs"
              disabled={snapshot.busyActionId !== undefined}
              onClick={() => onRetry(retry)}
            >
              Retry
            </SurfaceButton>
          ) : null}
        </div>
      ) : null}
      {snapshot.notice ? (
        <p
          className="text-xs text-amber-800 dark:text-amber-300"
          role="status"
          aria-live="polite"
        >
          {snapshot.notice}
        </p>
      ) : null}
      {line ? <p className="text-2xs text-muted-foreground">{line}</p> : null}
      {editsDisabled && snapshot.notice !== VIEW_ONLY_HINT ? (
        <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
          <span>{VIEW_ONLY_HINT}</span>
          {webUrl ? (
            <SurfaceButton
              variant="plain"
              className="text-xs"
              onClick={() => onOpen(webUrl)}
            >
              Open in Kiingo
            </SurfaceButton>
          ) : null}
        </div>
      ) : null}
    </footer>
  );
};

/** The expanded view (a large sheet) of a surface, sharing the inline view's controller. */
export const SurfaceExpandedDialog = ({
  controller,
  open,
  onOpenChange,
  host,
}: {
  controller: SurfaceController;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host?: SurfaceHost;
}) => {
  const snapshot = useSurfaceSnapshot(controller);
  return (
    <SurfaceDialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={
        snapshot.surface.title ||
        `From ${snapshot.surface.agentName ?? "your agent"}`
      }
    >
      {open ? (
        <SurfaceView
          controller={controller}
          mode="expanded"
          {...(host ? { host } : {})}
        />
      ) : null}
    </SurfaceDialog>
  );
};

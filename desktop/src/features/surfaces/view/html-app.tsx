// Generated from the Kiingo surface renderer packages at dbc93b6d803e88e782fd6dbc8d7871827f2a9f7c; do not edit here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bindingOf,
  isDocumentFileId,
  openableUrl,
  type JsonValue,
  type Pointer,
} from "../core";
import { useNodeContext, type NodeProps } from "./context";
import { useExpandedViewOpen } from "./expanded-views";
import { SurfaceButton, SurfaceDialog } from "./ui";

// HtmlApp (GENUI-HTML, Ross 2026-11-05: "ability to render arbitrary html
// and js"; plan §10.2, 79 batch 7). The agent's page runs inline in the card,
// in an iframe on its own domain with `sandbox="allow-scripts"` (an opaque
// origin: no cookies, storage or same-origin reach into the app) and the
// server's CSP (no network). The page talks to the app only through the
// messages below, each checked here:
// - only from this frame's own window, with the opaque origin "null" (79 S2c);
// - nothing is sent or read once the frame loads a second document: the page
//   can navigate its own frame, and the new document must get nothing (S2b);
// - openLink, openFile and action always ask the person first, on the app's
//   own dialog, whose buttons take no click until it has come up (79 LOW: a
//   page can time an ask to land under the person's pointer) (Q3, Q6);
//   setValue is saved as the page's, never the person's (Q5, `pageEdit`).

/** Until the page reports its height: one short card. */
const START_HEIGHT = 160;
/** Inline, a tall page scrolls inside the frame so the chat stays usable. */
const INLINE_MAX_HEIGHT = "70vh";
/** Full screen fills most of the window under the frame header. */
const FULL_HEIGHT = "calc(100vh - 10rem)";
/**
 * After the ask dialog opens, its buttons wait this long before taking a
 * click: the dialog's own open animation is shorter, so a click already on
 * its way when the page asked lands before the buttons are live (the Apple
 * hosts wait the same).
 */
const ASK_ARM_MS = 500;
/** The HtmlApp origin's host (79's kiingo.io ruling O1). */
const PAGE_HOST = "pages.kiingo.io";

type PageAsk =
  | { kind: "link"; url: string }
  | { kind: "file"; fileId: string }
  | { kind: "action"; actionId: string; label: string };

type PageMessage = { kiingo: 1; op: string } & Record<string, unknown>;

const isPageMessage = (value: unknown): value is PageMessage =>
  typeof value === "object" &&
  value !== null &&
  (value as { kiingo?: unknown }).kiingo === 1 &&
  typeof (value as { op?: unknown }).op === "string";

/** Plain JSON only: a structured clone can carry Dates, Maps or buffers. */
const asJson = (value: unknown): JsonValue | undefined => {
  try {
    const text = JSON.stringify(value ?? null);
    return text === undefined ? undefined : (JSON.parse(text) as JsonValue);
  } catch {
    return undefined;
  }
};

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/u;

/**
 * The server's signed page URL: https on `PAGE_HOST` (port 443) under the
 * page path, with no user or password (79 LOW: pinned to the HtmlApp
 * origin, not any https host). Only an app itself running on loopback (a
 * local build) also takes an http loopback page from its local api.
 */
const pageSrc = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    const url = new URL(raw);
    const pinned =
      url.protocol === "https:" &&
      url.hostname === PAGE_HOST &&
      url.port === "";
    const local =
      url.protocol === "http:" &&
      LOOPBACK.test(url.hostname) &&
      typeof window !== "undefined" &&
      LOOPBACK.test(window.location.hostname);
    if (
      !(pinned || local) ||
      !url.pathname.startsWith("/ui-html/v1/") ||
      url.username ||
      url.password ||
      (typeof window !== "undefined" && url.origin === window.location.origin)
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
};

const themeNow = (): "light" | "dark" =>
  typeof document !== "undefined" &&
  document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";

export const HtmlAppView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const src = context.host.framesHtmlPages
    ? pageSrc(component.props.src)
    : undefined;
  const title = context.text(component, "title", scope) ?? "Page";
  const fallback = context.text(component, "fallback", scope) ?? "";
  const agentName = context.surface.agentName ?? "your agent";
  // While the card is open expanded or full screen, that view runs the page
  // and this inline one shows a line instead, so two copies never run at once
  // (both could setValue). On close a fresh frame loads the page again.
  const expandedOpen = useExpandedViewOpen(context.controller);
  if (src && expandedOpen && context.mode !== "expanded") {
    return (
      <figure className="flex flex-col gap-1">
        <figcaption className="text-xs">
          <span className="font-medium">{title}</span>
          <span className="text-muted-foreground">
            {" "}
            · page made by {agentName}
          </span>
        </figcaption>
        <p className="text-sm text-muted-foreground">
          This page is open in the larger view.
        </p>
      </figure>
    );
  }
  if (!src) {
    return (
      <figure className="flex flex-col gap-1">
        <figcaption className="text-xs">
          <span className="font-medium">{title}</span>
          <span className="text-muted-foreground">
            {" "}
            · page made by {agentName}
          </span>
        </figcaption>
        <p className="whitespace-pre-wrap text-sm">{fallback}</p>
        <p className="text-xs text-muted-foreground">
          This page can’t be shown here.
        </p>
      </figure>
    );
  }
  // A new signed URL (a new revision or an expired one re-signed) is a new
  // frame with a fresh load count.
  return (
    <HtmlAppFrame
      key={src}
      src={src}
      title={title}
      agentName={agentName}
      component={component}
      scope={scope}
    />
  );
};

const HtmlAppFrame = ({
  src,
  title,
  agentName,
  component,
  scope,
}: {
  src: string;
  title: string;
  agentName: string;
  component: NodeProps["component"];
  scope: Pointer;
}) => {
  const context = useNodeContext();
  const { controller, host } = context;
  const frame = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  const ready = useRef(false);
  const expiredAsked = useRef(false);
  const [moved, setMoved] = useState(false);
  const [reported, setReported] = useState<number | undefined>(undefined);
  const [ask, setAsk] = useState<PageAsk | undefined>(undefined);
  const [armed, setArmed] = useState(false);
  const askOpen = useRef(false);
  askOpen.current = ask !== undefined;

  // Every ask, a re-ask after Cancel included, starts unarmed.
  useEffect(() => {
    setArmed(false);
    if (!ask) {
      return;
    }
    const timer = setTimeout(() => setArmed(true), ASK_ARM_MS);
    return () => clearTimeout(timer);
  }, [ask]);

  const dataPointer = bindingOf(component.props.data, scope);
  const valuePointer = bindingOf(component.props.value, scope);
  const data = dataPointer ? (context.read(dataPointer) ?? null) : null;
  const dataText = useMemo(() => JSON.stringify(data), [data]);
  const mode = context.mode === "expanded" ? "fullscreen" : "inline";
  const fixedHeight = context.number(component, "height", scope);
  const aspect = context.string(component, "aspect");

  const post = useCallback((message: Record<string, unknown>) => {
    const target = frame.current?.contentWindow;
    if (!target || loads.current > 1) {
      return;
    }
    // The page's origin is opaque, so no target origin can name it; the
    // load count above keeps this off any other document (79 S2b).
    target.postMessage({ kiingo: 1, ...message }, "*");
  }, []);

  const latest = useRef({ dataText, mode });
  latest.current = { dataText, mode };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (
        !target ||
        event.source !== target ||
        event.origin !== "null" ||
        loads.current > 1 ||
        !isPageMessage(event.data)
      ) {
        return;
      }
      const message = event.data;
      switch (message.op) {
        case "ready":
          ready.current = true;
          post({
            op: "init",
            data: JSON.parse(latest.current.dataText) as JsonValue,
            mode: latest.current.mode,
            theme: themeNow(),
            locale:
              typeof navigator !== "undefined" ? navigator.language : "en",
          });
          return;
        case "resize": {
          const height = message.height;
          if (
            typeof height === "number" &&
            Number.isFinite(height) &&
            height > 0
          ) {
            setReported(Math.ceil(height));
          }
          return;
        }
        case "setValue": {
          const value = asJson(message.value);
          if (valuePointer && value !== undefined && controller.acceptsEdits) {
            controller.pageEdit(valuePointer, value);
          }
          return;
        }
        case "openLink": {
          const url = openableUrl(message.url);
          if (url && !askOpen.current) {
            setAsk({ kind: "link", url });
          }
          return;
        }
        case "openFile": {
          const fileId = message.fileId;
          if (
            typeof fileId === "string" &&
            isDocumentFileId(fileId) &&
            host.openFile &&
            !askOpen.current
          ) {
            setAsk({ kind: "file", fileId });
          }
          return;
        }
        case "action": {
          const actionId = message.actionId;
          if (
            typeof actionId === "string" &&
            controller.pageMayAsk(actionId) &&
            !askOpen.current
          ) {
            const action = context.action(actionId);
            setAsk({
              kind: "action",
              actionId,
              label: action?.label ?? "Ask the agent",
            });
          }
          return;
        }
        case "expired":
          // The signed URL ran out: fetch the card again for a new one.
          if (!expiredAsked.current) {
            expiredAsked.current = true;
            void controller.refreshForExpiredMedia();
          }
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [context, controller, host, post, valuePointer]);

  // New data or mode reach the page once it said it is ready.
  useEffect(() => {
    if (ready.current) {
      post({ op: "data", data: JSON.parse(dataText) as JsonValue });
    }
  }, [dataText, post]);
  useEffect(() => {
    if (ready.current) {
      post({ op: "mode", mode });
    }
  }, [mode, post]);

  const onLoad = () => {
    loads.current += 1;
    if (loads.current > 1) {
      // The page navigated its own frame (79 S2b): stop talking to it.
      ready.current = false;
      setMoved(true);
    }
  };

  const confirm = () => {
    const current = ask;
    if (!armed) {
      return;
    }
    setAsk(undefined);
    if (!current || loads.current > 1) {
      return;
    }
    switch (current.kind) {
      case "link":
        host.openUrl(current.url);
        return;
      case "file":
        host.openFile?.({
          files: [
            {
              fileId: current.fileId,
              name: "File",
              contentType: "application/octet-stream",
            },
          ],
          index: 0,
          surfaceId: context.surface.id,
          ...(context.surface.agentId
            ? { agentId: context.surface.agentId }
            : {}),
        });
        return;
      case "action":
        void controller.tapFromPage(current.actionId);
        return;
    }
  };

  const style =
    mode === "fullscreen"
      ? { height: FULL_HEIGHT }
      : fixedHeight !== undefined
        ? { height: `${fixedHeight}px` }
        : aspect
          ? { aspectRatio: aspect.replace(":", " / ") }
          : {
              height: `${reported ?? START_HEIGHT}px`,
              maxHeight: INLINE_MAX_HEIGHT,
            };

  const askText =
    ask?.kind === "link"
      ? `The page asks to open ${ask.url}`
      : ask?.kind === "file"
        ? "The page asks to open a Kiingo file."
        : ask?.kind === "action"
          ? `The page asks to run “${ask.label}”. ${agentName} gets the page’s values as data the page wrote.`
          : "";

  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate">
          <span className="font-medium">{title}</span>
          <span className="text-muted-foreground">
            {" "}
            · page made by {agentName}
          </span>
        </span>
      </figcaption>
      {moved ? (
        <div className="flex flex-col items-start gap-2 rounded-md border border-border p-3 text-sm">
          <p>This page tried to load something else, so it was stopped.</p>
          <SurfaceButton
            size="sm"
            onClick={() => {
              // A fresh frame from the signed URL (remounted by its key).
              void controller.refresh();
            }}
          >
            Reload the page
          </SurfaceButton>
        </div>
      ) : (
        <iframe
          ref={frame}
          src={src}
          title={`${title}, page made by ${agentName}`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          onLoad={onLoad}
          className="w-full rounded-md border border-border bg-background"
          style={style}
        />
      )}
      <SurfaceDialog
        open={ask !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setAsk(undefined);
          }
        }}
        title="The page is asking"
        footer={
          <>
            <SurfaceButton
              variant="secondary"
              disabled={!armed}
              onClick={() => setAsk(undefined)}
            >
              Cancel
            </SurfaceButton>
            <SurfaceButton
              variant="primary"
              disabled={!armed}
              onClick={confirm}
            >
              {ask?.kind === "action" ? "Run it" : "Open"}
            </SurfaceButton>
          </>
        }
      >
        <p className="break-words text-sm">{askText}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Made by {agentName}, not by Kiingo.
        </p>
      </SurfaceDialog>
    </figure>
  );
};

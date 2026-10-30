// Generated from the Kiingo surface renderer packages at 0d7eecf6d3b78f4c52514554faa33adb7a1fe131; do not edit here.
import { useState } from "react";
import {
  ownEntry,
  asInt,
  childrenOf,
  isObject,
  parsePointer,
  resolvePointer,
  surfaceProblems,
  type ChildRef,
  type JsonValue,
  type Pointer,
} from "../core";
import { cn } from "./cn";
import { gapClass, useNodeContext, type NodeProps } from "./context";
import { Glyphs } from "./icons";
import { ProxyImage } from "./media";
import { Children } from "./node";
import { ActionButton } from "./actions";
import { QuoteBox, SurfaceButton, SurfaceDialog } from "./ui";

// §4.1 Layout.

export const StackView = ({ component, scope, depth }: NodeProps) => {
  const context = useNodeContext();
  const children = context.children(component, scope);
  const horizontal = context.string(component, "direction") === "horizontal";
  const align = context.string(component, "align");
  const justify = context.string(component, "justify");
  const gap = gapClass(context.string(component, "gap"));
  if (horizontal) {
    return (
      <div
        className={cn(
          "flex min-w-0",
          // A row that doesn't fit wraps (narrow widths), as Swift falls back to a column.
          "flex-wrap",
          gap,
          align === "start"
            ? "items-start"
            : align === "end"
              ? "items-end"
              : align === "stretch"
                ? "items-stretch"
                : "items-center",
          justify === "center"
            ? "justify-center"
            : justify === "end"
              ? "justify-end"
              : justify === "spaceBetween"
                ? "justify-between"
                : "justify-start",
        )}
      >
        <Children refs={children} depth={depth} />
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        gap,
        align === "center"
          ? "items-center"
          : align === "end"
            ? "items-end"
            : align === "start"
              ? "items-start"
              : "items-stretch",
      )}
    >
      <Children refs={children} depth={depth} />
    </div>
  );
};

const GRID_COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 @md:grid-cols-2",
  3: "grid-cols-1 @md:grid-cols-2 @2xl:grid-cols-3",
  4: "grid-cols-1 @md:grid-cols-2 @2xl:grid-cols-4",
};

/** Columns that collapse to one when the surface is narrow (container queries). */
export const GridView = ({ component, scope, depth }: NodeProps) => {
  const context = useNodeContext();
  const columns = Math.min(
    4,
    Math.max(1, Math.round(context.number(component, "columns", scope) ?? 2)),
  );
  return (
    <div className="@container">
      <div
        className={cn(
          "grid",
          ownEntry(GRID_COLUMNS, columns),
          gapClass(context.string(component, "gap")),
        )}
      >
        <Children refs={context.children(component, scope)} depth={depth} />
      </div>
    </div>
  );
};

const Heading = ({ title, subtitle }: { title?: string; subtitle?: string }) =>
  title || subtitle ? (
    <div className="space-y-0.5">
      {title ? <h3 className="text-sm font-semibold">{title}</h3> : null}
      {subtitle ? (
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  ) : null;

export const SectionView = ({ component, scope, depth }: NodeProps) => {
  const context = useNodeContext();
  const title = context.text(component, "title", scope, 200);
  const subtitle = context.text(component, "subtitle", scope, 300);
  const [expanded, setExpanded] = useState<boolean | undefined>(undefined);
  const children = context.children(component, scope);
  if (context.flag(component, "collapsible", scope)) {
    const open = expanded ?? !context.flag(component, "collapsed", scope);
    const bodyId = context.domId(component, scope, "-body");
    return (
      <section className="space-y-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setExpanded(!open)}
          className="flex w-full items-start gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Glyphs.right
            aria-hidden
            className={cn(
              "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <Heading title={title ?? "Section"} subtitle={subtitle} />
        </button>
        {open ? (
          <div id={bodyId} className="flex flex-col gap-2 pl-5">
            <Children refs={children} depth={depth} />
          </div>
        ) : null}
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-2">
      <Heading title={title} subtitle={subtitle} />
      <Children refs={children} depth={depth} />
    </section>
  );
};

export const CardView = ({ component, scope, depth }: NodeProps) => {
  const context = useNodeContext();
  const media = component.props.media;
  const title = context.text(component, "title", scope, 200);
  const subtitle = context.text(component, "subtitle", scope, 300);
  const action = context.action(component.props.onTap);
  const titleOutside = context.isUntrusted(component, "title", scope);
  // A card that reads outside content is never an action, like a List row
  // (79 W6).
  const outside =
    titleOutside ||
    context.isUntrusted(component, "subtitle", scope) ||
    (isObject(media) &&
      (context.isUntrustedValue(media.url, scope) ||
        context.isUntrustedValue(media.alt, scope)));
  // A card shows no words to send, so its tap never sends (79 M1/W1).
  const tappable =
    action !== undefined &&
    !outside &&
    context.canTapSilently(action) &&
    !context.busy;
  const body = (
    <>
      {isObject(media) ? (
        <ProxyImage
          url={context.textOf(media.url, scope, 2048)}
          alt={context.textOf(media.alt, scope, 300) ?? ""}
          fit="cover"
          aspect={16 / 9}
          className="max-h-44"
        />
      ) : null}
      {titleOutside ? (
        <QuoteBox text={[title, subtitle].filter(Boolean).join("\n")} />
      ) : (
        <Heading
          title={title}
          subtitle={
            context.isUntrusted(component, "subtitle", scope)
              ? undefined
              : subtitle
          }
        />
      )}
      {!titleOutside &&
      subtitle &&
      context.isUntrusted(component, "subtitle", scope) ? (
        <QuoteBox text={subtitle} />
      ) : null}
      <Children
        refs={context.children(component, scope, "child")}
        depth={depth}
      />
    </>
  );
  const classes =
    "flex w-full flex-col gap-2 rounded-lg border border-border bg-card p-3 text-left text-card-foreground";
  if (tappable && action) {
    // A tappable card holds no other controls of its own (its child may).
    // Its accessible name comes from trusted fields only, never from the
    // child, which may read outside content (79 S1).
    return (
      <div
        role="button"
        tabIndex={0}
        title={action.label}
        aria-label={title ? `${title}, ${action.label}` : action.label}
        onClick={(event) => {
          if (
            (event.target as HTMLElement).closest(
              'button, a, input, select, textarea, [role="button"]',
            ) !== event.currentTarget
          ) {
            return;
          }
          context.perform(action.id, scope);
        }}
        onKeyDown={(event) => {
          if (
            event.target === event.currentTarget &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            context.perform(action.id, scope);
          }
        }}
        className={cn(
          classes,
          "cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {body}
      </div>
    );
  }
  return <div className={classes}>{body}</div>;
};

type Panel = { index: number; title: string; children: ChildRef[] };

const panelsOf = (
  items: JsonValue[],
  data: unknown,
  scope: Pointer,
  textOf: (prop: unknown) => string | undefined,
): Panel[] =>
  items.slice(0, 20).map((item, index) => ({
    index,
    title:
      (isObject(item) ? textOf(item.title) : undefined) ?? `Tab ${index + 1}`,
    children: childrenOf(isObject(item) ? item.child : undefined, data, scope),
  }));

/** A selection bound to a path (an edit, so it syncs) or kept on screen only. */
const useIndexBinding = (
  prop: unknown,
  scope: Pointer,
  count: number,
): [number, (next: number) => void] => {
  const context = useNodeContext();
  const [local, setLocal] = useState(0);
  const pointer =
    isObject(prop) && typeof prop.path === "string"
      ? resolvePointer(prop.path, scope)
      : undefined;
  const clamp = (value: number) =>
    Math.min(Math.max(0, value), Math.max(0, count - 1));
  if (!pointer || !context.acceptsEdits) {
    return [clamp(local), setLocal];
  }
  return [
    clamp(asInt(context.read(pointer)) ?? 0),
    (next) => context.edit(pointer, next),
  ];
};

export const TabsView = ({ component, scope, depth }: NodeProps) => {
  const context = useNodeContext();
  const panels = panelsOf(
    context.list(component, "items", scope),
    context.data,
    scope,
    (prop) => context.textOf(prop, scope, 80),
  );
  const [selected, select] = useIndexBinding(
    component.props.selected,
    scope,
    panels.length,
  );
  const baseId = context.domId(component, scope);
  if (panels.length === 0) {
    return null;
  }
  const current = panels[selected];
  return (
    <div className="flex flex-col gap-3">
      <div
        role="tablist"
        className="flex flex-wrap gap-1 rounded-md bg-muted p-1"
      >
        {panels.map((panel) => (
          <button
            key={panel.index}
            type="button"
            role="tab"
            id={`${baseId}-tab-${panel.index}`}
            aria-selected={panel.index === selected}
            aria-controls={`${baseId}-panel`}
            tabIndex={panel.index === selected ? 0 : -1}
            onClick={() => select(panel.index)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                const next =
                  (selected +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    panels.length) %
                  panels.length;
                select(next);
              }
            }}
            className={cn(
              "rounded px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              panel.index === selected
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground",
            )}
          >
            {panel.title}
          </button>
        ))}
      </div>
      {current ? (
        <div
          role="tabpanel"
          id={`${baseId}-panel`}
          aria-labelledby={`${baseId}-tab-${current.index}`}
          className="flex flex-col gap-2"
        >
          <Children refs={current.children} depth={depth} />
        </div>
      ) : null}
    </div>
  );
};

export const AccordionView = ({ component, scope, depth }: NodeProps) => {
  const context = useNodeContext();
  const panels = panelsOf(
    context.list(component, "items", scope),
    context.data,
    scope,
    (prop) => context.textOf(prop, scope, 80),
  );
  const multiple = context.string(component, "mode") === "multiple";
  const [local, setLocal] = useState<number[]>([]);
  const prop = component.props.open;
  const pointer =
    context.acceptsEdits && isObject(prop) && typeof prop.path === "string"
      ? resolvePointer(prop.path, scope)
      : undefined;
  const bound = pointer ? context.read(pointer) : undefined;
  const open: number[] = pointer
    ? Array.isArray(bound)
      ? bound
          .map((value) => asInt(value))
          .filter((value): value is number => value !== undefined)
      : asInt(bound) !== undefined
        ? [asInt(bound)!]
        : []
    : local;
  const setOpen = (next: number[]) => {
    const sorted = [...new Set(next)].sort((a, b) => a - b);
    if (pointer) {
      context.edit(pointer, sorted);
    } else {
      setLocal(sorted);
    }
  };
  const baseId = context.domId(component, scope);
  return (
    <div className="divide-y divide-border rounded-md border border-border">
      {panels.map((panel) => {
        const isOpen = open.includes(panel.index);
        return (
          <div key={panel.index}>
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={`${baseId}-${panel.index}`}
              onClick={() =>
                setOpen(
                  isOpen
                    ? open.filter((index) => index !== panel.index)
                    : multiple
                      ? [...open, panel.index]
                      : [panel.index],
                )
              }
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span>{panel.title}</span>
              <Glyphs.down
                aria-hidden
                className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform",
                  isOpen && "rotate-180",
                )}
              />
            </button>
            {isOpen ? (
              <div
                id={`${baseId}-${panel.index}`}
                className="flex flex-col gap-2 px-3 pb-3"
              >
                <Children refs={panel.children} depth={depth} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

export const CarouselView = ({ component, scope, depth }: NodeProps) => {
  const context = useNodeContext();
  const width =
    context.string(component, "itemWidth") === "compact" ? "w-52" : "w-72";
  return (
    <div
      className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2"
      role="list"
    >
      {context.children(component, scope).map((child) => (
        <div
          key={child.key}
          role="listitem"
          className={cn("shrink-0 snap-start", width)}
        >
          <Children refs={[child]} depth={depth} />
        </div>
      ))}
    </div>
  );
};

export const StepsView = ({ component, scope, depth }: NodeProps) => {
  const context = useNodeContext();
  const steps = context.list(component, "steps", scope).slice(0, 20);
  const [index, setIndex] = useIndexBinding(
    component.props.current,
    scope,
    steps.length,
  );
  if (steps.length === 0) {
    return null;
  }
  const step = steps[index];
  const record = isObject(step) ? step : {};
  const title = context.textOf(record.title, scope, 120);
  const finish = context.action(component.props.finishAction);
  // Every step's required paths. A host that can't take edits lets the
  // person read every step, but its finish acts only when they all hold
  // (79): otherwise it is not drawn.
  const allPaths = steps.flatMap((item) => {
    const raw = isObject(item) ? item.validate : undefined;
    return Array.isArray(raw)
      ? raw
          .map((path) =>
            typeof path === "string"
              ? (resolvePointer(path, scope) ?? parsePointer(path))
              : undefined,
          )
          .filter((path): path is Pointer => Boolean(path))
      : [];
  });
  const finishReady =
    !context.controller.editsDisabled ||
    allPaths.length === 0 ||
    surfaceProblems(context.surface, context.data, allPaths).size === 0;
  const next = () => {
    const raw = record.validate;
    const paths = Array.isArray(raw)
      ? raw
          .map((path) =>
            typeof path === "string"
              ? (resolvePointer(path, scope) ?? parsePointer(path))
              : undefined,
          )
          .filter((path): path is Pointer => Boolean(path))
      : undefined;
    // A view-only host can't fill the step's inputs, so it doesn't hold the
    // person on them: they read every step.
    if (
      paths === undefined ||
      context.controller.editsDisabled ||
      context.controller.validate(paths)
    ) {
      context.controller.clearNotice();
      setIndex(index + 1);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground" aria-live="polite">
        Step {index + 1} of {steps.length}
      </p>
      {title ? <h3 className="text-sm font-semibold">{title}</h3> : null}
      <Children
        refs={childrenOf(record.child, context.data, scope)}
        depth={depth}
      />
      <div className="flex items-center justify-between gap-2">
        {index > 0 ? (
          <SurfaceButton
            variant="secondary"
            onClick={() => setIndex(index - 1)}
          >
            Back
          </SurfaceButton>
        ) : (
          <span />
        )}
        {index < steps.length - 1 ? (
          <SurfaceButton variant="primary" onClick={next}>
            Next
          </SurfaceButton>
        ) : finish && finishReady && context.canTap(finish) ? (
          // The action's own button: a send shows its words (79 W1).
          <ActionButton action={finish} scope={scope} style="primary" />
        ) : null}
      </div>
    </div>
  );
};

export const DividerView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const label = context.text(component, "label", scope, 80);
  if (!label) {
    return <hr className="border-border" />;
  }
  // The lines are the separator (an <hr> is one), named by the label (79
  // NIT); the visible label is read once, through that name.
  return (
    <div className="flex items-center gap-2">
      <hr aria-label={label} className="flex-1 border-border" />
      <span aria-hidden className="text-xs text-muted-foreground">
        {label}
      </span>
      <hr aria-hidden className="flex-1 border-border" />
    </div>
  );
};

/**
 * Opens only on a tap in this session (79 W3): `open` (literal or bound)
 * never opens it by itself, a refresh never reopens it, and closing always
 * wins locally. Closing writes false back to a bound, editable `open`.
 */
export const ModalView = ({ component, scope, depth }: NodeProps) => {
  const context = useNodeContext();
  const [shown, setLocal] = useState(false);
  const entry = context.children(component, scope, "entry");
  const title = context.text(component, "title", scope, 120) ?? "";
  const prop = component.props.open;
  const pointer =
    isObject(prop) && typeof prop.path === "string"
      ? resolvePointer(prop.path, scope)
      : undefined;
  const setShown = (next: boolean) => {
    setLocal(next);
    if (
      !next &&
      pointer &&
      context.acceptsEdits &&
      context.read(pointer) === true
    ) {
      context.edit(pointer, false);
    }
  };
  return (
    <>
      {entry.length === 0 ? (
        <SurfaceButton variant="secondary" onClick={() => setShown(true)}>
          {context.text(component, "title", scope, 60) ?? "Show"}
        </SurfaceButton>
      ) : (
        // The entry (a Link or Button) keeps its own action; a tap on it also opens the sheet.
        <div onClickCapture={() => setShown(true)}>
          <Children refs={entry} depth={depth} />
        </div>
      )}
      <SurfaceDialog
        open={shown}
        onOpenChange={setShown}
        title={title || "Details"}
      >
        <div className="flex flex-col gap-2.5">
          <Children
            refs={context.children(component, scope, "content")}
            depth={depth}
          />
        </div>
      </SurfaceDialog>
    </>
  );
};

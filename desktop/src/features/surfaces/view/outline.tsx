// Generated from the Kiingo surface renderer packages at 23394ec833a81a2fb1d9cfb5c0a7fcc34cd1b948; do not edit here.
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  appendPointer,
  bindingOf,
  childKey,
  isObject,
  readAt,
  readTree,
  splitSelectedIndex,
  treeExpandOf,
  treeKeyStep,
  treeOpenWith,
  treeOutline,
  visibleTreeRows,
  type TreeExpand,
  type TreeNode,
} from "../core";
import { cn } from "./cn";
import { useNodeContext, type NodeProps } from "./context";
import { Leading } from "./data";
import { BadgeLabel } from "./display";
import { catalogIcon, Glyphs } from "./icons";
import { InlineMarkdown } from "./markdown";
import { Node } from "./node";
import { QuotedText, TooLargeRow, toneText } from "./ui";

// Tree and SplitView on the web (GENUI-TREE, 2026-11-05). The fold, row
// and key logic is surface-core's (outline.ts), shared with the MCP App
// page and ported by the Swift kit.

/**
 * A foldable outline of `nodes`, on its own so another view (WorkView)
 * can draw server-fed nodes with it. `onSelect` absent: rows fold but
 * don't select. Fold state is this view's alone and never saved.
 */
export const TreeRows = ({
  nodes,
  expand = "top",
  selectedId,
  onSelect,
  label,
  busy = false,
  rowBudget,
}: {
  nodes: TreeNode[];
  expand?: TreeExpand;
  selectedId?: string | undefined;
  onSelect?: ((node: TreeNode) => void) | undefined;
  label: string;
  busy?: boolean;
  /** At most this many rows drawn (the surface's cell budget), then a note. */
  rowBudget?: (wanted: number) => number;
}) => {
  // The viewer's own folds over the first rule (surface-core treeOpenWith).
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const open = useMemo(
    () => treeOpenWith(nodes, expand, folds),
    [nodes, expand, folds],
  );
  const [focusId, setFocusId] = useState<string | undefined>(undefined);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const rows = useMemo(() => visibleTreeRows(nodes, open), [nodes, open]);
  const count = rowBudget ? rowBudget(rows.length) : rows.length;
  const shown = rows.slice(0, count);
  // The row that takes Tab: the focused one while it's on screen, else the
  // selected one, else the first.
  const tabId =
    shown.find((row) => row.node.id === focusId)?.node.id ??
    shown.find((row) => row.node.id === selectedId)?.node.id ??
    shown[0]?.node.id;
  const toggle = (id: string) =>
    setFolds((was) => new Map(was).set(id, !open.has(id)));
  const choose = (node: TreeNode) => {
    if (onSelect && node.selectable && !busy) {
      onSelect(node);
    } else if (node.children.length > 0) {
      toggle(node.id);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = shown.find((r) => r.node.id === tabId);
    if ((event.key === "Enter" || event.key === " ") && row) {
      event.preventDefault();
      choose(row.node);
      return;
    }
    const step = treeKeyStep(shown, tabId, event.key);
    if (!step) {
      return;
    }
    event.preventDefault();
    if (step.toggle) {
      toggle(step.toggle);
    }
    if (step.focus) {
      setFocusId(step.focus);
      refs.current.get(step.focus)?.focus();
    }
  };
  return (
    <div role="tree" aria-label={label} onKeyDown={onKeyDown}>
      {shown.map((row) => {
        const { node } = row;
        const branch = node.children.length > 0;
        const Icon = node.icon ? catalogIcon(node.icon) : undefined;
        const selectable = onSelect !== undefined && node.selectable;
        const selected = selectable && node.id === selectedId;
        return (
          <div
            key={node.id}
            ref={(element) => {
              if (element) {
                refs.current.set(node.id, element);
              } else {
                refs.current.delete(node.id);
              }
            }}
            role="treeitem"
            aria-level={row.level}
            aria-posinset={row.position}
            aria-setsize={row.siblings}
            aria-expanded={branch ? row.open : undefined}
            aria-selected={selectable ? selected : undefined}
            aria-disabled={selectable && busy ? true : undefined}
            tabIndex={node.id === tabId ? 0 : -1}
            onFocus={() => setFocusId(node.id)}
            onClick={() => choose(node)}
            className={cn(
              "flex min-h-8 cursor-default items-center gap-1.5 rounded-md py-1 pr-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              (selectable || branch) && "cursor-pointer hover:bg-muted/50",
              selected && "bg-primary/10",
            )}
            style={{ paddingLeft: `${(row.level - 1) * 16 + 4}px` }}
          >
            {branch ? (
              <span
                aria-hidden
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(node.id);
                }}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
              >
                {row.open ? (
                  <Glyphs.down className="h-3.5 w-3.5" />
                ) : (
                  <Glyphs.right className="h-3.5 w-3.5" />
                )}
              </span>
            ) : (
              <span aria-hidden className="w-5 shrink-0" />
            )}
            {node.done ? (
              <Glyphs.checkboxOn
                aria-hidden
                className="h-4 w-4 shrink-0 text-emerald-700"
              />
            ) : Icon ? (
              <Icon
                aria-hidden
                className={cn(
                  "h-4 w-4 shrink-0",
                  toneText(node.tone ?? "muted"),
                )}
              />
            ) : null}
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block truncate",
                  node.tone && !Icon ? toneText(node.tone) : undefined,
                  node.done && "text-muted-foreground line-through",
                )}
              >
                {node.label}
                {node.done ? <span className="sr-only">, done</span> : null}
              </span>
              {node.detail ? (
                <span className="block truncate text-xs text-muted-foreground">
                  {node.detail}
                </span>
              ) : null}
            </span>
            {node.badge ? (
              <BadgeLabel text={node.badge.text} tone={node.badge.tone} />
            ) : null}
            {node.trailing ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {node.trailing}
              </span>
            ) : null}
          </div>
        );
      })}
      {count < rows.length ? <TooLargeRow /> : null}
    </div>
  );
};

/**
 * Tree: selecting a node writes its id to `selection`, then runs
 * `onSelect`. Outside content anywhere in `nodes` draws as a quote and
 * never selects (79 W6).
 */
export const TreeView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const nodes = readTree(context.value(component, "nodes", scope));
  const title = context.text(component, "title", scope, 120);
  const empty = context.text(component, "emptyText", scope, 200);
  if (nodes.length === 0) {
    return empty ? (
      <p className="text-xs text-muted-foreground">{empty}</p>
    ) : null;
  }
  if (context.isUntrusted(component, "nodes", scope)) {
    return (
      <figure className="m-0 flex flex-col gap-1">
        {title ? (
          <figcaption className="text-sm font-semibold">{title}</figcaption>
        ) : null}
        <QuotedText text={treeOutline(nodes).join("\n")} />
      </figure>
    );
  }
  return (
    <TreeBody component={component} scope={scope} nodes={nodes} title={title} />
  );
};

const TreeBody = ({
  component,
  scope,
  nodes,
  title,
}: Pick<NodeProps, "component" | "scope"> & {
  nodes: TreeNode[];
  title: string | undefined;
}) => {
  const context = useNodeContext();
  const selectionPointer = bindingOf(component.props.selection, scope);
  const action = context.action(component.props.onSelect);
  const tappable = action !== undefined && context.canTapSilently(action);
  const canWrite = selectionPointer !== undefined && context.acceptsEdits;
  const selected = selectionPointer
    ? context.read(selectionPointer)
    : undefined;
  const select =
    canWrite || tappable
      ? (node: TreeNode) => {
          if (canWrite) {
            context.edit(selectionPointer, node.id);
          }
          if (tappable && action) {
            context.perform(action.id, scope);
          }
        }
      : undefined;
  return (
    <figure className="m-0 flex flex-col gap-1">
      {title ? (
        <figcaption className="text-sm font-semibold">{title}</figcaption>
      ) : null}
      <TreeRows
        nodes={nodes}
        expand={treeExpandOf(component.props.expand)}
        selectedId={typeof selected === "string" ? selected : undefined}
        onSelect={select}
        label={title ?? "Outline"}
        busy={context.busy}
        rowBudget={(wanted) =>
          context.claimCells(`tree:${childKey(component.id, scope)}`, wanted)
        }
      />
    </figure>
  );
};

/**
 * SplitView: rows as List over `items`, and `detail` drawn in the selected
 * row's scope. Wide (the card at least 36rem, `@xl`) shows both; narrow
 * shows the list, then the detail with Back. Selecting writes the index to
 * `selection`, then runs `onSelect`; a row from outside content is a quote
 * and never selects (79 W6).
 */
export const SplitViewView = ({ component, scope, depth }: NodeProps) => {
  const context = useNodeContext();
  const pointer = bindingOf(component.props.items, scope);
  const items = pointer ? readAt(context.data, pointer) : undefined;
  const wanted = Array.isArray(items) ? items.length : 0;
  const count = context.claimCells(
    `split:${childKey(component.id, scope)}`,
    wanted,
  );
  const selectionPointer = bindingOf(component.props.selection, scope);
  const bound = selectionPointer
    ? splitSelectedIndex(context.read(selectionPointer), count)
    : undefined;
  const [local, setLocal] = useState<number | undefined>(undefined);
  const [showDetail, setShowDetail] = useState(false);
  const selected = splitSelectedIndex(local ?? bound, count);
  const action = context.action(component.props.onSelect);
  const tappable = action !== undefined && context.canTapSilently(action);
  const empty = context.text(component, "emptyText", scope, 200);
  const placeholder = context.text(component, "placeholder", scope, 200);
  const detailId =
    typeof component.props.detail === "string"
      ? component.props.detail
      : undefined;
  const leading = component.props.leading;
  const badge = component.props.badge;
  const detailRegion = context.domId(component, scope, "-detail");
  if (!pointer || wanted === 0) {
    return empty ? (
      <p className="text-xs text-muted-foreground">{empty}</p>
    ) : null;
  }
  const rowText = (index: number) => {
    const itemScope = appendPointer(pointer, index);
    return {
      itemScope,
      title: context.textOf(component.props.title, itemScope, 300) ?? "",
      subtitle: context.textOf(component.props.subtitle, itemScope, 500),
      trailing: context.textOf(component.props.trailing, itemScope, 100),
      badgeText: isObject(badge)
        ? context.textOf(badge.text, itemScope, 60)
        : undefined,
      outside:
        context.isUntrustedAt(itemScope) ||
        [
          component.props.title,
          component.props.subtitle,
          component.props.trailing,
          isObject(badge) ? badge.text : undefined,
        ].some((prop) => context.isUntrustedValue(prop, itemScope)),
    };
  };
  const pick = (index: number) => {
    setLocal(index);
    setShowDetail(true);
    if (selectionPointer && context.acceptsEdits) {
      context.edit(selectionPointer, index);
    }
    if (tappable && action) {
      context.perform(action.id, appendPointer(pointer, index));
    }
  };
  const current = selected === undefined ? undefined : rowText(selected);
  return (
    <div className="@container">
      <div className="flex flex-col gap-3 @xl:grid @xl:grid-cols-[minmax(11rem,2fr)_3fr] @xl:items-start">
        <ul
          className={cn(
            "divide-y divide-border",
            showDetail ? "hidden @xl:block" : "block",
          )}
        >
          {Array.from({ length: count }, (_, index) => {
            const row = rowText(index);
            if (row.outside) {
              return (
                <li key={index} className="py-2">
                  <QuotedText
                    text={[row.title, row.subtitle, row.trailing, row.badgeText]
                      .filter(Boolean)
                      .join(" · ")}
                  />
                </li>
              );
            }
            return (
              <li key={index}>
                <button
                  type="button"
                  disabled={context.busy}
                  aria-current={selected === index ? "true" : undefined}
                  aria-controls={detailRegion}
                  onClick={() => pick(index)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-1 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected === index && "bg-primary/10",
                  )}
                >
                  {isObject(leading) ? (
                    <Leading leading={leading} scope={row.itemScope} />
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{row.title}</span>
                    {row.subtitle ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {/* No link inside the row's button. */}
                        <InlineMarkdown
                          text={row.subtitle}
                          onLink={context.openLink}
                          links={false}
                        />
                      </span>
                    ) : null}
                  </span>
                  {row.badgeText ? (
                    <BadgeLabel
                      text={row.badgeText}
                      tone={
                        isObject(badge) && typeof badge.tone === "string"
                          ? badge.tone
                          : undefined
                      }
                    />
                  ) : null}
                  {row.trailing ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {row.trailing}
                    </span>
                  ) : null}
                  <Glyphs.right
                    aria-hidden
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground @xl:hidden"
                  />
                </button>
              </li>
            );
          })}
          {count < wanted ? <TooLargeRow /> : null}
        </ul>
        <section
          id={detailRegion}
          aria-label={current?.title || "Detail"}
          className={cn(
            "min-w-0 flex-col gap-2 @xl:flex @xl:border-l @xl:border-border @xl:pl-3",
            showDetail ? "flex" : "hidden",
          )}
        >
          <button
            type="button"
            onClick={() => setShowDetail(false)}
            className="inline-flex items-center gap-1 self-start rounded-md py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @xl:hidden"
          >
            <Glyphs.right aria-hidden className="h-3.5 w-3.5 rotate-180" />
            Back
          </button>
          {current && detailId ? (
            current.outside ? (
              <QuotedText text={current.title} />
            ) : (
              <Node
                key={selected}
                componentId={detailId}
                scope={current.itemScope}
                depth={depth + 1}
              />
            )
          ) : placeholder ? (
            <p className="text-sm text-muted-foreground">{placeholder}</p>
          ) : null}
        </section>
      </div>
    </div>
  );
};

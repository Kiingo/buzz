// Generated from the Kiingo surface renderer packages at 31af16c4bf4bf2ccee353af7c8c836d4be5d621a; do not edit here.
import { useState, type DragEvent, type KeyboardEvent } from "react";
import {
  appendPointer,
  bindingOf,
  BOARD_LANE_MAX,
  boardLanes,
  childKey,
  diagramOutline,
  laneCount,
  laneMoreText,
  layoutDiagram,
  moveBoardCard,
  readBoardColumns,
  readDiagram,
  type BoardCard,
  type JsonValue,
} from "../core";
import { cn } from "./cn";
import { useNodeContext, type NodeProps } from "./context";
import { BadgeLabel } from "./display";
import { catalogIcon } from "./icons";
import { QuotedText, TooLargeRow, toneSurface, toneText } from "./ui";

// §4.2 Board on the web (GU-A); CalendarView and Diagram join it. Logic
// lives in surface-core (board.ts); this only draws it. Every drag has a
// keyboard and screen-reader path (each card's Move menu).

const CARD_MIME = "application/x-kiingo-board-card";

// --- Board -------------------------------------------------------------------

/** The dragged card's index, only when it came from this board. */
const dropIndex = (payload: string, source: string): number | undefined => {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { source?: unknown }).source === source
    ) {
      const index = (parsed as { index?: unknown }).index;
      return typeof index === "number" && Number.isInteger(index) && index >= 0
        ? index
        : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

export const BoardView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const columns = readBoardColumns(context.list(component, "columns", scope));
  const pointer = bindingOf(component.props.cards, scope);
  const read = pointer ? context.read(pointer) : undefined;
  const cards: JsonValue[] = Array.isArray(read) ? read : [];
  // Drawn per lane (BOARD_LANE_MAX each), so a moved card shows wherever
  // it lands; a smaller render budget shares out evenly across the lanes.
  const full = boardLanes(columns, cards);
  const wanted = full.reduce((sum, lane) => sum + lane.cards.length, 0);
  const granted = context.claimCells(
    `board:${childKey(component.id, scope)}`,
    wanted,
  );
  const lanes =
    granted >= wanted
      ? full
      : boardLanes(
          columns,
          cards,
          Math.min(
            BOARD_LANE_MAX,
            Math.floor(granted / Math.max(1, columns.length)),
          ),
        );
  const empty = context.text(component, "emptyText", scope, 120);
  const outsideAll = pointer ? context.isUntrustedAt(pointer) : false;
  const canMove =
    component.props.draggable === true &&
    context.acceptsEdits &&
    Boolean(pointer);
  const moveAction = context.action(component.props.onMove);
  const tapAction = context.action(component.props.onCardTap);
  const selectionPointer = bindingOf(component.props.selection, scope);
  const movedPointer = bindingOf(component.props.moved, scope);
  const selected = selectionPointer
    ? context.read(selectionPointer)
    : undefined;
  // A drop names its board (surface, component, scope): a card dragged in
  // from another board or surface is ignored (79 DROP-SOURCE-UNCHECKED).
  const source = context.domId(component, scope, "-board");
  const [dragging, setDragging] = useState<number | undefined>(undefined);
  const [over, setOver] = useState<string | undefined>(undefined);
  const outside = (card: BoardCard) =>
    outsideAll ||
    (pointer
      ? context.isUntrustedAt(appendPointer(pointer, card.index))
      : false);
  const move = (from: number, to: string, position?: number) => {
    const result = moveBoardCard(columns, cards, from, to, position);
    if (!result || !pointer) {
      return;
    }
    context.edit(pointer, result.cards);
    if (movedPointer) {
      context.edit(movedPointer, result.moved);
    }
    if (moveAction && context.canTapSilently(moveAction)) {
      context.perform(
        moveAction.id,
        appendPointer(pointer, result.moved.index),
      );
    }
  };
  const tap = (card: BoardCard) => {
    if (!tapAction || !pointer) {
      return;
    }
    if (selectionPointer && context.acceptsEdits) {
      context.edit(selectionPointer, card.index);
    }
    context.perform(tapAction.id, appendPointer(pointer, card.index));
  };
  const drop = (event: DragEvent, lane: string, position?: number) => {
    event.preventDefault();
    setOver(undefined);
    const from = dropIndex(event.dataTransfer.getData(CARD_MIME), source);
    setDragging(undefined);
    if (from !== undefined) {
      move(from, lane, position);
    }
  };
  if (columns.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1">
      <div
        className="flex gap-3 overflow-x-auto pb-1"
        role="group"
        aria-label="Board"
      >
        {lanes.map((lane) => (
          <section
            key={lane.id}
            aria-labelledby={context.domId(
              component,
              scope,
              `-lane-${lane.id}`,
            )}
            className={cn(
              "flex w-56 shrink-0 flex-col gap-2 rounded-lg border border-border p-2",
              over === lane.id && "ring-2 ring-ring",
            )}
            onDragOver={
              canMove
                ? (event) => {
                    event.preventDefault();
                    setOver(lane.id);
                  }
                : undefined
            }
            onDragLeave={canMove ? () => setOver(undefined) : undefined}
            onDrop={canMove ? (event) => drop(event, lane.id) : undefined}
          >
            <header className="flex items-center justify-between gap-2 px-1">
              <h4
                id={context.domId(component, scope, `-lane-${lane.id}`)}
                className={cn(
                  "truncate text-sm font-semibold",
                  toneText(lane.tone),
                )}
              >
                {lane.title}
              </h4>
              <span
                className={cn(
                  "rounded-full px-1.5 text-xs tabular-nums",
                  lane.over ? toneSurface("warning") : "text-muted-foreground",
                )}
                aria-label={
                  lane.wipLimit !== undefined
                    ? `${lane.cards.length + lane.more} cards, limit ${lane.wipLimit}${lane.over ? ", over the limit" : ""}`
                    : `${lane.cards.length + lane.more} cards`
                }
              >
                {laneCount(lane)}
              </span>
            </header>
            <ul className="flex flex-col gap-1.5">
              {lane.cards.length + lane.more === 0 && empty ? (
                <li className="px-1 text-xs text-muted-foreground">{empty}</li>
              ) : null}
              {lane.cards.map((card, position) => {
                const quoted = outside(card);
                const tappable =
                  !quoted &&
                  tapAction !== undefined &&
                  context.canTapSilently(tapAction);
                const body = (
                  <span className="flex flex-col gap-0.5 text-left">
                    {quoted ? (
                      <QuotedText
                        text={[card.title, card.subtitle]
                          .filter(Boolean)
                          .join("\n")}
                      />
                    ) : (
                      <>
                        <span className="text-sm">{card.title}</span>
                        {card.subtitle ? (
                          <span className="text-xs text-muted-foreground">
                            {card.subtitle}
                          </span>
                        ) : null}
                      </>
                    )}
                    {card.badge && !quoted ? (
                      <span>
                        <BadgeLabel
                          text={card.badge}
                          {...(card.tone ? { tone: card.tone } : {})}
                        />
                      </span>
                    ) : null}
                  </span>
                );
                return (
                  <li
                    key={card.key}
                    draggable={canMove}
                    onDragStart={
                      canMove
                        ? (event) => {
                            event.dataTransfer.setData(
                              CARD_MIME,
                              JSON.stringify({ source, index: card.index }),
                            );
                            event.dataTransfer.effectAllowed = "move";
                            setDragging(card.index);
                          }
                        : undefined
                    }
                    onDragEnd={() => setDragging(undefined)}
                    onDragOver={
                      canMove ? (event) => event.preventDefault() : undefined
                    }
                    onDrop={
                      canMove
                        ? (event) => {
                            event.stopPropagation();
                            drop(event, lane.id, position);
                          }
                        : undefined
                    }
                    aria-current={selected === card.index ? "true" : undefined}
                    className={cn(
                      "flex flex-col gap-1 rounded-md border border-border bg-card p-2",
                      dragging === card.index && "opacity-50",
                      selected === card.index && "ring-2 ring-primary/40",
                      canMove && "cursor-grab",
                    )}
                  >
                    {tappable ? (
                      <button
                        type="button"
                        disabled={context.busy}
                        onClick={() => tap(card)}
                        className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {body}
                      </button>
                    ) : (
                      body
                    )}
                    {canMove ? (
                      <select
                        aria-label={`Move ${card.title || "card"} to`}
                        value={lane.id}
                        disabled={context.busy}
                        onChange={(event) =>
                          move(card.index, event.target.value)
                        }
                        className="self-start rounded border border-input bg-background px-1 py-0.5 text-xs"
                      >
                        {columns.map((column) => (
                          <option key={column.id} value={column.id}>
                            {column.id === lane.id
                              ? `In ${column.title}`
                              : `Move to ${column.title}`}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </li>
                );
              })}
              {laneMoreText(lane) ? (
                <li className="px-1 text-xs text-muted-foreground">
                  {laneMoreText(lane)}
                </li>
              ) : null}
            </ul>
          </section>
        ))}
      </div>
      {granted < wanted ? <TooLargeRow /> : null}
    </div>
  );
};

// --- Diagram -----------------------------------------------------------------

const nodeRadius = (shape: string) =>
  shape === "box" ? 2 : shape === "pill" || shape === "circle" ? 22 : 8;

/** Shown text in a fixed-width box; the outline carries the whole label. */
const clip = (text: string, max: number) =>
  [...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;

const DIAGRAM_PAD = 8;

export const DiagramView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const { nodes, edges } = readDiagram(
    context.list(component, "nodes", scope),
    context.list(component, "edges", scope),
  );
  if (nodes.length === 0) {
    return null;
  }
  const direction = component.props.direction === "right" ? "right" : "down";
  const layout = layoutDiagram(nodes, edges, direction);
  const outline = diagramOutline(nodes, edges);
  const title = context.text(component, "title", scope, 120);
  // Outside content (anywhere in nodes or edges) is drawn as a quote and
  // never taps.
  const outside =
    context.isUntrusted(component, "nodes", scope) ||
    context.isUntrusted(component, "edges", scope);
  const action = context.action(component.props.onNodeTap);
  const tappable =
    !outside && action !== undefined && context.canTapSilently(action);
  const selectionPointer = bindingOf(component.props.selection, scope);
  const selected = selectionPointer
    ? context.read(selectionPointer)
    : undefined;
  const markerId = context.domId(component, scope, "-arrow");
  const tap = (id: string) => {
    if (!action || !tappable) {
      return;
    }
    if (selectionPointer && context.acceptsEdits) {
      context.edit(selectionPointer, id);
    }
    context.perform(action.id, scope);
  };
  const pad = DIAGRAM_PAD;
  const drawing = (
    <div className="overflow-x-auto">
      <svg
        viewBox={`${-pad} ${-pad} ${layout.width + pad * 2} ${layout.height + pad * 2}`}
        width={layout.width + pad * 2}
        className="h-auto max-w-full text-muted-foreground"
        aria-hidden="true"
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {layout.edges.map((edge, index) => (
          <g key={`e-${index}`}>
            <polyline
              points={edge.points.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeDasharray={edge.style === "dashed" ? "4 3" : undefined}
              markerEnd={`url(#${markerId})`}
            />
            {edge.label ? (
              <text
                x={edge.labelAt.x + 4}
                y={edge.labelAt.y - 4}
                fontSize="10"
                className="fill-muted-foreground"
              >
                {clip(edge.label, 24)}
              </text>
            ) : null}
          </g>
        ))}
        {layout.nodes.map((node) => {
          const Icon = node.icon ? catalogIcon(node.icon) : undefined;
          const isSelected = selected === node.id;
          const cx = node.x + node.w / 2;
          const cy = node.y + node.h / 2;
          const stroke = cn(
            "fill-card stroke-current",
            isSelected ? "text-primary" : toneText(node.tone ?? "muted"),
          );
          return (
            <g
              key={node.id}
              // A pointer shortcut on the drawing; the outline's buttons are
              // the keyboard and screen-reader path (the drawing is hidden).
              {...(tappable
                ? {
                    role: "button",
                    tabIndex: -1,
                    onClick: () => tap(node.id),
                    onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
                      if (event.key === "Enter") {
                        tap(node.id);
                      }
                    },
                  }
                : {})}
              className={tappable ? "cursor-pointer" : undefined}
            >
              {node.shape === "diamond" ? (
                <polygon
                  points={`${cx},${node.y} ${node.x + node.w},${cy} ${cx},${node.y + node.h} ${node.x},${cy}`}
                  className={stroke}
                  strokeWidth={isSelected ? 2.5 : 1.5}
                />
              ) : (
                <rect
                  x={node.x}
                  y={node.y}
                  width={node.w}
                  height={node.h}
                  rx={nodeRadius(node.shape)}
                  className={stroke}
                  strokeWidth={isSelected ? 2.5 : 1.5}
                />
              )}
              {Icon && node.shape !== "diamond" ? (
                <Icon
                  x={node.x + 8}
                  y={cy - 7}
                  width={14}
                  height={14}
                  className={toneText(node.tone)}
                />
              ) : null}
              <text
                x={cx + (Icon && node.shape !== "diamond" ? 8 : 0)}
                y={node.detail ? cy - 3 : cy + 4}
                textAnchor="middle"
                fontSize="11"
                className="fill-foreground"
              >
                {clip(node.label, node.shape === "diamond" ? 14 : 20)}
              </text>
              {node.detail ? (
                <text
                  x={cx}
                  y={cy + 11}
                  textAnchor="middle"
                  fontSize="9"
                  className="fill-muted-foreground"
                >
                  {clip(node.detail, 24)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
  return (
    <figure className="flex flex-col gap-2">
      {title ? (
        <figcaption className="text-sm font-semibold">{title}</figcaption>
      ) : null}
      {outside ? (
        <div
          className="border-l-[3px] border-muted-foreground/40 pl-1.5"
          title="Quoted"
        >
          <span className="text-xs text-muted-foreground">Quoted</span>
          {drawing}
        </div>
      ) : (
        drawing
      )}
      {/* The outline is the diagram for screen readers, and the way to tap. */}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Outline
        </summary>
        {outside ? (
          <QuotedText text={outline.join("\n")} />
        ) : (
          <ul
            className="mt-1 flex flex-col gap-0.5"
            aria-label={title ?? "Diagram outline"}
          >
            {nodes.map((node, index) => (
              <li key={node.id}>
                {tappable ? (
                  <button
                    type="button"
                    disabled={context.busy}
                    aria-current={selected === node.id ? "true" : undefined}
                    onClick={() => tap(node.id)}
                    className="text-left hover:underline"
                  >
                    {outline[index]}
                  </button>
                ) : (
                  outline[index]
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
    </figure>
  );
};

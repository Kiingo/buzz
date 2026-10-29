// Generated from the Kiingo surface renderer packages at cec9eff8903c0d5f3d7dd58145c4f4dfdf28fb98; do not edit here.
import { useState, type DragEvent } from "react";
import {
  appendPointer,
  bindingOf,
  boardLanes,
  childKey,
  laneCount,
  moveBoardCard,
  readBoardColumns,
  type BoardCard,
  type JsonValue,
} from "../core";
import { cn } from "./cn";
import { useNodeContext, type NodeProps } from "./context";
import { BadgeLabel } from "./display";
import { QuotedText, TooLargeRow, toneSurface, toneText } from "./ui";

// §4.2 Board on the web (GU-A); CalendarView and Diagram join it. Logic
// lives in surface-core (board.ts); this only draws it. Every drag has a
// keyboard and screen-reader path (each card's Move menu).

const CARD_MIME = "application/x-kiingo-board-card";

// --- Board -------------------------------------------------------------------

export const BoardView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const columns = readBoardColumns(context.list(component, "columns", scope));
  const pointer = bindingOf(component.props.cards, scope);
  const read = pointer ? context.read(pointer) : undefined;
  const cards: JsonValue[] = Array.isArray(read) ? read : [];
  const granted = context.claimCells(
    `board:${childKey(component.id, scope)}`,
    Math.min(cards.length, 500),
  );
  const lanes = boardLanes(columns, cards, granted);
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
  const [dragging, setDragging] = useState<number | undefined>(undefined);
  const [over, setOver] = useState<string | undefined>(undefined);
  const outside = (card: BoardCard) =>
    outsideAll ||
    (pointer
      ? context.isUntrustedAt(appendPointer(pointer, card.index))
      : false);
  const move = (from: number, to: string, position?: number) => {
    const result = moveBoardCard(cards, from, to, position);
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
    const raw = event.dataTransfer.getData(CARD_MIME);
    const from = Number(raw);
    setDragging(undefined);
    if (raw !== "" && Number.isInteger(from)) {
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
                    ? `${lane.cards.length} cards, limit ${lane.wipLimit}${lane.over ? ", over the limit" : ""}`
                    : `${lane.cards.length} cards`
                }
              >
                {laneCount(lane)}
              </span>
            </header>
            <ul className="flex flex-col gap-1.5">
              {lane.cards.length === 0 && empty ? (
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
                    key={card.id ?? card.index}
                    draggable={canMove}
                    onDragStart={
                      canMove
                        ? (event) => {
                            event.dataTransfer.setData(
                              CARD_MIME,
                              String(card.index),
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
            </ul>
          </section>
        ))}
      </div>
      {granted < cards.length ? <TooLargeRow /> : null}
    </div>
  );
};

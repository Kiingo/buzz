// Generated from the Kiingo surface renderer packages at 1055d96f74fb6ac27bf0ebcd3c7fa12aee50be9c; do not edit here.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  appendPointer,
  bindingOf,
  decideSwipe,
  readSwipeCards,
  swipeCountsText,
  swipeDecisionOf,
  swipeDecisionMayRun,
  swipeKeyAction,
  swipeState,
  swipeUndoTarget,
  undoSwipe,
  SWIPE_DEFAULT_LABELS,
  type JsonValue,
  type SwipeDecision,
  type SwipeLabels,
} from "../core";
import { cn } from "./cn";
import { useNodeContext } from "./context";
import { BadgeLabel } from "./display";
import type { FieldProps } from "./field";
import { QuoteBox, SurfaceButton } from "./ui";

// SwipeDeck on the web (GENUI-SWIPE): one card at a time. Logic lives in
// surface-core (swipe.ts); this only draws it. Every swipe has a button
// and a key, and each decision is announced.

/** How far a drag must travel (px) to count as a swipe: a third of a phone card. */
const SWIPE_DISTANCE = 96;

const ACTION_PROPS: Record<SwipeDecision, string> = {
  approve: "onApprove",
  skip: "onSkip",
  reject: "onReject",
};

const PAST: Record<SwipeDecision, string> = {
  approve: "Approved",
  skip: "Skipped",
  reject: "Rejected",
};

export const SwipeDeckInput = (props: FieldProps) => {
  const { component, scope, pointer, id, disabled } = props;
  const context = useNodeContext();
  const cardsAt = bindingOf(component.props.cards, scope);
  const read = cardsAt ? context.read(cardsAt) : undefined;
  const cards = readSwipeCards(Array.isArray(read) ? read : []);
  const value = context.read(pointer);
  const state = swipeState(cards, value);
  const current = state.current;
  const labels: SwipeLabels = {
    approve:
      context.text(component, "approveLabel", scope) ??
      SWIPE_DEFAULT_LABELS.approve,
    skip:
      context.text(component, "skipLabel", scope) ?? SWIPE_DEFAULT_LABELS.skip,
    reject:
      context.text(component, "rejectLabel", scope) ??
      SWIPE_DEFAULT_LABELS.reject,
  };
  const canSkip = component.props.skip !== false;
  const decidedAt = bindingOf(component.props.decided, scope);
  const outsideAll = cardsAt ? context.isUntrustedAt(cardsAt) : false;
  const canDecide = !disabled && Boolean(cardsAt) && !context.busy;
  const undoTarget = swipeUndoTarget(cards, value);
  const doneAction = context.action(component.props.onDone);
  const [said, setSaid] = useState("");
  const [drag, setDrag] = useState<{ x: number; y: number } | undefined>(
    undefined,
  );
  const start = useRef<{ x: number; y: number; id: number } | undefined>(
    undefined,
  );

  const decide = (decision: SwipeDecision) => {
    if (!current || !canDecide || (decision === "skip" && !canSkip)) {
      return;
    }
    const result = decideSwipe(value, current, decision);
    context.edit(pointer, result.value);
    if (decidedAt) {
      context.edit(decidedAt, result.decided as unknown as JsonValue);
    }
    setSaid(`${PAST[decision]}: ${current.title || `card ${state.position}`}`);
    const action = context.action(component.props[ACTION_PROPS[decision]]);
    // A decision shows no words and no confirmation, so it never sends a
    // message, runs a method or sends an email (79 M1/W1,
    // LOW-79-SWIPE-DECISION-SEND); other actions go through the usual tap.
    if (
      action &&
      cardsAt &&
      swipeDecisionMayRun(action, context.surface.template) &&
      context.canTapSilently(action)
    ) {
      context.perform(action.id, appendPointer(cardsAt, current.index));
    }
  };

  const undo = () => {
    if (!undoTarget || disabled || context.busy) {
      return;
    }
    context.edit(pointer, undoSwipe(value, undoTarget));
    if (decidedAt) {
      context.edit(decidedAt, null);
    }
    setSaid(`Back to ${undoTarget.title || "the last card"}`);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target !== event.currentTarget && target.tagName === "BUTTON") {
      // Keys on a focused button keep their own meaning (Space, Enter);
      // the arrows and letters still decide.
      if (event.key === " " || event.key === "Enter") {
        return;
      }
    }
    const key = swipeKeyAction(event.key);
    if (!key) {
      return;
    }
    event.preventDefault();
    if (key === "undo") {
      undo();
    } else {
      decide(key);
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!current || !canDecide || event.button !== 0) {
      return;
    }
    start.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (!from || from.id !== event.pointerId) {
      return;
    }
    const x = event.clientX - from.x;
    const y = event.clientY - from.y;
    if (!drag && Math.hypot(x, y) > 8) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    // Sideways only: a vertical drag stays the page's scroll.
    setDrag(Math.abs(x) > Math.abs(y) ? { x, y: 0 } : undefined);
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    start.current = undefined;
    const moved = drag;
    setDrag(undefined);
    if (!from || from.id !== event.pointerId || !moved) {
      return;
    }
    if (
      Math.abs(moved.x) >= SWIPE_DISTANCE &&
      Math.abs(moved.x) > Math.abs(moved.y)
    ) {
      decide(moved.x > 0 ? "approve" : "reject");
    }
  };

  const leaning: SwipeDecision | undefined =
    drag && Math.abs(drag.x) >= SWIPE_DISTANCE / 2
      ? drag.x > 0
        ? "approve"
        : "reject"
      : undefined;
  const counts = swipeCountsText(state.counts, labels);
  // Outside content (an email's words) is quoted; deciding on it is still
  // the person's own act, as moving an outside Board card is.
  const quoted =
    current !== undefined &&
    (outsideAll ||
      (cardsAt !== undefined &&
        context.isUntrustedAt(appendPointer(cardsAt, current.index))));

  return (
    <div
      id={id}
      role="group"
      aria-roledescription="card deck"
      aria-describedby={props.describedBy}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {context.text(component, "emptyText", scope) ??
            "Nothing to go through."}
        </p>
      ) : current ? (
        <>
          <p className="text-xs text-muted-foreground tabular-nums">
            {`Card ${state.position} of ${state.total}`}
            {counts ? ` · ${counts}` : ""}
          </p>
          <div
            aria-label={`Card ${state.position} of ${state.total}${current.title ? `: ${current.title}` : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            style={
              drag
                ? {
                    transform: `translateX(${drag.x}px) rotate(${drag.x / 24}deg)`,
                  }
                : undefined
            }
            className={cn(
              "flex max-h-96 touch-pan-y select-none flex-col gap-1.5 overflow-y-auto rounded-lg border border-border bg-card p-3 shadow-sm",
              !drag && "transition-transform",
              leaning === "approve" && "ring-2 ring-emerald-600",
              leaning === "reject" && "ring-2 ring-destructive",
            )}
          >
            {leaning ? (
              <span className="self-start rounded bg-muted px-1.5 text-xs font-semibold">
                {labels[leaning]}
              </span>
            ) : null}
            {quoted ? (
              <QuoteBox
                text={[current.title, current.subtitle, current.body]
                  .filter(Boolean)
                  .join("\n")}
              />
            ) : (
              <>
                <span className="text-base font-semibold">{current.title}</span>
                {current.subtitle ? (
                  <span className="text-xs text-muted-foreground">
                    {current.subtitle}
                  </span>
                ) : null}
                {current.body ? (
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {current.body}
                  </p>
                ) : null}
              </>
            )}
            {current.badge && !quoted ? (
              <span>
                <BadgeLabel
                  text={current.badge}
                  {...(current.tone ? { tone: current.tone } : {})}
                />
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <SurfaceButton
              variant="secondary"
              disabled={!canDecide}
              onClick={() => decide("reject")}
              aria-keyshortcuts="ArrowLeft X"
            >
              {`← ${labels.reject}`}
            </SurfaceButton>
            {canSkip ? (
              <SurfaceButton
                variant="secondary"
                disabled={!canDecide}
                onClick={() => decide("skip")}
                aria-keyshortcuts="ArrowDown S"
              >
                {`↓ ${labels.skip}`}
              </SurfaceButton>
            ) : null}
            <SurfaceButton
              variant="primary"
              disabled={!canDecide}
              onClick={() => decide("approve")}
              aria-keyshortcuts="ArrowRight A"
            >
              {`${labels.approve} →`}
            </SurfaceButton>
            {undoTarget ? (
              <SurfaceButton
                variant="plain"
                disabled={disabled || context.busy}
                onClick={undo}
                aria-keyshortcuts="Z Backspace"
              >
                Undo
              </SurfaceButton>
            ) : null}
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
          <p className="text-sm font-semibold">
            {context.text(component, "doneText", scope) ?? "All done"}
          </p>
          {counts ? (
            <p className="text-xs text-muted-foreground">{counts}</p>
          ) : null}
          <ul className="flex flex-col gap-0.5 text-xs">
            {cards.map((card) => {
              const decision = swipeDecisionOf(value, card);
              return (
                <li key={card.key} className="flex gap-1.5">
                  <span className="shrink-0 font-medium">
                    {decision ? labels[decision] : "—"}
                  </span>
                  <span className="min-w-0 break-words text-muted-foreground">
                    {card.title}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-2">
            {doneAction && context.canTapSilently(doneAction) ? (
              <SurfaceButton
                variant="primary"
                disabled={context.busy}
                onClick={() => context.perform(doneAction.id, scope)}
              >
                {doneAction.label}
              </SurfaceButton>
            ) : null}
            {undoTarget ? (
              <SurfaceButton
                variant="plain"
                disabled={disabled || context.busy}
                onClick={undo}
                aria-keyshortcuts="Z Backspace"
              >
                Undo
              </SurfaceButton>
            ) : null}
          </div>
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
    </div>
  );
};

// Generated from the Kiingo surface renderer packages; do not edit here.
import { createContext, useContext, useSyncExternalStore } from "react";
import {
  bindingOf,
  childKey,
  childrenOf,
  isPointerPrefix,
  isUntrustedPath,
  markdownBudget,
  MAX_REPEATS,
  propBool,
  propNumber,
  propText,
  resolveProp,
  type ChildRef,
  type ControllerSnapshot,
  type JsonObject,
  type JsonValue,
  type MarkdownBudget,
  type MessageSend,
  type Pointer,
  type Surface,
  type SurfaceAction,
  type SurfaceComponent,
  type SurfaceController,
} from "../core";
import type { SurfaceHost } from "./host";

/** One controller's state, redrawn on every change. */
export const useSurfaceSnapshot = (
  controller: SurfaceController,
): ControllerSnapshot =>
  useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

export type SurfaceMode = "inline" | "expanded";

/**
 * What every node reads (the Swift `UiNodeContext`): the controller and its
 * snapshot, the host, the tap handler and the link opener.
 */
export class NodeContext {
  constructor(
    readonly controller: SurfaceController,
    readonly snapshot: ControllerSnapshot,
    readonly mode: SurfaceMode,
    readonly host: SurfaceHost,
    readonly perform: (actionId: string, scope: Pointer) => void,
    /** https or Kiingo links; outside ones are confirmed first. */
    readonly openLink: (url: string) => void,
    /** The words a chip or send shows, through the controller (79 W1). */
    readonly sendMessage: (send: MessageSend, actionId: string) => void,
    /** This render's Markdown allowance (79 S2), shared by every node. */
    readonly markdown: MarkdownBudget = markdownBudget(),
    /** Nodes drawn in this render (79 W8: at most MAX_SURFACE_NODES). */
    readonly nodes: { count: number } = { count: 0 },
  ) {}

  get surface(): Surface {
    return this.snapshot.surface;
  }

  get data(): JsonObject {
    return this.snapshot.data;
  }

  value(
    component: SurfaceComponent,
    key: string,
    scope: Pointer,
  ): JsonValue | undefined {
    return resolveProp(component.props[key], this.data, scope);
  }

  /** A prop as plain text (bound or literal); undefined when empty. */
  text(
    component: SurfaceComponent,
    key: string,
    scope: Pointer,
    max = 4000,
  ): string | undefined {
    return propText(component.props[key], this.data, scope, max);
  }

  /** Any value (an item field, bound or literal) as plain text. */
  textOf(prop: unknown, scope: Pointer, max = 4000): string | undefined {
    return propText(prop, this.data, scope, max);
  }

  number(
    component: SurfaceComponent,
    key: string,
    scope: Pointer,
  ): number | undefined {
    return propNumber(component.props[key], this.data, scope);
  }

  flag(component: SurfaceComponent, key: string, scope: Pointer): boolean {
    return propBool(component.props[key], this.data, scope);
  }

  /** A literal string prop (enums such as `variant`, `kind`, `style`). */
  string(component: SurfaceComponent, key: string): string | undefined {
    const value = component.props[key];
    return typeof value === "string" ? value : undefined;
  }

  /**
   * Whether the prop reads outside content (§10, 79 W6): drawn as a Quote,
   * never as a link or an action. A prop bound under a `dataTrust` path, a
   * literal inside a repeat over one, or one inside an outside list.
   */
  isUntrusted(
    component: SurfaceComponent,
    key: string,
    scope: Pointer,
  ): boolean {
    return this.isUntrustedValue(component.props[key], scope);
  }

  /** {@link isUntrusted} for any prop value (an item field, a column). */
  isUntrustedValue(prop: unknown, scope: Pointer): boolean {
    const pointer = bindingOf(prop, scope);
    if (pointer) {
      return this.isUntrustedAt(pointer);
    }
    // A literal inside a repeat over outside items is the agent's own text,
    // but anything read from the item (`./x`) was handled above.
    return false;
  }

  /** Whether data at `pointer` (a table cell, a list item) is outside content. */
  isUntrustedAt(pointer: Pointer): boolean {
    return isUntrustedPath(this.surface, pointer);
  }

  /**
   * Whether `prop`, a list, holds outside content anywhere: its own path, or
   * a `dataTrust` path below it (one column, one item's field).
   */
  isUntrustedList(prop: unknown, scope: Pointer): boolean {
    const pointer = bindingOf(prop, scope);
    return pointer
      ? this.surface.untrustedPaths.some(
          (marked) =>
            isPointerPrefix(marked, pointer) ||
            isPointerPrefix(pointer, marked),
        )
      : false;
  }

  children(
    component: SurfaceComponent,
    scope: Pointer,
    key = "children",
  ): ChildRef[] {
    return childrenOf(component.props[key], this.data, scope);
  }

  /** An item list prop (`items`, `options`, `rows`…), literal or bound. */
  list(component: SurfaceComponent, key: string, scope: Pointer): JsonValue[] {
    const value = this.value(component, key, scope);
    return Array.isArray(value) ? value.slice(0, MAX_REPEATS) : [];
  }

  action(id: unknown): SurfaceAction | undefined {
    return typeof id === "string" ? this.surface.actions.get(id) : undefined;
  }

  canTap(action: SurfaceAction): boolean {
    return this.controller.canTap(action);
  }

  /**
   * A tap on a whole row, card or item: it shows no words, so it never
   * sends a message (79 M1/W1). Other actions as {@link canTap}.
   */
  canTapSilently(action: SurfaceAction): boolean {
    return action.kind !== "send_message" && this.controller.canTap(action);
  }

  get busy(): boolean {
    return this.snapshot.busyActionId !== undefined;
  }

  /** The bound input path of `value`. */
  pointer(component: SurfaceComponent, scope: Pointer): Pointer | undefined {
    return bindingOf(component.props.value, scope);
  }

  /** `disabled` may be bound to the data. */
  canEdit(component: SurfaceComponent, scope: Pointer): boolean {
    return (
      this.controller.acceptsEdits && !this.flag(component, "disabled", scope)
    );
  }

  get acceptsEdits(): boolean {
    return this.controller.acceptsEdits;
  }

  read(pointer: Pointer): JsonValue | undefined {
    return this.controller.value(pointer);
  }

  edit(pointer: Pointer, value: JsonValue | undefined): void {
    this.controller.edit(pointer, value);
  }

  problem(component: SurfaceComponent, scope: Pointer): string | undefined {
    return this.snapshot.problems.get(childKey(component.id, scope));
  }

  /** A stable DOM id for one component at one scope. */
  domId(component: SurfaceComponent, scope: Pointer, suffix = ""): string {
    const raw = `${this.surface.id}-${childKey(component.id, scope)}${suffix}`;
    return `ks-${raw.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
  }
}

export const NodeContextContext = createContext<NodeContext | null>(null);

export const useNodeContext = (): NodeContext => {
  const context = useContext(NodeContextContext);
  if (!context) {
    throw new Error("Surface nodes render inside <SurfaceView>.");
  }
  return context;
};

/** Props every component view gets. */
export type NodeProps = {
  component: SurfaceComponent;
  scope: Pointer;
  depth: number;
};

/** `gap: none | xs | sm | md | lg | xl` as Tailwind gap classes. */
export const gapClass = (gap: string | undefined): string => {
  switch (gap) {
    case "none":
      return "gap-0";
    case "xs":
      return "gap-1";
    case "sm":
      return "gap-1.5";
    case "lg":
      return "gap-4";
    case "xl":
      return "gap-6";
    default:
      return "gap-2.5";
  }
};

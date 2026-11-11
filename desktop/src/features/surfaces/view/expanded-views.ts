// Generated from the Kiingo surface renderer packages at dbc93b6d803e88e782fd6dbc8d7871827f2a9f7c; do not edit here.
import { useEffect, useSyncExternalStore } from "react";
import type { SurfaceController } from "../core";

// Expanded views open per controller: the expanded sheet or the full-screen
// dialog drawn over the inline card, which share its controller. While one is
// open the inline HtmlApp drops its frame, so one copy of the page runs, never
// two that can both setValue; the inline frame loads the page again when the
// last one closes (GENUI-HTML, dd 2026-11-05).
let openViews = new WeakMap<SurfaceController, number>();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) {
    listener();
  }
};

/** Drop expanded-view state when the host changes account or community. */
export const resetExpandedViews = (): void => {
  openViews = new WeakMap();
  notify();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Counts this view while `expanded` is true (SurfaceView in expanded mode). */
export const useExpandedViewRegistration = (
  controller: SurfaceController,
  expanded: boolean,
): void => {
  useEffect(() => {
    if (!expanded) {
      return;
    }
    const registry = openViews;
    registry.set(controller, (registry.get(controller) ?? 0) + 1);
    notify();
    return () => {
      // An old view can unmount after the new community has registered views.
      if (registry !== openViews) {
        return;
      }
      registry.set(
        controller,
        Math.max(0, (registry.get(controller) ?? 1) - 1),
      );
      notify();
    };
  }, [controller, expanded]);
};

/** True while an expanded view of this controller is open. */
export const useExpandedViewOpen = (controller: SurfaceController): boolean =>
  useSyncExternalStore(
    subscribe,
    () => (openViews.get(controller) ?? 0) > 0,
    () => false,
  );

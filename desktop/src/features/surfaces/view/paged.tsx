// Generated from the Kiingo surface renderer packages at 23394ec833a81a2fb1d9cfb5c0a7fcc34cd1b948; do not edit here.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "./cn";
import { Glyphs } from "./icons";

// One horizontally paged row for every carousel a surface draws: Carousel's
// pages, FileList's file cards and ImageGallery's images (GENUI-CAROUSEL,
// Ross 2026-11-05: "a carousel so that an agent could present files or
// images"). It swipes and snaps on touch, pages with the arrow buttons and
// the arrow keys, and says where you are ("2 of 5") so the catalog's
// accessibility line holds. Nothing autoplays.

const reducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Elements whose own arrow, Home and End keys move inside them. */
const ARROW_KEY_OWNERS = [
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[role="tree"]',
  '[role="grid"]',
  '[role="tablist"]',
  '[role="radiogroup"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[aria-roledescription="carousel"]',
].join(", ");

/** Whether the key's target sits in such an element inside this row. */
const ownsArrowKeys = (target: EventTarget, row: HTMLElement): boolean => {
  if (target === row || !(target instanceof Element)) {
    return false;
  }
  const owner = target.closest(ARROW_KEY_OWNERS);
  return owner !== null && row.contains(owner);
};

export const PagedRow = ({
  count,
  label,
  noun,
  itemClassName,
  renderItem,
}: {
  count: number;
  /** What the row is, for the region's name ("Files", "Images"). */
  label: string;
  /** One item's word in the position line ("File 2 of 5"). */
  noun: string;
  /** Each page's width class. */
  itemClassName: string;
  renderItem: (index: number) => ReactNode;
}) => {
  const scroller = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  const frame = useRef<number | undefined>(undefined);
  const last = Math.max(0, count - 1);
  const shown = Math.min(current, last);

  // The page nearest the row's start is the current one.
  const settle = useCallback(() => {
    frame.current = undefined;
    const row = scroller.current;
    if (!row) {
      return;
    }
    const pages = Array.from(row.children) as HTMLElement[];
    let nearest = 0;
    let distance = Number.POSITIVE_INFINITY;
    pages.forEach((page, index) => {
      const gap = Math.abs(page.offsetLeft - row.offsetLeft - row.scrollLeft);
      if (gap < distance) {
        distance = gap;
        nearest = index;
      }
    });
    // At the end of the row the last page can't reach the start.
    if (row.scrollLeft + row.clientWidth >= row.scrollWidth - 2) {
      nearest = pages.length - 1;
    }
    setCurrent(Math.max(0, nearest));
  }, []);

  const onScroll = () => {
    if (frame.current === undefined) {
      frame.current = window.requestAnimationFrame(settle);
    }
  };

  useEffect(
    () => () => {
      if (frame.current !== undefined) {
        window.cancelAnimationFrame(frame.current);
      }
    },
    [],
  );

  const go = (index: number) => {
    const row = scroller.current;
    const target = Math.min(last, Math.max(0, index));
    const page = row?.children[target] as HTMLElement | undefined;
    if (!row || !page) {
      return;
    }
    row.scrollTo({
      left: page.offsetLeft - row.offsetLeft,
      behavior: reducedMotion() ? "auto" : "smooth",
    });
    setCurrent(target);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A page can hold any component, a text field, slider, tree or another
    // carousel among them. Their arrow, Home and End keys stay theirs: the
    // row pages only for a key nothing inside it has taken.
    if (
      event.defaultPrevented ||
      ownsArrowKeys(event.target, event.currentTarget)
    ) {
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      go(shown + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(shown - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      go(0);
    } else if (event.key === "End") {
      event.preventDefault();
      go(last);
    }
  };

  if (count === 0) {
    return null;
  }
  const arrow =
    "inline-flex h-7 w-7 items-center justify-center rounded-full border bg-background text-foreground hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label={label}
      className="flex min-w-0 flex-col gap-1.5"
    >
      <div
        ref={scroller}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        // Focusable so the arrow keys page it.
        tabIndex={0}
        className="relative -mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {Array.from({ length: count }, (_, index) => (
          <div
            key={index}
            role="group"
            aria-roledescription="slide"
            aria-label={`${noun} ${index + 1} of ${count}`}
            className={cn("shrink-0 snap-start", itemClassName)}
          >
            {renderItem(index)}
          </div>
        ))}
      </div>
      {count > 1 ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {noun} {shown + 1} of {count}
          </p>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className={arrow}
              onClick={() => go(shown - 1)}
              disabled={shown === 0}
              aria-label={`Previous ${noun.toLowerCase()}`}
            >
              <Glyphs.right aria-hidden className="h-4 w-4 rotate-180" />
            </button>
            <button
              type="button"
              className={arrow}
              onClick={() => go(shown + 1)}
              disabled={shown >= last}
              aria-label={`Next ${noun.toLowerCase()}`}
            >
              <Glyphs.right aria-hidden className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

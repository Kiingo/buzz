// Generated from the Kiingo surface renderer packages at 5736645688767c7e713cc125961539139af6ba91; do not edit here.
import { isObject, type JsonValue } from "./json";
import { dayKey, parseDate } from "./format";
import { plainText } from "./text";

// CalendarView and DateRangePicker (§4.2, §4.3, GU-A): a day or week grid
// of bound events, laid out in a time zone, with moves and resizes that
// rewrite the events array. The Swift renderer follows the same rules.

export type CalendarEvent = {
  /** Position in the bound array (what `selection` receives). */
  index: number;
  /**
   * Unique within the calendar: the event's id, or `#<index>` for one with
   * none or with an id an earlier event already has (as Board cards).
   */
  key: string;
  id?: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  tone?: string;
  location?: string;
};

const TONES = new Set(["default", "muted", "success", "warning", "danger"]);
const DAY_MS = 86_400_000;

/** Events read at most (the rest are counted, not drawn). */
export const CALENDAR_MAX_EVENTS = 300;

export const readCalendarEvents = (
  raw: unknown[],
  max = CALENDAR_MAX_EVENTS,
): CalendarEvent[] => {
  const keys = new Set<string>();
  return raw.slice(0, max).flatMap((item, index): CalendarEvent[] => {
    if (!isObject(item)) {
      return [];
    }
    const start = parseDate(item.start);
    const parsedEnd = parseDate(item.end);
    if (!start) {
      return [];
    }
    const allDay =
      item.allDay === true ||
      (typeof item.start === "string" && item.start.length === 10);
    const end =
      parsedEnd && parsedEnd > start
        ? parsedEnd
        : new Date(start.getTime() + (allDay ? DAY_MS : 30 * 60_000));
    const id = plainText(item.id, 64);
    const key = id !== undefined && !keys.has(id) ? id : `#${index}`;
    keys.add(key);
    const location = plainText(item.location, 200);
    const tone =
      typeof item.tone === "string" && TONES.has(item.tone)
        ? item.tone
        : undefined;
    return [
      {
        index,
        key,
        title: plainText(item.title, 200) ?? "",
        start,
        end,
        allDay,
        ...(id ? { id } : {}),
        ...(location ? { location } : {}),
        ...(tone ? { tone } : {}),
      },
    ];
  });
};

/** Minutes since midnight of `date` in `timeZone`. */
export const minutesInZone = (date: Date, timeZone?: string): number => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(timeZone ? { timeZone } : {}),
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    return (hour % 24) * 60 + minute;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
};

/** The instant that is `minutes` after midnight of day `key` in `timeZone`. */
export const zonedInstant = (
  key: string,
  minutes: number,
  timeZone?: string,
): Date => {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 0, 0) + minutes * 60_000;
  // Correct by the zone's offset at the guess (twice, for DST edges).
  let at = guess;
  for (let pass = 0; pass < 2; pass += 1) {
    const shown =
      Date.UTC(
        ...((): [number, number, number] => {
          const [ky, km, kd] = dayKey(new Date(at), timeZone)
            .split("-")
            .map(Number) as [number, number, number];
          return [ky, km - 1, kd];
        })(),
      ) +
      minutesInZone(new Date(at), timeZone) * 60_000;
    at += guess - shown;
  }
  return new Date(at);
};

/** Day keys shown: one day, or the Monday-first week holding `date`. */
export const calendarDays = (
  date: Date,
  view: "day" | "week",
  timeZone?: string,
): string[] => {
  const key = dayKey(date, timeZone);
  if (view === "day") {
    return [key];
  }
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const noon = Date.UTC(y, m - 1, d, 12);
  const weekday = (new Date(noon).getUTCDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, i) =>
    new Date(noon + (i - weekday) * DAY_MS).toISOString().slice(0, 10),
  );
};

export type PlacedEvent = CalendarEvent & {
  day: string;
  /** Minutes from the grid's top, clamped to the grid. */
  top: number;
  height: number;
  /** Side-by-side lane among overlapping events, and how many lanes. */
  lane: number;
  lanes: number;
};

/**
 * Timed events of `day` placed on a grid from `startHour` to `endHour`;
 * overlapping events share the width in lanes. An event crossing midnight
 * shows on each day it touches.
 */
export const placeDayEvents = (
  events: CalendarEvent[],
  day: string,
  startHour: number,
  endHour: number,
  timeZone?: string,
): PlacedEvent[] => {
  const gridStart = startHour * 60;
  const gridEnd = endHour * 60;
  const placed = events
    .filter((event) => !event.allDay)
    .flatMap((event): PlacedEvent[] => {
      const startDay = dayKey(event.start, timeZone);
      const endDay = dayKey(new Date(event.end.getTime() - 1), timeZone);
      if (day < startDay || day > endDay) {
        return [];
      }
      const from = startDay === day ? minutesInZone(event.start, timeZone) : 0;
      const to =
        endDay === day
          ? minutesInZone(event.end, timeZone) || 24 * 60
          : 24 * 60;
      const top = Math.max(from, gridStart) - gridStart;
      const bottom = Math.min(Math.max(to, from + 15), gridEnd) - gridStart;
      if (bottom <= 0 || top >= gridEnd - gridStart) {
        return [];
      }
      return [{ ...event, day, top, height: bottom - top, lane: 0, lanes: 1 }];
    })
    .sort((a, b) => a.top - b.top || b.height - a.height);
  // Greedy lanes within each cluster of overlapping events.
  let cluster: PlacedEvent[] = [];
  let clusterEnd = -1;
  const close = () => {
    const lanes = Math.max(1, ...cluster.map((event) => event.lane + 1));
    for (const event of cluster) {
      event.lanes = lanes;
    }
    cluster = [];
  };
  for (const event of placed) {
    if (event.top >= clusterEnd) {
      close();
      clusterEnd = -1;
    }
    const taken = new Set(
      cluster
        .filter((other) => other.top + other.height > event.top)
        .map((other) => other.lane),
    );
    let lane = 0;
    while (taken.has(lane)) {
      lane += 1;
    }
    event.lane = lane;
    cluster.push(event);
    clusterEnd = Math.max(clusterEnd, event.top + event.height);
  }
  close();
  return placed;
};

/**
 * All-day events touching `day`. All-day dates are calendar dates, read in
 * UTC whatever the grid's zone (a date-only "2026-11-03" is that day).
 */
export const allDayEvents = (
  events: CalendarEvent[],
  day: string,
): CalendarEvent[] =>
  events.filter((event) => {
    if (!event.allDay) {
      return false;
    }
    const startDay = dayKey(event.start, "UTC");
    const endDay = dayKey(new Date(event.end.getTime() - 1), "UTC");
    return day >= startDay && day <= endDay;
  });

const snap = (minutes: number, step: number) =>
  Math.round(minutes / step) * step;

/**
 * Moves (or resizes, when only `end` changes) event `index` to start at
 * `minutes` on `day`, keeping its length, snapped to `snapMinutes`. Times
 * are written as ISO instants (UTC). Undefined when nothing changes.
 */
export const moveCalendarEvent = (
  raw: JsonValue[],
  index: number,
  change:
    | { kind: "move"; day: string; minutes: number }
    | { kind: "resize"; endMinutes: number; day: string },
  options: { snapMinutes?: number; timeZone?: string } = {},
): { events: JsonValue[]; event: Record<string, JsonValue> } | undefined => {
  const item = raw[index];
  if (!isObject(item)) {
    return undefined;
  }
  const [event] = readCalendarEvents([item]);
  if (!event || event.allDay) {
    return undefined;
  }
  const step = Math.min(Math.max(options.snapMinutes ?? 15, 5), 60);
  const length = event.end.getTime() - event.start.getTime();
  let start = event.start;
  let end = event.end;
  if (change.kind === "move") {
    start = zonedInstant(
      change.day,
      Math.max(0, Math.min(snap(change.minutes, step), 24 * 60 - step)),
      options.timeZone,
    );
    end = new Date(start.getTime() + length);
  } else {
    const at = zonedInstant(
      change.day,
      Math.max(0, Math.min(snap(change.endMinutes, step), 24 * 60)),
      options.timeZone,
    );
    end = new Date(Math.max(at.getTime(), start.getTime() + step * 60_000));
  }
  if (
    start.getTime() === event.start.getTime() &&
    end.getTime() === event.end.getTime()
  ) {
    return undefined;
  }
  const next = { ...item, start: start.toISOString(), end: end.toISOString() };
  return {
    events: raw.map((entry, i) => (i === index ? next : entry)),
    event: next,
  };
};

/** Days in an inclusive { start, end } date range (YYYY-MM-DD). */
export const rangeDays = (start: string, end: string): number => {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b)
    ? Math.round((b - a) / DAY_MS) + 1
    : 0;
};

/** A preset range ending or starting today, as day keys. */
export const presetRange = (
  preset: string,
  today: string,
): { start: string; end: string } | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(today)) {
    return undefined;
  }
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const noon = Date.UTC(y, m - 1, d, 12);
  if (!Number.isFinite(noon)) {
    return undefined;
  }
  const key = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const weekday = (new Date(noon).getUTCDay() + 6) % 7;
  switch (preset) {
    case "today":
      return { start: today, end: today };
    case "last7":
      return { start: key(noon - 6 * DAY_MS), end: today };
    case "last30":
      return { start: key(noon - 29 * DAY_MS), end: today };
    case "thisWeek":
      return {
        start: key(noon - weekday * DAY_MS),
        end: key(noon + (6 - weekday) * DAY_MS),
      };
    case "nextWeek":
      return {
        start: key(noon + (7 - weekday) * DAY_MS),
        end: key(noon + (13 - weekday) * DAY_MS),
      };
    case "thisMonth": {
      const last = new Date(Date.UTC(y, m, 0, 12));
      return { start: `${today.slice(0, 7)}-01`, end: key(last.getTime()) };
    }
    case "next30":
      return { start: today, end: key(noon + 29 * DAY_MS) };
    default:
      return undefined;
  }
};

export const RANGE_PRESET_LABELS: Record<string, string> = {
  today: "Today",
  last7: "Last 7 days",
  last30: "Last 30 days",
  thisWeek: "This week",
  nextWeek: "Next week",
  thisMonth: "This month",
  next30: "Next 30 days",
};

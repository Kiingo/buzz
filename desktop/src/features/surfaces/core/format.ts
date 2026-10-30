// Generated from the Kiingo surface renderer packages at c6609e08a498bb4161d453f1ac533d04f66d8bbc; do not edit here.
import { asNumber, isObject } from "./json";
import { formatPlainNumber, plainText } from "./text";

// Display formatting shared by the web renderers. Locale-aware through Intl,
// with plain fallbacks where Intl is missing a currency or zone.

export const formatNumber = (value: number, locale?: string): string => {
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
      value,
    );
  } catch {
    return formatPlainNumber(value);
  }
};

export const formatCurrency = (
  value: number,
  currency = "USD",
  locale?: string,
): string => {
  // Only an ISO 4217 code; anything else is the number alone (79 nit).
  if (!/^[A-Z]{3}$/u.test(currency)) {
    return formatNumber(value, locale);
  }
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${formatNumber(value, locale)} ${currency}`;
  }
};

export const formatPercent = (value: number, locale?: string): string => {
  try {
    // Values over 1 are taken as already in percent.
    return new Intl.NumberFormat(locale, {
      style: "percent",
      maximumFractionDigits: 1,
    }).format(Math.abs(value) > 1 ? value / 100 : value);
  } catch {
    return `${formatPlainNumber(value)}%`;
  }
};

export const formatValue = (
  value: number,
  format: "number" | "currency" | "percent" | undefined,
  currency?: string,
  locale?: string,
): string =>
  format === "currency"
    ? formatCurrency(value, currency, locale)
    : format === "percent"
      ? formatPercent(value, locale)
      : formatNumber(value, locale);

/** Bytes as "482 KB". */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const TIME_ONLY = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/u;

/** A date-only string as local midnight; anything else through Date. */
export const parseDate = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  if (DATE_ONLY.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y!, m! - 1, d!);
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time);
};

export const isDateOnly = (value: string): boolean => DATE_ONLY.test(value);
export const isTimeOnly = (value: string): boolean => TIME_ONLY.test(value);

const formatWith = (
  date: Date,
  options: Intl.DateTimeFormatOptions,
  locale?: string,
): string => {
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    const { timeZone: _ignored, ...rest } = options;
    return new Intl.DateTimeFormat(locale, rest).format(date);
  }
};

/** A cell or prop date as text: date-only stays a date; times get a time. */
export const formatDateText = (
  value: unknown,
  timeZone?: string,
  locale?: string,
): string | undefined => {
  if (typeof value === "string" && isTimeOnly(value)) {
    return value.slice(0, 5);
  }
  const date = parseDate(value);
  if (!date) {
    return plainText(value, 200);
  }
  if (typeof value === "string" && isDateOnly(value)) {
    return formatWith(date, { dateStyle: "medium" }, locale);
  }
  return formatWith(
    date,
    {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    },
    locale,
  );
};

/** "Tue, Oct 28" for grouping slots by day. */
export const formatDay = (
  date: Date,
  timeZone?: string,
  locale?: string,
): string =>
  formatWith(
    date,
    {
      weekday: "short",
      month: "short",
      day: "numeric",
      ...(timeZone ? { timeZone } : {}),
    },
    locale,
  );

export const formatTime = (
  date: Date,
  timeZone?: string,
  locale?: string,
): string =>
  formatWith(
    date,
    { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) },
    locale,
  );

/** A day key in a zone, for grouping (YYYY-MM-DD). */
export const dayKey = (date: Date, timeZone?: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
};

/** "2 h 14 min" between two times; "now" under a minute. */
export const formatDuration = (ms: number): string => {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  if (minutes < 1) {
    return "less than a minute";
  }
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const parts: string[] = [];
  if (days) {
    parts.push(`${days} d`);
  }
  if (hours) {
    parts.push(`${hours} h`);
  }
  if (rest && days === 0) {
    parts.push(`${rest} min`);
  }
  return parts.join(" ");
};

/** Countdown text: "in 2 h 14 min", "3 d ago", or "now". */
export const countdownText = (
  target: Date,
  mode: "until" | "since",
  now: number,
): string => {
  const delta = target.getTime() - now;
  if (mode === "since") {
    return delta > 0
      ? `in ${formatDuration(delta)}`
      : `${formatDuration(delta)} ago`;
  }
  if (Math.abs(delta) < 60_000) {
    return "now";
  }
  return delta > 0
    ? `in ${formatDuration(delta)}`
    : `${formatDuration(delta)} ago`;
};

/** Text for a table cell or list value of any shape. */
export const cellText = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number") {
    return plainText(value, 500, true) ?? "";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (isObject(value)) {
    return (
      plainText(
        value.title ?? value.label ?? value.text ?? value.name ?? value.email,
        500,
      ) ?? ""
    );
  }
  if (Array.isArray(value)) {
    return value.map(cellText).filter(Boolean).join(", ");
  }
  return "";
};

export const numberValue = (value: unknown): number | undefined =>
  asNumber(value);

/** Rich text value (`{format, text}` or a plain string) as its Markdown text. */
export const richTextOf = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (isObject(value) && typeof value.text === "string") {
    return value.text;
  }
  return "";
};

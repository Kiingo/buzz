// Generated from the Kiingo surface renderer packages at ec8a842a062bf8f90327ca1b45c1fe31730d12f4; do not edit here.
import { asNumber, isObject } from "./json";
import type { Tone } from "./model";
import { cleanText, formatPlainNumber, plainText } from "./text";

// Live views (GU-B, 2026-10-29): LiveLog, Gauge, Sparkline. Pure helpers;
// the Swift kit mirrors them (`UiLive` in KiingoMobileCore).

const TONES = new Set<Tone>([
  "default",
  "muted",
  "success",
  "warning",
  "danger",
]);

const toneOf = (value: unknown): Tone | undefined =>
  typeof value === "string" && TONES.has(value as Tone)
    ? (value as Tone)
    : undefined;

// --- LiveLog ----------------------------------------------------------------------

export const LIVE_LOG_MAX_LINES = 500;
export const LIVE_LOG_DEFAULT_LINES = 200;

export type LogLevel = "debug" | "info" | "success" | "warning" | "error";

export type LogLine = {
  /** Index in the bound array: a stable row key while lines only append. */
  index: number;
  text: string;
  at?: string;
  level?: LogLevel;
  source?: string;
};

const LEVELS = new Set<LogLevel>([
  "debug",
  "info",
  "success",
  "warning",
  "error",
]);

/** The level's semantic tone. */
export const logLevelTone = (level: LogLevel | undefined): Tone =>
  level === "error"
    ? "danger"
    : level === "warning"
      ? "warning"
      : level === "success"
        ? "success"
        : level === "debug"
          ? "muted"
          : "default";

/**
 * The newest `max` lines (default 200, at most 500), oldest first, each
 * plain text on one line, with how many earlier lines were left out.
 */
export const logLines = (
  value: unknown,
  max: unknown,
): { lines: LogLine[]; earlier: number } => {
  const items = Array.isArray(value) ? value : [];
  const cap = Math.min(
    LIVE_LOG_MAX_LINES,
    Math.max(
      1,
      typeof max === "number" && Number.isInteger(max)
        ? max
        : LIVE_LOG_DEFAULT_LINES,
    ),
  );
  const start = Math.max(0, items.length - cap);
  const lines: LogLine[] = [];
  for (let index = start; index < items.length; index += 1) {
    const item: unknown = items[index];
    if (typeof item === "string") {
      lines.push({ index, text: cleanText(item, 2000) });
      continue;
    }
    if (!isObject(item) || typeof item.text !== "string") {
      continue;
    }
    const level =
      typeof item.level === "string" && LEVELS.has(item.level as LogLevel)
        ? (item.level as LogLevel)
        : undefined;
    const at = plainText(item.at, 64);
    const source = plainText(item.source, 60);
    lines.push({
      index,
      text: cleanText(item.text, 2000),
      ...(at ? { at } : {}),
      ...(level ? { level } : {}),
      ...(source ? { source } : {}),
    });
  }
  return { lines, earlier: start };
};

/** The lines as copied: "[source] text", one per line. */
export const logCopyText = (lines: readonly LogLine[]): string =>
  lines
    .map((line) => (line.source ? `[${line.source}] ${line.text}` : line.text))
    .join("\n");

// --- Gauge ------------------------------------------------------------------------

export type GaugeModel = {
  value: number;
  min: number;
  max: number;
  /** 0…1 along the track, clamped. */
  fraction: number;
  tone: Tone;
  zones: Array<{ from: number; to: number; tone: Tone }>;
  /** "72%" */
  valueText: string;
  /** "CPU: 72%, range 0 to 100, warning" */
  spoken: string;
};

export const gaugeModel = (
  props: Record<string, unknown>,
  rawValue: unknown,
  label: string,
): GaugeModel | undefined => {
  const value = asNumber(rawValue);
  if (value === undefined) {
    return undefined;
  }
  const min =
    typeof props.min === "number" && Number.isFinite(props.min) ? props.min : 0;
  let max =
    typeof props.max === "number" && Number.isFinite(props.max)
      ? props.max
      : 100;
  if (max <= min) {
    max = min + 1;
  }
  const unit = plainText(props.unit, 20) ?? "";
  const raw = Array.isArray(props.zones) ? props.zones.slice(0, 5) : [];
  const starts = raw
    .filter(isObject)
    .map((zone) => ({ from: asNumber(zone.from), tone: toneOf(zone.tone) }))
    .filter(
      (zone): zone is { from: number; tone: Tone } =>
        zone.from !== undefined && zone.tone !== undefined,
    )
    .sort((a, b) => a.from - b.from);
  const zones = starts
    .map((zone, index) => ({
      from: Math.max(min, Math.min(max, zone.from)),
      to: Math.max(min, Math.min(max, starts[index + 1]?.from ?? max)),
      tone: zone.tone,
    }))
    .filter((zone) => zone.to > zone.from);
  const current = [...starts].reverse().find((zone) => value >= zone.from);
  const tone = current?.tone ?? "default";
  const valueText = `${formatPlainNumber(value)}${unit && unit !== "%" ? " " : ""}${unit}`;
  const fraction = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const spoken = `${label}: ${valueText}, range ${formatPlainNumber(min)} to ${formatPlainNumber(max)}${
    tone !== "default" ? `, ${tone}` : ""
  }`;
  return { value, min, max, fraction, tone, zones, valueText, spoken };
};

/** A point on the dial's half circle for `fraction` (0 left, 1 right), in a unit box. */
export const dialPoint = (
  fraction: number,
  radius = 1,
): { x: number; y: number } => {
  const angle = Math.PI * (1 - Math.max(0, Math.min(1, fraction)));
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
};

// --- Sparkline --------------------------------------------------------------------

export type SparklineModel = {
  values: number[];
  min: number;
  max: number;
  last: number;
  /** Points in a 0…1 box, y down (0 is the top). */
  points: Array<{ x: number; y: number }>;
  lastText: string;
  spoken: string;
};

export const sparklineModel = (
  raw: unknown,
  label: string | undefined,
  unit: string | undefined,
): SparklineModel | undefined => {
  const values = (Array.isArray(raw) ? raw : [])
    .slice(-500)
    .map(asNumber)
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) {
    return undefined;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const last = values[values.length - 1]!;
  const points = values.map((value, index) => ({
    x: values.length === 1 ? 0.5 : index / (values.length - 1),
    y: max === min ? 0.5 : 1 - (value - min) / span,
  }));
  const suffix = unit ? ` ${unit}` : "";
  const lastText = `${formatPlainNumber(last)}${suffix}`;
  const spoken = `${label ? `${label}: ` : ""}${values.length} values, from ${formatPlainNumber(
    values[0]!,
  )} to ${lastText}, low ${formatPlainNumber(min)}, high ${formatPlainNumber(max)}`;
  return { values, min, max, last, points, lastText, spoken };
};

/** An SVG path through the points in a `width`×`height` box (no HTML: a path string). */
export const sparklinePath = (
  points: ReadonlyArray<{ x: number; y: number }>,
  width: number,
  height: number,
  inset = 2,
): string =>
  points
    .map((point, index) => {
      const x = inset + point.x * (width - inset * 2);
      const y = inset + point.y * (height - inset * 2);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

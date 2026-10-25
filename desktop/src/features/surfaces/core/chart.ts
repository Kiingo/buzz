// Generated from the Kiingo surface renderer packages; do not edit here.
import { asNumber, isObject } from "./json";
import { cellText, formatValue, parseDate } from "./format";
import { plainText } from "./text";

// Chart geometry for the Chart component (§4.2), drawn as SVG by the web
// renderers. Colors are palette slots (0-7) the app maps to its own chart
// palette; agents never set colors.

export type ChartKind =
  | "line"
  | "bar"
  | "stackedBar"
  | "area"
  | "pie"
  | "donut"
  | "scatter"
  | "sparkline";

export type ChartInput = {
  kind: ChartKind;
  rows: unknown[];
  x: string;
  series: Array<{ key: string; label: string }>;
  xType?: "category" | "time" | "number";
  valueFormat?: "number" | "currency" | "percent";
  currency?: string;
  goal?: number;
  width?: number;
  height?: number;
};

export type ChartTick = { at: number; label: string };
export type ChartMark = {
  x: number;
  y: number;
  w: number;
  h: number;
  value: number;
  label: string;
};
export type ChartSeriesGeometry = {
  label: string;
  slot: number;
  /** Line path (line, area, sparkline). */
  line?: string;
  /** Filled area path (area). */
  area?: string;
  bars: ChartMark[];
  points: Array<{ cx: number; cy: number; value: number; label: string }>;
};
export type ChartSlice = {
  path: string;
  label: string;
  value: number;
  slot: number;
  share: number;
};

export type ChartGeometry = {
  width: number;
  height: number;
  plot: { left: number; top: number; right: number; bottom: number };
  xTicks: ChartTick[];
  yTicks: ChartTick[];
  series: ChartSeriesGeometry[];
  slices: ChartSlice[];
  goal?: { y: number; label: string };
  empty: boolean;
  /** A text summary for screen readers and the HTML fallback. */
  summary: string;
};

export const CHART_SLOTS = 8;

const niceStep = (span: number, count: number): number => {
  const raw = span / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  const scaled = raw / power;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return nice * power;
};

const fixed = (value: number) => Math.round(value * 100) / 100;

const arc = (
  cx: number,
  cy: number,
  r: number,
  inner: number,
  start: number,
  end: number,
): string => {
  const large = end - start > Math.PI ? 1 : 0;
  const point = (radius: number, angle: number) =>
    `${fixed(cx + radius * Math.sin(angle))} ${fixed(cy - radius * Math.cos(angle))}`;
  if (end - start >= Math.PI * 2 - 1e-6) {
    // A full circle needs two arcs.
    const mid = start + Math.PI;
    return inner > 0
      ? `M ${point(r, start)} A ${r} ${r} 0 1 1 ${point(r, mid)} A ${r} ${r} 0 1 1 ${point(r, start)} M ${point(inner, start)} A ${inner} ${inner} 0 1 0 ${point(inner, mid)} A ${inner} ${inner} 0 1 0 ${point(inner, start)} Z`
      : `M ${point(r, start)} A ${r} ${r} 0 1 1 ${point(r, mid)} A ${r} ${r} 0 1 1 ${point(r, start)} Z`;
  }
  if (inner > 0) {
    return `M ${point(r, start)} A ${r} ${r} 0 ${large} 1 ${point(r, end)} L ${point(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${point(inner, start)} Z`;
  }
  return `M ${fixed(cx)} ${fixed(cy)} L ${point(r, start)} A ${r} ${r} 0 ${large} 1 ${point(r, end)} Z`;
};

export const chartGeometry = (input: ChartInput): ChartGeometry => {
  const sparkline = input.kind === "sparkline";
  const width = input.width ?? (sparkline ? 160 : 560);
  const height = input.height ?? (sparkline ? 36 : 220);
  const round = input.kind === "pie" || input.kind === "donut";
  const series = (
    round ? input.series.slice(0, 1) : input.series.slice(0, CHART_SLOTS)
  ).filter((s) => s.key);
  const rows = input.rows.slice(0, 500).filter(isObject);
  const fmt = (value: number) =>
    formatValue(value, input.valueFormat, input.currency);
  const empty: ChartGeometry = {
    width,
    height,
    plot: { left: 0, top: 0, right: width, bottom: height },
    xTicks: [],
    yTicks: [],
    series: [],
    slices: [],
    empty: true,
    summary: "No data",
  };
  if (rows.length === 0 || series.length === 0) {
    return empty;
  }
  const label = (row: Record<string, unknown>): string => {
    const raw = row[input.x];
    if (input.xType === "time") {
      const date = parseDate(raw);
      if (date) {
        return new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
        }).format(date);
      }
    }
    return cellText(raw) || "—";
  };

  if (round) {
    const key = series[0]!.key;
    const values = rows.map((row) => Math.max(0, asNumber(row[key]) ?? 0));
    const total = values.reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
      return empty;
    }
    const r = Math.min(width, height) / 2 - 4;
    const cx = width / 2;
    const cy = height / 2;
    let angle = 0;
    const slices = rows.map((row, index) => {
      const share = values[index]! / total;
      const start = angle;
      angle += share * Math.PI * 2;
      return {
        path: arc(
          cx,
          cy,
          r,
          input.kind === "donut" ? r * 0.55 : 0,
          start,
          angle,
        ),
        label: label(row),
        value: values[index]!,
        slot: index % CHART_SLOTS,
        share,
      };
    });
    return {
      ...empty,
      empty: false,
      slices,
      summary: slices
        .map(
          (s) => `${s.label}: ${fmt(s.value)} (${Math.round(s.share * 100)}%)`,
        )
        .join("; "),
    };
  }

  const plot = sparkline
    ? { left: 2, top: 2, right: width - 2, bottom: height - 2 }
    : { left: 52, top: 12, right: width - 12, bottom: height - 28 };
  const stacked = input.kind === "stackedBar";
  const barLike = input.kind === "bar" || stacked;
  // Values per row and series.
  const values = rows.map((row) => series.map((s) => asNumber(row[s.key])));
  let min = 0;
  let max = 0;
  for (const rowValues of values) {
    if (stacked) {
      const positive = rowValues.reduce<number>(
        (sum, v) => sum + Math.max(0, v ?? 0),
        0,
      );
      const negative = rowValues.reduce<number>(
        (sum, v) => sum + Math.min(0, v ?? 0),
        0,
      );
      max = Math.max(max, positive);
      min = Math.min(min, negative);
    } else {
      for (const v of rowValues) {
        if (v !== undefined) {
          max = Math.max(max, v);
          min = Math.min(min, v);
        }
      }
    }
  }
  if (input.goal !== undefined) {
    max = Math.max(max, input.goal);
    min = Math.min(min, input.goal);
  }
  if (!barLike && !sparkline) {
    // Lines need not start at zero, but keep zero in view when close.
    const lows = values.flat().filter((v): v is number => v !== undefined);
    const low = Math.min(...lows, input.goal ?? Infinity);
    if (low > 0 && low > max * 0.5) {
      min = low - (max - low) * 0.1;
    }
  }
  if (max === min) {
    max = min + 1;
  }
  const step = niceStep(max - min, 4);
  const yMin = Math.floor(min / step) * step;
  const yMax = Math.ceil(max / step) * step;
  const y = (value: number) =>
    plot.bottom - ((value - yMin) / (yMax - yMin)) * (plot.bottom - plot.top);

  // X positions: numeric/time scales or evenly spaced categories.
  const numeric = input.xType === "number" || input.xType === "time";
  const xs = rows.map((row) =>
    input.xType === "time"
      ? parseDate(row[input.x])?.getTime()
      : asNumber(row[input.x]),
  );
  const useScale =
    numeric && !barLike && xs.every((v) => v !== undefined) && rows.length > 1;
  const xMin = useScale ? Math.min(...(xs as number[])) : 0;
  const xMax = useScale ? Math.max(...(xs as number[])) : 0;
  const band = (plot.right - plot.left) / rows.length;
  const xAt = (index: number): number =>
    useScale && xMax > xMin
      ? plot.left +
        (((xs[index] as number) - xMin) / (xMax - xMin)) *
          (plot.right - plot.left)
      : barLike
        ? plot.left + band * (index + 0.5)
        : rows.length === 1
          ? (plot.left + plot.right) / 2
          : plot.left + (index / (rows.length - 1)) * (plot.right - plot.left);

  const geometry: ChartSeriesGeometry[] = series.map((s, slot) => ({
    label: s.label,
    slot,
    bars: [],
    points: [],
  }));
  const stackPos = rows.map(() => 0);
  const stackNeg = rows.map(() => 0);
  rows.forEach((row, index) => {
    series.forEach((_series, slot) => {
      const value = values[index]![slot];
      if (value === undefined) {
        return;
      }
      const g = geometry[slot]!;
      const rowLabel = label(row);
      if (barLike) {
        const inner = band * 0.72;
        if (stacked) {
          const base = value >= 0 ? stackPos[index]! : stackNeg[index]!;
          const top = base + value;
          if (value >= 0) {
            stackPos[index] = top;
          } else {
            stackNeg[index] = top;
          }
          const y0 = y(base);
          const y1 = y(top);
          g.bars.push({
            x: fixed(xAt(index) - inner / 2),
            y: fixed(Math.min(y0, y1)),
            w: fixed(inner),
            h: fixed(Math.abs(y0 - y1)),
            value,
            label: rowLabel,
          });
        } else {
          const each = inner / series.length;
          const y0 = y(0);
          const y1 = y(value);
          g.bars.push({
            x: fixed(xAt(index) - inner / 2 + each * slot),
            y: fixed(Math.min(y0, y1)),
            w: fixed(Math.max(1, each - 1)),
            h: fixed(Math.abs(y0 - y1)),
            value,
            label: rowLabel,
          });
        }
      } else {
        g.points.push({
          cx: fixed(xAt(index)),
          cy: fixed(y(value)),
          value,
          label: rowLabel,
        });
      }
    });
  });
  if (!barLike) {
    for (const g of geometry) {
      if (g.points.length === 0) {
        continue;
      }
      if (input.kind !== "scatter") {
        g.line = g.points
          .map((p, i) => `${i === 0 ? "M" : "L"} ${p.cx} ${p.cy}`)
          .join(" ");
      }
      if (input.kind === "area") {
        const first = g.points[0]!;
        const last = g.points[g.points.length - 1]!;
        const base = fixed(y(Math.max(yMin, Math.min(0, yMax))));
        g.area = `${g.line} L ${last.cx} ${base} L ${first.cx} ${base} Z`;
      }
    }
  }
  const yTicks: ChartTick[] = [];
  if (!sparkline) {
    for (let v = yMin; v <= yMax + step / 2; v += step) {
      yTicks.push({ at: fixed(y(v)), label: fmt(Number(v.toPrecision(10))) });
    }
  }
  const xTicks: ChartTick[] = [];
  if (!sparkline) {
    const every = Math.max(1, Math.ceil(rows.length / 8));
    rows.forEach((row, index) => {
      if (index % every === 0) {
        xTicks.push({ at: fixed(xAt(index)), label: label(row) });
      }
    });
  }
  const summary = series
    .map((s, slot) => {
      const parts = rows
        .slice(0, 24)
        .map((row, index) => {
          const value = values[index]![slot];
          return value === undefined ? null : `${label(row)} ${fmt(value)}`;
        })
        .filter(Boolean);
      return `${s.label}: ${parts.join(", ")}${rows.length > 24 ? ", …" : ""}`;
    })
    .join("; ");
  return {
    width,
    height,
    plot,
    xTicks,
    yTicks,
    series: geometry,
    slices: [],
    ...(input.goal !== undefined
      ? { goal: { y: fixed(y(input.goal)), label: `Goal ${fmt(input.goal)}` } }
      : {}),
    empty: false,
    summary,
  };
};

/** The chart props of a component, read against its data. */
export const chartSeriesOf = (
  raw: unknown,
): Array<{ key: string; label: string }> =>
  (Array.isArray(raw) ? raw : [])
    .filter(isObject)
    .map((item) => ({
      key: typeof item.key === "string" ? item.key : "",
      label:
        plainText(item.label, 40) ??
        (typeof item.key === "string" ? item.key : ""),
    }))
    .filter((item) => item.key);

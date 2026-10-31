// Generated from the Kiingo surface renderer packages at 5736645688767c7e713cc125961539139af6ba91; do not edit here.
import { useId } from "react";
import {
  CHART_SLOTS,
  chartGeometry,
  chartSeriesOf,
  childKey,
  type ChartKind,
} from "../core";
import { cn } from "./cn";
import { useNodeContext, type NodeProps } from "./context";
import { TooLargeRow } from "./ui";

// §4.2 Chart as SVG from the core's geometry. Colours are the app's chart
// slots (theme tokens), never the agent's.

/** The eight chart slots as text colours (marks use currentColor). */
export const CHART_SLOT_CLASSES = [
  "text-primary",
  "text-emerald-500",
  "text-amber-500",
  "text-sky-400",
  "text-slate-500",
  "text-emerald-700",
  "text-amber-800",
  "text-sky-700",
];

const slotClass = (slot: number) =>
  CHART_SLOT_CLASSES[slot % CHART_SLOT_CLASSES.length]!;

const KINDS = new Set<ChartKind>([
  "line",
  "bar",
  "stackedBar",
  "area",
  "pie",
  "donut",
  "scatter",
  "sparkline",
]);

export const ChartView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const titleId = useId();
  const rawKind = context.string(component, "kind") as ChartKind | undefined;
  const kind: ChartKind = rawKind && KINDS.has(rawKind) ? rawKind : "bar";
  const xType = context.string(component, "xType") as
    | "category"
    | "time"
    | "number"
    | undefined;
  const valueFormat = context.string(component, "valueFormat") as
    | "number"
    | "currency"
    | "percent"
    | undefined;
  const goal = context.number(component, "goal", scope);
  const series = chartSeriesOf(component.props.series);
  const rows = context.list(component, "data", scope).slice(0, 500);
  // Points drawn within the surface's shared cell budget (79 W6 SHOULD 5).
  const drawn = context.claimCells(
    `chart:${childKey(component.id, scope)}`,
    rows.length,
    kind === "pie" || kind === "donut"
      ? 1
      : Math.max(1, Math.min(series.length, CHART_SLOTS)),
  );
  const geometry = chartGeometry({
    kind,
    rows: rows.slice(0, drawn),
    x: context.string(component, "x") ?? "x",
    series,
    ...(xType ? { xType } : {}),
    ...(valueFormat ? { valueFormat } : {}),
    ...(context.string(component, "currency")
      ? { currency: context.string(component, "currency")! }
      : {}),
    ...(goal !== undefined ? { goal } : {}),
  });
  const caption =
    context.text(component, "caption", scope, 200) ??
    context.text(component, "unit", scope, 20) ??
    context.text(component, "currency", scope, 20);
  if (geometry.empty) {
    return drawn < rows.length ? (
      <TooLargeRow />
    ) : (
      <p className="text-xs text-muted-foreground">No data</p>
    );
  }
  const round = geometry.slices.length > 0;
  const legend = round
    ? geometry.slices.map((slice) => ({ label: slice.label, slot: slice.slot }))
    : geometry.series.length > 1
      ? geometry.series.map((series) => ({
          label: series.label,
          slot: series.slot,
        }))
      : [];
  const sparkline = kind === "sparkline";
  return (
    <figure className="flex flex-col gap-1.5">
      <svg
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        className={cn("w-full", sparkline ? "h-9" : "h-auto max-h-64")}
        role="img"
        aria-labelledby={titleId}
        preserveAspectRatio={sparkline ? "none" : "xMidYMid meet"}
      >
        <title id={titleId}>{geometry.summary}</title>
        {geometry.yTicks.map((tick, index) => (
          <g key={`y${index}`} className="text-muted-foreground">
            <line
              x1={geometry.plot.left}
              x2={geometry.plot.right}
              y1={tick.at}
              y2={tick.at}
              stroke="currentColor"
              strokeOpacity={0.15}
            />
            <text
              x={geometry.plot.left - 6}
              y={tick.at}
              dy="0.32em"
              textAnchor="end"
              fontSize="10"
              fill="currentColor"
            >
              {tick.label}
            </text>
          </g>
        ))}
        {geometry.xTicks.map((tick, index) => (
          <text
            key={`x${index}`}
            x={tick.at}
            y={geometry.plot.bottom + 16}
            textAnchor="middle"
            fontSize="10"
            fill="currentColor"
            className="text-muted-foreground"
          >
            {tick.label.length > 14
              ? `${tick.label.slice(0, 13)}…`
              : tick.label}
          </text>
        ))}
        {geometry.slices.map((slice, index) => (
          <path
            key={`s${index}`}
            d={slice.path}
            fill="currentColor"
            fillRule="evenodd"
            className={slotClass(slice.slot)}
          />
        ))}
        {geometry.series.map((series) => (
          <g key={`g${series.slot}`} className={slotClass(series.slot)}>
            {series.area ? (
              <path d={series.area} fill="currentColor" fillOpacity={0.18} />
            ) : null}
            {series.line ? (
              <path
                d={series.line}
                fill="none"
                stroke="currentColor"
                strokeWidth={sparkline ? 1.5 : 2}
              />
            ) : null}
            {series.bars.map((bar, index) => (
              <rect
                key={index}
                x={bar.x}
                y={bar.y}
                width={bar.w}
                height={bar.h}
                rx={2}
                fill="currentColor"
              />
            ))}
            {kind === "scatter"
              ? series.points.map((point, index) => (
                  <circle
                    key={index}
                    cx={point.cx}
                    cy={point.cy}
                    r={3.5}
                    fill="currentColor"
                  />
                ))
              : null}
          </g>
        ))}
        {geometry.goal ? (
          <g className="text-muted-foreground">
            <line
              x1={geometry.plot.left}
              x2={geometry.plot.right}
              y1={geometry.goal.y}
              y2={geometry.goal.y}
              stroke="currentColor"
              strokeDasharray="4 3"
            />
            <text
              x={geometry.plot.left + 4}
              y={geometry.goal.y - 4}
              fontSize="10"
              fill="currentColor"
            >
              {geometry.goal.label}
            </text>
          </g>
        ) : null}
      </svg>
      {legend.length > 0 ? (
        <ul
          className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
          aria-hidden
        >
          {legend.map((entry, index) => (
            <li key={index} className="inline-flex items-center gap-1">
              <span
                className={cn(
                  "h-2 w-2 rounded-sm bg-current",
                  slotClass(entry.slot),
                )}
              />
              {entry.label}
            </li>
          ))}
        </ul>
      ) : null}
      {drawn < rows.length ? <TooLargeRow /> : null}
      {caption ? (
        <figcaption className="text-2xs text-muted-foreground">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
};

/** A metric's trend line. */
export const Sparkline = ({ values }: { values: number[] }) => {
  const geometry = chartGeometry({
    kind: "sparkline",
    rows: values.slice(0, 200).map((value, index) => ({ x: index, y: value })),
    x: "x",
    series: [{ key: "y", label: "Trend" }],
    xType: "number",
  });
  const line = geometry.series[0]?.line;
  if (!line) {
    return null;
  }
  return (
    <svg
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      preserveAspectRatio="none"
      className="h-6 w-full text-primary"
      aria-hidden="true"
    >
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};

// Generated from the Kiingo surface renderer packages at 0d7eecf6d3b78f4c52514554faa33adb7a1fe131; do not edit here.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  dialPoint,
  gaugeModel,
  logCopyText,
  logLevelTone,
  logLines,
  ownEntry,
  sparklineModel,
  sparklinePath,
} from "../core";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "./cn";
import { useNodeContext, type NodeProps } from "./context";
import { CopyButton } from "./copy";
import { toneText } from "./ui";

// Live views (GU-B): LiveLog, Gauge, Sparkline. They redraw from the
// surface data on each revision; nothing here polls or loads.

const HEIGHTS: Record<string, string> = {
  sm: "max-h-40",
  md: "max-h-72",
  lg: "max-h-[28rem]",
};

/**
 * Rows drawn at once; the rest are spacers. Lines don't wrap (the feed
 * scrolls sideways like a terminal), so every row is ROW_PX tall.
 */
const ROW_PX = 20;
const OVERSCAN = 20;

const LevelGlyph = ({ level }: { level: string | undefined }) => {
  const Glyph =
    level === "error"
      ? XCircle
      : level === "warning"
        ? AlertTriangle
        : level === "success"
          ? CheckCircle2
          : level === "info"
            ? Info
            : null;
  return Glyph ? (
    <Glyph aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
  ) : (
    <span aria-hidden className="w-3 shrink-0" />
  );
};

export const LiveLogView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const title = context.text(component, "title", scope, 120);
  const { lines, earlier } = logLines(
    context.value(component, "lines", scope),
    component.props.maxLines,
  );
  const quoted = context.isUntrusted(component, "lines", scope);
  const follow = component.props.follow !== false;
  const height =
    ownEntry(HEIGHTS, context.string(component, "height") ?? "md") ??
    HEIGHTS.md;
  const empty =
    context.text(component, "emptyText", scope, 200) ?? "Nothing yet.";
  const box = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const [rows, setRows] = useState({ start: 0, end: 80 });
  const last = lines[lines.length - 1]?.index ?? -1;
  // Follow the end only while the person hasn't scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `last` is the trigger: follow the end when a new line arrives.
  useLayoutEffect(() => {
    const element = box.current;
    if (element && follow && atEnd) {
      element.scrollTop = element.scrollHeight;
    }
  }, [last, follow, atEnd]);
  const measure = () => {
    const element = box.current;
    if (!element) {
      return;
    }
    setAtEnd(
      element.scrollHeight - element.scrollTop - element.clientHeight < 24,
    );
    const first = Math.max(
      0,
      Math.floor(element.scrollTop / ROW_PX) - OVERSCAN,
    );
    const count = Math.ceil(element.clientHeight / ROW_PX) + OVERSCAN * 2;
    setRows({ start: first, end: first + count });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the line count changes.
  useEffect(measure, [lines.length]);
  // A calm announcement of the newest line, at most every 4 s.
  const [spoken, setSpoken] = useState("");
  const lastSpoken = useRef(0);
  const newest = lines[lines.length - 1]?.text;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `last` is the trigger: a repeated line is still a new line.
  useEffect(() => {
    if (!newest || Date.now() - lastSpoken.current < 4000) {
      return;
    }
    lastSpoken.current = Date.now();
    setSpoken(newest);
  }, [last, newest]);
  const start = Math.min(rows.start, Math.max(0, lines.length - 1));
  const end = Math.min(lines.length, Math.max(rows.end, start + 1));
  const shown = lines.slice(start, end);
  return (
    <figure className="flex flex-col gap-1">
      {title || quoted || component.props.copyable !== false ? (
        <figcaption className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {[quoted ? "Quoted" : "", title ?? ""].filter(Boolean).join(" · ")}
          </span>
          {component.props.copyable === false ? null : (
            <CopyButton text={logCopyText(lines)} what="log" />
          )}
        </figcaption>
      ) : null}
      <div
        ref={box}
        onScroll={measure}
        role="log"
        aria-label={title ?? "Log"}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling log must take keyboard focus to scroll.
        tabIndex={0}
        className={cn(
          "overflow-auto rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-xs",
          quoted ? "border-l-4 border-l-muted-foreground/40 italic" : "",
          height,
        )}
      >
        {earlier > 0 ? (
          <p className="py-0.5 text-muted-foreground">
            {earlier} earlier {earlier === 1 ? "line" : "lines"}
          </p>
        ) : null}
        {lines.length === 0 ? (
          <p className="py-0.5 text-muted-foreground">{empty}</p>
        ) : null}
        <div style={{ height: start * ROW_PX }} aria-hidden />
        {shown.map((line) => (
          <div
            key={line.index}
            className={cn(
              "flex h-5 items-start gap-1.5 whitespace-pre leading-5",
              toneText(logLevelTone(line.level)),
            )}
          >
            <LevelGlyph level={line.level} />
            {line.source ? (
              <span className="shrink-0 text-muted-foreground">
                [{line.source}]
              </span>
            ) : null}
            <span>{line.text}</span>
          </div>
        ))}
        <div
          style={{ height: Math.max(0, lines.length - end) * ROW_PX }}
          aria-hidden
        />
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {spoken}
      </span>
    </figure>
  );
};

const ZONE_STROKE: Record<string, string> = {
  default: "text-primary",
  success: "text-emerald-500",
  warning: "text-amber-500",
  danger: "text-destructive",
  muted: "text-muted-foreground",
};

const ZONE_FILL: Record<string, string> = {
  default: "bg-primary",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-destructive",
  muted: "bg-muted-foreground",
};

export const GaugeView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const label = context.text(component, "label", scope, 120) ?? "Reading";
  const model = gaugeModel(
    component.props,
    context.value(component, "value", scope),
    label,
  );
  if (!model) {
    return <p className="text-xs text-muted-foreground">{label}: no reading</p>;
  }
  const aria = {
    role: "meter",
    "aria-label": label,
    "aria-valuemin": model.min,
    "aria-valuemax": model.max,
    "aria-valuenow": model.value,
    "aria-valuetext": model.spoken,
  } as const;
  const span = model.max - model.min;
  if (context.string(component, "style") === "bar") {
    return (
      <div className="flex flex-col gap-1" {...aria}>
        <div className="flex items-baseline justify-between text-xs">
          <span>{label}</span>
          <span
            className={cn("font-medium tabular-nums", toneText(model.tone))}
          >
            {model.valueText}
          </span>
        </div>
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
          {model.zones.map((zone) => (
            <div
              key={zone.from}
              aria-hidden
              className={cn(
                "absolute inset-y-0 opacity-25",
                ownEntry(ZONE_FILL, zone.tone),
              )}
              style={{
                left: `${((zone.from - model.min) / span) * 100}%`,
                width: `${((zone.to - zone.from) / span) * 100}%`,
              }}
            />
          ))}
          <div
            aria-hidden
            className={cn(
              "relative h-full rounded-full",
              ownEntry(ZONE_FILL, model.tone),
            )}
            style={{ width: `${model.fraction * 100}%` }}
          />
        </div>
      </div>
    );
  }
  // The dial: a half circle in a 100×56 box, centre (50, 50), radius 40.
  const point = (fraction: number) => {
    const at = dialPoint(fraction, 40);
    return `${(50 + at.x).toFixed(2)} ${(50 - at.y).toFixed(2)}`;
  };
  const arc = (from: number, to: number) =>
    `M ${point(from)} A 40 40 0 0 1 ${point(to)}`;
  const needle = dialPoint(model.fraction, 32);
  return (
    <div className="inline-flex flex-col items-center gap-0.5" {...aria}>
      <svg viewBox="0 0 100 58" className="h-20 w-36" aria-hidden="true">
        <path
          d={arc(0, 1)}
          fill="none"
          strokeWidth="8"
          className="stroke-muted"
          strokeLinecap="round"
        />
        {model.zones.map((zone) => (
          <path
            key={zone.from}
            d={arc(
              (zone.from - model.min) / span,
              (zone.to - model.min) / span,
            )}
            fill="none"
            strokeWidth="8"
            stroke="currentColor"
            className={cn("opacity-40", ownEntry(ZONE_STROKE, zone.tone))}
          />
        ))}
        <path
          d={arc(0, Math.max(0.001, model.fraction))}
          fill="none"
          strokeWidth="8"
          stroke="currentColor"
          strokeLinecap="round"
          className={ownEntry(ZONE_STROKE, model.tone)}
        />
        <line
          x1="50"
          y1="50"
          x2={(50 + needle.x).toFixed(2)}
          y2={(50 - needle.y).toFixed(2)}
          strokeWidth="2.5"
          stroke="currentColor"
          strokeLinecap="round"
          className="text-foreground"
        />
        <circle cx="50" cy="50" r="3.5" className="fill-foreground" />
      </svg>
      <span
        className={cn(
          "text-sm font-semibold tabular-nums",
          toneText(model.tone),
        )}
      >
        {model.valueText}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
};

const SPARK_STROKE: Record<string, string> = ZONE_STROKE;

export const SparklineView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const label = context.text(component, "label", scope, 120);
  const unit = context.text(component, "unit", scope, 20);
  const model = sparklineModel(
    context.value(component, "values", scope),
    label,
    unit,
  );
  const tone = context.string(component, "tone") ?? "default";
  if (!model) {
    return label ? (
      <p className="text-xs text-muted-foreground">{label}: no data</p>
    ) : null;
  }
  const width = 120;
  const height = 28;
  const bars = context.string(component, "kind") === "bar";
  const barWidth = Math.max(1, (width - 4) / model.values.length - 1);
  return (
    <div
      className="inline-flex items-center gap-2"
      role="img"
      aria-label={model.spoken}
    >
      {label ? (
        <span className="text-xs text-muted-foreground">{label}</span>
      ) : null}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className={cn(
          "h-7 w-[7.5rem]",
          ownEntry(SPARK_STROKE, tone) ?? "text-primary",
        )}
        aria-hidden="true"
      >
        {bars ? (
          model.points.map((point, index) => (
            <rect
              key={index}
              x={(2 + index * ((width - 4) / model.values.length)).toFixed(1)}
              y={(2 + point.y * (height - 4)).toFixed(1)}
              width={barWidth.toFixed(1)}
              height={Math.max(1, (1 - point.y) * (height - 4)).toFixed(1)}
              fill="currentColor"
              opacity="0.8"
            />
          ))
        ) : (
          <path
            d={sparklinePath(model.points, width, height)}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
      </svg>
      {component.props.showLast === false ? null : (
        <span className="text-xs font-medium tabular-nums">
          {model.lastText}
        </span>
      )}
    </div>
  );
};

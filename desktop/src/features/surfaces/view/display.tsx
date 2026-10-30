// Generated from the Kiingo surface renderer packages at c6609e08a498bb4161d453f1ac533d04f66d8bbc; do not edit here.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ownEntry,
  asNumber,
  cellText,
  childKey,
  countdownText,
  diffCellCount,
  diffText,
  ENTITY_TYPES,
  formatBytes,
  formatDateText,
  initialsOf,
  isObject,
  openableUrl,
  parseDate,
  plainId,
  plainText,
  proxiedMediaUrl,
  repeatsSurfaceTitle,
  resolveProp,
  urlHost,
  type EntityKey,
  type EntityType,
  type JsonValue,
} from "../core";
import { CopyButton } from "./copy";
import { cn } from "./cn";
import { useNodeContext, type NodeProps } from "./context";
import { catalogIcon, ENTITY_ICONS, ENTITY_NOUNS, Glyphs } from "./icons";
import { MarkdownText } from "./markdown";
import { ProxyImage } from "./media";
import {
  QuoteBox,
  SurfaceButton,
  SurfaceDialog,
  ToneGlyph,
  toneSurface,
  toneText,
  QuotedText,
} from "./ui";
import { Sparkline } from "./chart";

// §4.2 Display. Agent text is plain text (React text nodes, never HTML);
// outside content is a Quote with no links; media only through the proxy.

const TEXT_VARIANTS: Record<string, string> = {
  h1: "text-xl font-semibold",
  h2: "text-lg font-semibold",
  h3: "text-base font-semibold",
  caption: "text-xs",
  label: "text-sm font-medium",
  body: "text-sm",
};

export const TextView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const text = context.text(component, "text", scope);
  if (!text) {
    return null;
  }
  if (context.isUntrusted(component, "text", scope)) {
    return <QuoteBox text={text} />;
  }
  const variant = context.string(component, "variant") ?? "body";
  const lines = context.number(component, "maxLines", scope);
  const style = lines
    ? {
        display: "-webkit-box",
        WebkitLineClamp: Math.max(1, Math.round(lines)),
        WebkitBoxOrient: "vertical" as const,
        overflow: "hidden",
      }
    : undefined;
  const className = cn(
    "whitespace-pre-wrap break-words",
    ownEntry(TEXT_VARIANTS, variant) ?? TEXT_VARIANTS.body,
    toneText(
      context.string(component, "tone") ??
        (variant === "caption" ? "muted" : undefined),
    ),
  );
  if (variant === "h1" || variant === "h2" || variant === "h3") {
    // The card header already shows the title.
    if (repeatsSurfaceTitle(context.surface.title, text)) {
      return null;
    }
    const Tag = variant === "h1" ? "h2" : variant === "h2" ? "h3" : "h4";
    return (
      <Tag className={className} style={style}>
        {text}
      </Tag>
    );
  }
  return (
    <p className={className} style={style}>
      {text}
    </p>
  );
};

export const MarkdownView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const text = context.text(component, "text", scope, 20_000);
  if (!text) {
    return null;
  }
  if (context.isUntrusted(component, "text", scope)) {
    return <QuoteBox text={text} />;
  }
  return (
    <MarkdownText
      text={text}
      onLink={context.openLink}
      budget={context.markdown}
      copyCode={component.props.copyable !== false}
    />
  );
};

const ASPECTS: Record<string, number> = {
  "1:1": 1,
  "4:3": 4 / 3,
  "3:2": 3 / 2,
  "16:9": 16 / 9,
};

export const ImageView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  return (
    <ProxyImage
      url={context.value(component, "url", scope)}
      alt={context.text(component, "alt", scope, 300) ?? ""}
      fit={context.string(component, "fit") === "cover" ? "cover" : "contain"}
      aspect={ownEntry(ASPECTS, context.string(component, "aspect"))}
    />
  );
};

const GALLERY_COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
  6: "grid-cols-6",
};

export const ImageGalleryView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const images = context.list(component, "images", scope).slice(0, 60);
  const columns = Math.min(
    6,
    Math.max(1, Math.round(context.number(component, "columns", scope) ?? 3)),
  );
  const [enlarged, setEnlarged] = useState<number | undefined>(undefined);
  const field = (item: JsonValue, key: string) =>
    isObject(item) ? item[key] : undefined;
  const urlOf = (item: JsonValue) =>
    resolveProp(field(item, "url"), context.data, scope);
  const altOf = (item: JsonValue) =>
    context.textOf(field(item, "alt"), scope, 300) ?? "";
  const shown =
    enlarged !== undefined
      ? images[Math.min(enlarged, images.length - 1)]
      : undefined;
  return (
    <>
      <div className={cn("grid gap-1.5", ownEntry(GALLERY_COLUMNS, columns))}>
        {images.map((item, index) => {
          const caption = context.textOf(field(item, "caption"), scope, 200);
          return (
            <button
              key={index}
              type="button"
              onClick={() => setEnlarged(index)}
              className="flex flex-col gap-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={altOf(item) || `Image ${index + 1}`}
            >
              <ProxyImage
                url={urlOf(item)}
                alt={altOf(item)}
                fit="cover"
                aspect={1}
              />
              {caption ? (
                <span className="line-clamp-2 text-2xs text-muted-foreground">
                  {caption}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <SurfaceDialog
        open={shown !== undefined}
        onOpenChange={(open) => (open ? undefined : setEnlarged(undefined))}
        title={shown !== undefined ? altOf(shown) || "Image" : "Image"}
        wide
      >
        {shown !== undefined ? (
          <ProxyImage
            url={urlOf(shown)}
            alt={altOf(shown)}
            className="max-h-[70vh]"
          />
        ) : null}
      </SurfaceDialog>
    </>
  );
};

const ICON_SIZES: Record<string, string> = {
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
  lg: "h-6 w-6",
};

export const IconView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const Icon = catalogIcon(context.text(component, "name", scope, 40));
  const label = context.text(component, "label", scope, 80);
  return (
    <Icon
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      className={cn(
        ownEntry(ICON_SIZES, context.string(component, "size") ?? "md") ??
          ICON_SIZES.md,
        toneText(context.string(component, "tone")),
      )}
    />
  );
};

export const BadgeLabel = ({
  text,
  tone,
  icon,
}: {
  text: string;
  tone?: string;
  icon?: string;
}) => {
  const Icon = icon ? catalogIcon(icon) : undefined;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        toneSurface(tone),
      )}
    >
      {Icon ? <Icon aria-hidden className="h-3 w-3" /> : null}
      {text}
    </span>
  );
};

export const BadgeView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const text = context.text(component, "text", scope, 60);
  return text ? (
    <BadgeLabel
      text={text}
      tone={context.string(component, "tone")}
      icon={context.string(component, "icon")}
    />
  ) : null;
};

const AVATAR_SIZES: Record<string, string> = {
  sm: "h-6 w-6 text-2xs",
  md: "h-8 w-8 text-xs",
  lg: "h-11 w-11 text-sm",
};

export const AvatarView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const name = context.text(component, "name", scope, 80) ?? "";
  const initials =
    context.text(component, "initials", scope, 3) ??
    (name ? initialsOf(name) : "?");
  const image = context.value(component, "imageUrl", scope);
  const size =
    ownEntry(AVATAR_SIZES, context.string(component, "size") ?? "md") ??
    AVATAR_SIZES.md;
  return (
    <span
      className="inline-flex items-center gap-2"
      role="img"
      aria-label={name || "Avatar"}
    >
      <span
        aria-hidden
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted font-semibold text-muted-foreground",
          size,
        )}
      >
        {image ? (
          <ProxyImage
            url={image}
            alt=""
            fit="cover"
            aspect={1}
            rounded="rounded-full"
            className="absolute inset-0 h-full"
          />
        ) : (
          initials
        )}
        {!image && context.string(component, "kind") === "agent" ? (
          <Glyphs.radioOn className="absolute bottom-0 right-0 h-2.5 w-2.5 text-primary" />
        ) : null}
      </span>
      {name && context.flag(component, "showName", scope) ? (
        <span className="text-sm">{name}</span>
      ) : null}
    </span>
  );
};

export const KeyValueView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const items = context.list(component, "items", scope).slice(0, 100);
  if (context.isUntrusted(component, "items", scope)) {
    const lines = items.map((item) =>
      isObject(item)
        ? `${cellText(resolveProp(item.name, context.data, scope))}: ${cellText(resolveProp(item.value, context.data, scope))}`
        : cellText(item),
    );
    return <QuoteBox text={lines.join("\n")} />;
  }
  const copyValues = component.props.copyable !== false;
  const nameOf = (item: JsonValue) =>
    (isObject(item) ? context.textOf(item.name, scope, 80) : undefined) ?? "";
  const rawValue = (item: JsonValue) =>
    cellText(
      isObject(item) ? resolveProp(item.value, context.data, scope) : undefined,
    );
  // An outside value (or name) is quoted (79 S5/W6).
  const valueText = (item: JsonValue) =>
    isObject(item) &&
    (context.isUntrustedValue(item.value, scope) ||
      context.isUntrustedValue(item.name, scope)) ? (
      <QuotedText text={rawValue(item)} />
    ) : (
      rawValue(item)
    );
  if (context.string(component, "layout") === "stacked") {
    return (
      <dl className="flex flex-col gap-2">
        {items.map((item, index) => (
          <div key={index}>
            <dt className="text-xs text-muted-foreground">{nameOf(item)}</dt>
            <dd className="flex items-start gap-1.5 whitespace-pre-wrap break-words text-sm">
              <span className="min-w-0 flex-1">{valueText(item)}</span>
              {copyValues ? (
                <CopyButton text={rawValue(item)} what={nameOf(item)} compact />
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
      {items.map((item, index) => (
        <div key={index} className="contents">
          <dt className="text-sm text-muted-foreground">{nameOf(item)}</dt>
          <dd className="flex items-start gap-1.5 whitespace-pre-wrap break-words text-sm">
            <span className="min-w-0 flex-1">{valueText(item)}</span>
            {copyValues ? (
              <CopyButton text={rawValue(item)} what={nameOf(item)} compact />
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
};

export const MetricView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const trend = context.string(component, "trend") ?? "flat";
  const TrendIcon =
    trend === "up"
      ? Glyphs.trendUp
      : trend === "down"
        ? Glyphs.trendDown
        : Glyphs.trendFlat;
  const delta = context.text(component, "delta", scope, 40);
  const spark = context
    .list(component, "sparkline", scope)
    .map((value) => asNumber(value))
    .filter(
      (value): value is number => value !== undefined && Number.isFinite(value),
    );
  const caption = context.text(component, "caption", scope, 200);
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3 text-card-foreground">
      <span className="text-xs text-muted-foreground">
        {context.text(component, "label", scope, 80) ?? ""}
      </span>
      <span
        className={cn(
          "text-2xl font-semibold",
          toneText(context.string(component, "tone")),
        )}
      >
        {context.text(component, "value", scope, 40) ?? "–"}
      </span>
      {delta ? (
        <span
          className={cn(
            "inline-flex items-center gap-1 text-xs",
            trend === "up"
              ? "text-emerald-700"
              : trend === "down"
                ? "text-destructive"
                : "text-muted-foreground",
          )}
        >
          <TrendIcon aria-hidden className="h-3.5 w-3.5" />
          {delta}
        </span>
      ) : null}
      {spark.length > 1 ? <Sparkline values={spark} /> : null}
      {caption ? (
        <span className="text-2xs text-muted-foreground">{caption}</span>
      ) : null}
    </div>
  );
};

const PROGRESS_FILL: Record<string, string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-destructive",
  muted: "bg-muted-foreground",
};
const RING_STROKE: Record<string, string> = {
  success: "text-emerald-500",
  warning: "text-amber-500",
  danger: "text-destructive",
  muted: "text-muted-foreground",
};

export const ProgressView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const max = Math.max(context.number(component, "max", scope) ?? 1, 0.0001);
  const value = Math.min(
    Math.max(context.number(component, "value", scope) ?? 0, 0),
    max,
  );
  const label = context.text(component, "label", scope, 120) ?? "";
  const tone = context.string(component, "tone") ?? "default";
  const share = value / max;
  if (context.flag(component, "indeterminate", scope)) {
    return (
      <div
        className="flex flex-col gap-1"
        role="progressbar"
        aria-label={label || "Working"}
        aria-busy
      >
        {label ? <span className="text-xs">{label}</span> : null}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        </div>
      </div>
    );
  }
  const aria = {
    role: "progressbar",
    "aria-label": label || "Progress",
    "aria-valuemin": 0,
    "aria-valuemax": max,
    "aria-valuenow": value,
  } as const;
  if (context.string(component, "style") === "ring") {
    const circumference = 2 * Math.PI * 15;
    return (
      <div className="inline-flex items-center gap-2" {...aria}>
        <svg
          viewBox="0 0 36 36"
          className="h-10 w-10 -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx="18"
            cy="18"
            r="15"
            fill="none"
            strokeWidth="4"
            className="stroke-muted"
          />
          <circle
            cx="18"
            cy="18"
            r="15"
            fill="none"
            strokeWidth="4"
            stroke="currentColor"
            strokeLinecap="round"
            strokeDasharray={`${circumference * share} ${circumference}`}
            className={ownEntry(RING_STROKE, tone) ?? "text-primary"}
          />
        </svg>
        {label ? <span className="text-xs">{label}</span> : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1" {...aria}>
      {label ? <span className="text-xs">{label}</span> : null}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            ownEntry(PROGRESS_FILL, tone) ?? "bg-primary",
          )}
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </div>
  );
};

const TIMELINE_DOT: Record<string, string> = {
  done: "bg-emerald-500",
  current: "bg-primary",
  failed: "bg-destructive",
};

export const TimelineView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const listed = context.list(component, "items", scope).slice(0, 100);
  const items =
    context.string(component, "order") === "newestFirst"
      ? [...listed].reverse()
      : listed;
  return (
    <ol className="flex flex-col">
      {items.map((item, index) => {
        const record = isObject(item) ? item : {};
        const status =
          typeof record.status === "string" ? record.status : undefined;
        const at = formatDateText(record.at);
        const body = plainText(record.body, 1000, true);
        return (
          <li key={index} className="flex gap-2.5">
            <div className="flex flex-col items-center" aria-hidden>
              <span
                className={cn(
                  "mt-1.5 h-2 w-2 rounded-full",
                  ownEntry(TIMELINE_DOT, status) ?? "bg-muted-foreground/50",
                )}
              />
              {index < items.length - 1 ? (
                <span className="w-px flex-1 bg-border" />
              ) : null}
            </div>
            <div className="min-w-0 pb-3">
              {at ? (
                <p className="text-xs text-muted-foreground">{at}</p>
              ) : null}
              <p className="text-sm font-medium">
                {plainText(record.title, 200) ?? ""}
              </p>
              {body ? (
                <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                  {body}
                </p>
              ) : null}
              {status === "failed" ? (
                <span className="sr-only">Failed</span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
};

export const CodeView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const code = context.text(component, "code", scope, 50_000) ?? "";
  const language = context.text(component, "language", scope, 20);
  if (context.isUntrusted(component, "code", scope)) {
    return <QuoteBox text={code} copy={component.props.copyable !== false} />;
  }
  return (
    <div className="overflow-hidden rounded-md border border-border bg-muted">
      <div className="flex items-center justify-between border-b border-border px-3 py-1 text-2xs text-muted-foreground">
        <span>{language ?? "Code"}</span>
        {component.props.copyable === false ? null : (
          <CopyButton text={code} what="code" />
        )}
      </div>
      <pre
        className={cn(
          "px-3 py-2 font-mono text-xs",
          context.flag(component, "wrap", scope)
            ? "whitespace-pre-wrap break-words"
            : "overflow-x-auto",
        )}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
};

export const DiffView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const before = context.text(component, "before", scope, 20_000) ?? "";
  const after = context.text(component, "after", scope, 20_000) ?? "";
  const granularity =
    context.string(component, "granularity") === "line" ? "line" : "word";
  // Memoized, and too-large inputs are not compared (79 W8: 4M cells per
  // Diff, and 4M per surface across every Diff, W6 SHOULD 5).
  const cost = useMemo(
    () => diffCellCount(before, after, granularity),
    [before, after, granularity],
  );
  const compared = context.claimDiff(
    `diff:${childKey(component.id, scope)}`,
    cost,
  );
  const parts = useMemo(
    () => diffText(before, after, granularity, compared ? undefined : 0),
    [before, after, granularity, compared],
  );
  const copyAfter =
    component.props.copyable === false ? null : (
      <div className="flex justify-end">
        <CopyButton text={after} what="new text" />
      </div>
    );
  if (context.string(component, "mode") === "sideBySide") {
    return (
      <div className="@container">
        {copyAfter}
        <div className="grid grid-cols-1 gap-3 @md:grid-cols-2">
          {[
            ["Before", before],
            ["After", after],
          ].map(([title, text]) => (
            <div key={title}>
              <p className="text-xs text-muted-foreground">{title}</p>
              <p className="whitespace-pre-wrap break-words text-sm">{text}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {copyAfter}
      <p className="whitespace-pre-wrap break-words text-sm">
        {parts.map((part, index) =>
          part.kind === "added" ? (
            <ins
              key={index}
              className="bg-emerald-50 text-emerald-700 underline"
            >
              <span className="sr-only">added </span>
              {part.text}
            </ins>
          ) : part.kind === "removed" ? (
            <del
              key={index}
              className="bg-destructive/10 text-destructive line-through"
            >
              <span className="sr-only">removed </span>
              {part.text}
            </del>
          ) : (
            <span key={index}>{part.text}</span>
          ),
        )}
      </p>
    </div>
  );
};

export const CalloutView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const kind = context.string(component, "kind") ?? "info";
  const title = context.text(component, "title", scope, 120);
  const body = context.text(component, "body", scope);
  return (
    <div
      className={cn("flex gap-2.5 rounded-lg px-3 py-2.5", toneSurface(kind))}
      role={kind === "danger" ? "alert" : "note"}
    >
      <ToneGlyph tone={kind} className="mt-0.5" />
      <div className="min-w-0 text-foreground">
        {title ? <p className="text-sm font-semibold">{title}</p> : null}
        {body ? (
          <p className="whitespace-pre-wrap break-words text-xs">{body}</p>
        ) : null}
      </div>
    </div>
  );
};

export const QuoteView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const text = context.text(component, "text", scope, 20_000);
  const source = context.text(component, "source", scope, 120);
  const [open, setOpen] = useState(false);
  if (!text) {
    return null;
  }
  if (context.flag(component, "collapsed", scope) && !open) {
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className="text-left text-xs text-muted-foreground hover:text-foreground"
      >
        {source ? `Quoted from ${source}` : "Quoted"} · Show
      </button>
    );
  }
  return (
    <QuoteBox
      text={text}
      source={source}
      copy={component.props.copyable !== false}
    />
  );
};

/**
 * A Kiingo object: its icon and title, resolved by the server when missing.
 * `outside` (an id or title read from outside content, 79 W6): a quote of
 * the title, never a button and never a lookup.
 */
export const EntityChip = ({
  entity,
  outside = false,
}: {
  entity: EntityKey;
  outside?: boolean;
}) =>
  outside ? (
    <QuotedText text={entity.title ?? ENTITY_NOUNS[entity.type]} />
  ) : (
    <OwnEntityChip entity={entity} />
  );

const OwnEntityChip = ({ entity }: { entity: EntityKey }) => {
  const context = useNodeContext();
  const [resolved, setResolved] = useState<string | undefined>(undefined);
  const controller = context.controller;
  const { type, id, title } = entity;
  // Batched with every other chip on the surface (79 W8).
  useEffect(() => {
    if (title) {
      return undefined;
    }
    let cancelled = false;
    void controller.resolveRefTitle({ type, id }).then((found) => {
      if (!cancelled) {
        setResolved(found);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [controller, type, id, title]);
  const Icon = ENTITY_ICONS[entity.type];
  const label = resolved ?? entity.title ?? ENTITY_NOUNS[entity.type];
  const host = context.host;
  const openable =
    Boolean(host.openEntity) && (host.canOpenEntity?.(entity) ?? true);
  const classes =
    "inline-flex max-w-full items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-foreground";
  if (!openable) {
    return (
      <span className={classes}>
        <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      title={`Opens this ${ENTITY_NOUNS[entity.type].toLowerCase()}`}
      onClick={() => host.openEntity?.(entity)}
      className={cn(
        classes,
        "hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
};

export const EntityRefView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const type = context.string(component, "entityType") as
    | EntityType
    | undefined;
  const id = plainId(context.value(component, "id", scope));
  if (!type || !ENTITY_TYPES.includes(type) || !id) {
    return null;
  }
  const title = context.text(component, "label", scope, 200);
  return (
    <EntityChip
      entity={{ type, id, ...(title ? { title } : {}) }}
      outside={
        context.isUntrusted(component, "id", scope) ||
        context.isUntrusted(component, "label", scope)
      }
    />
  );
};

/** One file. `outside` (read from outside content, 79 W6): quoted, never a button. */
export const FileRow = ({
  item,
  outside = false,
}: {
  item: JsonValue;
  outside?: boolean;
}) => {
  const record = isObject(item) ? item : {};
  const name = plainText(record.name, 200) ?? "File";
  const id = plainId(record.artifactId);
  const size = asNumber(record.size);
  const type = plainText(record.contentType, 80);
  const detail = [type, size !== undefined ? formatBytes(size) : undefined]
    .filter(Boolean)
    .join(" · ");
  if (outside) {
    return <QuotedText text={[name, detail].filter(Boolean).join(" · ")} />;
  }
  const content = (
    <span className="flex min-w-0 items-center gap-2.5">
      <Glyphs.file
        aria-hidden
        className="h-4 w-4 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0">
        <span className="block truncate text-sm">{name}</span>
        {detail ? (
          <span className="block text-xs text-muted-foreground">{detail}</span>
        ) : null}
      </span>
    </span>
  );
  return id ? (
    <EntityChipRow entity={{ type: "file", id, title: name }}>
      {content}
    </EntityChipRow>
  ) : (
    content
  );
};

const EntityChipRow = ({
  entity,
  children,
}: {
  entity: EntityKey;
  children: ReactNode;
}) => {
  const context = useNodeContext();
  const host = context.host;
  if (!host.openEntity || host.canOpenEntity?.(entity) === false) {
    return <>{children}</>;
  }
  return (
    <button
      type="button"
      onClick={() => host.openEntity?.(entity)}
      className="min-w-0 text-left hover:opacity-80"
    >
      {children}
    </button>
  );
};

export const FileListView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const files = context.list(component, "files", scope).slice(0, 100);
  const empty = context.text(component, "emptyText", scope, 200);
  const outside = context.isUntrusted(component, "files", scope);
  return (
    <div className="flex flex-col gap-1.5">
      {files.length === 0 && empty ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : null}
      {files.map((item, index) => (
        <FileRow key={index} item={item} outside={outside} />
      ))}
    </div>
  );
};

/** Audio or video: played only on the user's tap (preload none), from the proxy. */
export const MediaView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const title = context.text(component, "title", scope, 200) ?? "Media";
  const isVideo = context.string(component, "kind") === "video";
  const raw = context.value(component, "url", scope);
  const url =
    typeof raw === "string"
      ? proxiedMediaUrl(raw, context.host.apiOrigin)
      : undefined;
  const fileId = plainId(context.value(component, "artifactId", scope));
  const outside = ["title", "url", "artifactId"].some((key) =>
    context.isUntrusted(component, key, scope),
  );
  // No in-page playback until the media proxy serves audio and video with
  // a no-redirect, A/V-type allowlist (79 nit, S7): open it in Kiingo.
  const webUrl = context.surface.webUrl;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2.5">
        <Glyphs.play
          aria-hidden
          className="h-4 w-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-sm">
          {outside ? <QuotedText text={title} /> : title}
          <span className="sr-only">{isVideo ? " (video)" : " (audio)"}</span>
        </span>
        {fileId ? (
          <EntityChip
            entity={{ type: "file", id: fileId, title }}
            outside={outside}
          />
        ) : url && webUrl ? (
          <SurfaceButton size="sm" onClick={() => context.openLink(webUrl)}>
            Open in Kiingo
          </SurfaceButton>
        ) : null}
      </div>
    </div>
  );
};

export const LinkPreviewView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const link = openableUrl(context.text(component, "url", scope, 2048));
  const title = context.text(component, "title", scope, 200);
  const description = context.text(component, "description", scope, 300);
  const image = context.value(component, "imageUrl", scope);
  // Outside content never becomes a link (79 W6).
  if (
    ["url", "title", "description", "imageUrl"].some((key) =>
      context.isUntrusted(component, key, scope),
    )
  ) {
    const host = link ? urlHost(link) : undefined;
    return (
      <QuoteBox text={[title, description, host].filter(Boolean).join("\n")} />
    );
  }
  const body = (
    <>
      {image ? (
        <ProxyImage url={image} alt="" fit="cover" className="max-h-32" />
      ) : null}
      {title ? (
        <span className="line-clamp-2 text-sm font-semibold">{title}</span>
      ) : null}
      {description ? (
        <span className="line-clamp-3 text-xs">{description}</span>
      ) : null}
      <span className="text-xs text-muted-foreground">
        {link ? urlHost(link) : ""}
      </span>
    </>
  );
  const classes =
    "flex w-full flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-left";
  return link ? (
    <button
      type="button"
      onClick={() => context.openLink(link)}
      className={cn(classes, "hover:bg-muted/50")}
      title="Opens in the browser"
    >
      {body}
    </button>
  ) : (
    <div className={classes}>{body}</div>
  );
};

export const CountdownView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const target = parseDate(context.value(component, "target", scope));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  if (!target) {
    return null;
  }
  const label = context.text(component, "label", scope, 80);
  const mode =
    context.string(component, "mode") === "since" ? "since" : "until";
  return (
    <p className="text-sm">
      {label ? <span className="text-muted-foreground">{label} </span> : null}
      <time dateTime={target.toISOString()} className="tabular-nums">
        {countdownText(target, mode, now)}
      </time>
    </p>
  );
};

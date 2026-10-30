// Generated from the Kiingo surface renderer packages at f674e04ba1130af309f8d467ccc7fc5a2efeba01; do not edit here.
import { useState } from "react";
import {
  appendPointer,
  asLatLng,
  asNumber,
  bindingOf,
  clusterPins,
  isObject,
  latLngText,
  mapFrame,
  parseLatLng,
  pinText,
  plainText,
  readMapAreas,
  readMapPins,
  type LatLng,
  type MapPin,
} from "../core";
import { cn } from "./cn";
import { useNodeContext, type NodeProps } from "./context";
import type { FieldProps } from "./field";
import { aria } from "./field";
import { catalogIcon } from "./icons";
import { QuotedText, toneText } from "./ui";

// §4.2 Map and §4.3 LocationPicker on the web: a drawn plot (no map tiles,
// no outside geocoding: nothing loads from outside the app), with the
// places listed as text. Apple platforms draw Apple Maps.

const HEIGHTS: Record<string, number> = {
  compact: 110,
  regular: 170,
  tall: 280,
};
const WIDTH = 320;

/** Fill class for an area or pin of `tone` (the app's palette). */
const toneFill = (tone: string | undefined): string =>
  tone ? toneText(tone) : "text-primary";

/**
 * Pins (styled by tone and icon), a route, shaded areas and optional
 * clusters; bound pins move as the data changes. A tap writes the pin's
 * index to `selection`, then runs `onPinTap`.
 */
export const MapView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  let raw = context.list(component, "pins", scope);
  const single = context.value(component, "pins", scope);
  if (raw.length === 0 && isObject(single)) {
    raw = [single];
  }
  const pins = readMapPins(raw);
  const areas = readMapAreas(context.list(component, "areas", scope));
  if (pins.length === 0) {
    return null;
  }
  const height = HEIGHTS[context.string(component, "size") ?? ""] ?? 170;
  const fit = component.props.fit !== false;
  const zoom = context.number(component, "zoom", scope);
  const frame = mapFrame([...pins, ...areas.flatMap((area) => area.points)], {
    width: WIDTH,
    height,
    fit,
    ...(zoom !== undefined ? { zoom } : {}),
  });
  const route = context.flag(component, "route", scope) && pins.length > 1;
  const clusters = context.flag(component, "cluster", scope)
    ? clusterPins(pins, frame)
    : pins.map((pin) => ({
        x: frame.x(pin.lng),
        y: frame.y(pin.lat),
        pins: [pin],
      }));
  // Outside pins (79 W6): their text is quoted and nothing taps or links.
  const outside = context.isUntrusted(component, "pins", scope);
  const action = context.action(component.props.onPinTap);
  const tappable =
    !outside && action !== undefined && context.canTapSilently(action);
  const pinsPointer = bindingOf(component.props.pins, scope);
  const selectionPointer = bindingOf(component.props.selection, scope);
  const selected = selectionPointer
    ? asNumber(context.read(selectionPointer))
    : undefined;
  const tap = (pin: MapPin) => {
    if (!action || !tappable) {
      return;
    }
    if (selectionPointer && context.acceptsEdits) {
      context.edit(selectionPointer, pin.index);
    }
    context.perform(
      action.id,
      pinsPointer && Array.isArray(context.read(pinsPointer))
        ? appendPointer(pinsPointer, pin.index)
        : scope,
    );
  };
  const first = pins[0]!;
  const mapsLink = `https://maps.apple.com/?ll=${first.lat},${first.lng}&q=${encodeURIComponent(first.label || "Place")}`;
  return (
    <figure className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      {/* The plot is a picture; the list below carries the places. */}
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="w-full overflow-hidden rounded-md bg-muted"
        style={{ height }}
        aria-hidden="true"
      >
        {areas.map((area, index) => (
          <polygon
            key={`area-${index}`}
            points={area.points
              .map((point) => `${frame.x(point.lng)},${frame.y(point.lat)}`)
              .join(" ")}
            fill="currentColor"
            fillOpacity={0.14}
            stroke="currentColor"
            strokeOpacity={0.5}
            strokeWidth={1.5}
            className={toneFill(area.tone)}
          />
        ))}
        {route ? (
          <polyline
            points={pins
              .map((pin) => `${frame.x(pin.lng)},${frame.y(pin.lat)}`)
              .join(" ")}
            fill="none"
            strokeWidth="3"
            stroke="currentColor"
            strokeLinejoin="round"
            className="text-primary"
          />
        ) : null}
        {clusters.map((cluster, index) => {
          const pin = cluster.pins[0]!;
          const many = cluster.pins.length > 1;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut on a hidden picture; the list of places below has the buttons.
            <g
              key={many ? `cluster-${index}` : (pin.id ?? `pin-${pin.index}`)}
              // Live positions glide to the new place (reduced motion jumps).
              style={{
                transform: `translate(${cluster.x}px, ${cluster.y}px)`,
              }}
              className={cn(
                "transition-transform duration-500 motion-reduce:transition-none",
                many ? "text-primary" : toneFill(pin.tone ?? "danger"),
                tappable && !many && "cursor-pointer",
              )}
              onClick={many ? undefined : () => tap(pin)}
            >
              <circle
                r={many ? 10 : selected === pin.index ? 8 : 6}
                fill="currentColor"
                strokeWidth={1.5}
                className="stroke-background"
              />
              {many ? (
                <text
                  textAnchor="middle"
                  dy="0.35em"
                  fontSize="9"
                  fontWeight="600"
                  className="fill-primary-foreground"
                >
                  {cluster.pins.length}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="flex flex-col gap-1">
        {areas.some((area) => area.label) ? (
          <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {areas
              .filter((area) => area.label)
              .map((area, index) => (
                <span key={index} className="inline-flex items-center gap-1">
                  <span
                    aria-hidden
                    className={cn(
                      "inline-block h-2 w-2 rounded-sm bg-current",
                      toneFill(area.tone),
                    )}
                  />
                  {outside ? (
                    <QuotedText text={area.label!} />
                  ) : (
                    <span className="text-muted-foreground">{area.label}</span>
                  )}
                </span>
              ))}
          </span>
        ) : null}
        <ul className="flex flex-col" aria-label="Places on the map">
          {pins.slice(0, 50).map((pin) => (
            <PinRow
              key={pin.id ?? pin.index}
              pin={pin}
              outside={outside}
              selected={selected === pin.index}
              {...(tappable ? { onTap: () => tap(pin) } : {})}
              busy={context.busy}
            />
          ))}
        </ul>
        {pins.length > 50 ? (
          <span className="text-xs text-muted-foreground">
            {pins.length - 50} more places on the map
          </span>
        ) : null}
        {outside ? null : (
          <button
            type="button"
            className="self-end text-xs text-primary hover:underline"
            onClick={() => context.openLink(mapsLink)}
          >
            Open in Maps
          </button>
        )}
      </figcaption>
    </figure>
  );
};

const PinRow = ({
  pin,
  outside,
  selected,
  onTap,
  busy,
}: {
  pin: MapPin;
  outside: boolean;
  selected: boolean;
  onTap?: () => void;
  busy: boolean;
}) => {
  const Icon = catalogIcon(pin.icon ?? "location");
  if (outside) {
    return (
      <li className="py-0.5">
        <QuotedText
          text={[pinText(pin), pin.subtitle].filter(Boolean).join(" · ")}
        />
      </li>
    );
  }
  const body = (
    <span className="flex items-center gap-2 py-1 text-xs">
      <Icon
        aria-hidden
        className={cn("h-3.5 w-3.5 shrink-0", toneFill(pin.tone ?? "danger"))}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{pinText(pin)}</span>
        {pin.subtitle ? (
          <span className="block truncate text-muted-foreground">
            {pin.subtitle}
          </span>
        ) : null}
      </span>
    </span>
  );
  return (
    <li aria-current={selected ? "true" : undefined}>
      {onTap ? (
        <button
          type="button"
          disabled={busy}
          onClick={onTap}
          className={cn(
            "w-full rounded text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected && "bg-primary/5",
          )}
        >
          {body}
        </button>
      ) : (
        body
      )}
    </li>
  );
};

/**
 * LocationPicker on the web: typed coordinates (and a label) with the
 * point drawn on a plot; clicking the plot moves the point. No outside
 * geocoding: address search is on Apple platforms.
 */
export const LocationInput = (props: FieldProps) => {
  const context = useNodeContext();
  const current = context.read(props.pointer);
  const at = asLatLng(current);
  const label = isObject(current) ? plainText(current.label, 200) : undefined;
  const near =
    asLatLng(context.value(props.component, "near", props.scope)) ?? at;
  const [typed, setTyped] = useState<string | undefined>(undefined);
  // The place set when the picker appeared (usually the agent's suggestion):
  // a stray click on the plot can always go back to it (79 LOW).
  const [suggested] = useState(() =>
    at && isObject(current) ? current : undefined,
  );
  const suggestedAt = asLatLng(suggested);
  const moved =
    suggestedAt !== undefined &&
    (at === undefined ||
      at.lat !== suggestedAt.lat ||
      at.lng !== suggestedAt.lng);
  const shown = typed ?? (at ? latLngText(at) : "");
  const parsed = typed === undefined ? at : parseLatLng(typed);
  const zoom = context.number(props.component, "zoom", props.scope) ?? 13;
  const height = 150;
  const centre = at ?? near;
  const frame = centre
    ? mapFrame([centre], { width: WIDTH, height, fit: false, zoom })
    : undefined;
  // A moved point drops any old address: it no longer names the place.
  const write = (next: LatLng) =>
    context.edit(props.pointer, {
      lat: Math.round(next.lat * 1e6) / 1e6,
      lng: Math.round(next.lng * 1e6) / 1e6,
    });
  return (
    <div className="flex flex-col gap-1.5">
      {frame && centre ? (
        <svg
          viewBox={`0 0 ${WIDTH} ${height}`}
          className={cn(
            "w-full rounded-md bg-muted",
            !props.disabled && "cursor-crosshair",
          )}
          style={{ height }}
          aria-hidden="true"
          onClick={(event) => {
            if (props.disabled) {
              return;
            }
            const box = event.currentTarget.getBoundingClientRect();
            const px = ((event.clientX - box.left) / box.width) * WIDTH;
            const py = ((event.clientY - box.top) / box.height) * height;
            const next = frame.toLatLng(px, py);
            if (next) {
              setTyped(undefined);
              write(next);
            }
          }}
        >
          {at ? (
            <circle
              cx={frame.x(at.lng)}
              cy={frame.y(at.lat)}
              r={7}
              fill="currentColor"
              strokeWidth={1.5}
              className="stroke-background text-destructive"
            />
          ) : null}
        </svg>
      ) : null}
      <input
        id={props.id}
        type="text"
        inputMode="decimal"
        value={shown}
        placeholder={props.placeholder || "Latitude, longitude"}
        disabled={props.disabled}
        onChange={(event) => {
          const text = event.target.value;
          setTyped(text);
          const next = parseLatLng(text);
          if (next) {
            write(next);
          }
        }}
        onBlur={() => setTyped(undefined)}
        className={cn(
          "rounded-md border border-input bg-background px-2 py-1.5 text-sm",
          typed !== undefined && !parsed && "border-destructive",
        )}
        aria-description="Latitude and longitude, separated by a comma"
        {...aria(props)}
      />
      {label ? (
        <span className="text-xs text-muted-foreground">{label}</span>
      ) : null}
      {moved && !props.disabled ? (
        <button
          type="button"
          className="self-start text-xs text-primary underline-offset-2 hover:underline"
          onClick={() => {
            setTyped(undefined);
            context.edit(props.pointer, suggested);
          }}
        >
          Reset to suggested place
        </button>
      ) : null}
      {typed !== undefined && !parsed ? (
        <span className="text-xs text-destructive" role="status">
          Type a latitude and longitude, like 40.7128, -74.0060.
        </span>
      ) : null}
    </div>
  );
};

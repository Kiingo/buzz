// Generated from the Kiingo surface renderer packages at cec9eff8903c0d5f3d7dd58145c4f4dfdf28fb98; do not edit here.
import { asNumber, isObject } from "./json";
import { plainText } from "./text";

// Map geometry for the Map and LocationPicker components (§4.2, §4.3), drawn
// as a plain SVG plot by the web renderers: no map tiles, nothing loads from
// outside the app. Apple platforms draw Apple Maps from the same data.

export type LatLng = { lat: number; lng: number };

export type MapPin = LatLng & {
  /** Position in the pins list (what `selection` receives). */
  index: number;
  id?: string;
  label: string;
  subtitle?: string;
  tone?: string;
  icon?: string;
};

export type MapArea = {
  kind: "polygon" | "circle";
  /** Corners; a circle is drawn as a ring of points around its centre. */
  points: LatLng[];
  label?: string;
  tone?: string;
  radiusMeters?: number;
  center?: LatLng;
};

const TONES = new Set(["default", "muted", "success", "warning", "danger"]);

export const asLatLng = (raw: unknown): LatLng | undefined => {
  if (!isObject(raw)) {
    return undefined;
  }
  const lat = asNumber(raw.lat);
  const lng = asNumber(raw.lng);
  if (
    lat === undefined ||
    lng === undefined ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    return undefined;
  }
  return { lat, lng };
};

/** The pins a Map draws: valid coordinates only, at most `max`. */
export const readMapPins = (raw: unknown[], max = 200): MapPin[] =>
  raw.slice(0, max).flatMap((item, index) => {
    const at = asLatLng(item);
    if (!at || !isObject(item)) {
      return [];
    }
    const tone =
      typeof item.tone === "string" && TONES.has(item.tone)
        ? item.tone
        : undefined;
    const id = plainText(item.id, 64);
    const subtitle = plainText(item.subtitle, 300);
    const icon = plainText(item.icon, 40);
    return [
      {
        ...at,
        index,
        label: plainText(item.label, 200) ?? "",
        ...(id ? { id } : {}),
        ...(subtitle ? { subtitle } : {}),
        ...(tone ? { tone } : {}),
        ...(icon ? { icon } : {}),
      },
    ];
  });

const EARTH_METERS = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Great-circle distance in metres. */
export const distanceMeters = (a: LatLng, b: LatLng): number => {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** A ring of `steps` points `radiusMeters` around `center`. */
export const circlePoints = (
  center: LatLng,
  radiusMeters: number,
  steps = 48,
): LatLng[] => {
  const angular = radiusMeters / EARTH_METERS;
  const lat1 = toRad(center.lat);
  const lng1 = toRad(center.lng);
  return Array.from({ length: steps }, (_, step) => {
    const bearing = (2 * Math.PI * step) / steps;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angular) +
        Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
    );
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
        Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
      );
    return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 };
  });
};

/** The areas a Map shades, circles as rings of points; at most `max`. */
export const readMapAreas = (raw: unknown[], max = 20): MapArea[] =>
  raw.slice(0, max).flatMap((item): MapArea[] => {
    if (!isObject(item)) {
      return [];
    }
    const label = plainText(item.label, 200);
    const tone =
      typeof item.tone === "string" && TONES.has(item.tone)
        ? item.tone
        : undefined;
    const extra = {
      ...(label ? { label } : {}),
      ...(tone ? { tone } : {}),
    };
    if (item.kind === "circle") {
      const center = asLatLng(item.center);
      const radius = asNumber(item.radiusMeters);
      if (!center || radius === undefined || radius <= 0) {
        return [];
      }
      const radiusMeters = Math.min(radius, 500_000);
      return [
        {
          kind: "circle",
          points: circlePoints(center, radiusMeters),
          center,
          radiusMeters,
          ...extra,
        },
      ];
    }
    if (item.kind === "polygon" && Array.isArray(item.points)) {
      const points = item.points
        .slice(0, 200)
        .map(asLatLng)
        .filter((point): point is LatLng => Boolean(point));
      return points.length >= 3 ? [{ kind: "polygon", points, ...extra }] : [];
    }
    return [];
  });

export type MapFrame = {
  width: number;
  height: number;
  x: (lng: number) => number;
  y: (lat: number) => number;
  /** The point under plot position (x, y), or undefined off the globe. */
  toLatLng: (x: number, y: number) => LatLng | undefined;
};

/**
 * Projects onto a `width` × `height` plot (equirectangular, latitude scaled
 * so shapes keep their proportions near the centre). `fit` frames every pin
 * and area; otherwise the first pin is the centre at `zoom` (1-20).
 */
export const mapFrame = (
  points: LatLng[],
  options: { width: number; height: number; fit?: boolean; zoom?: number },
): MapFrame => {
  const { width, height } = options;
  const pad = 18;
  const first = points[0] ?? { lat: 0, lng: 0 };
  let minLat = first.lat;
  let maxLat = first.lat;
  let minLng = first.lng;
  let maxLng = first.lng;
  if (options.fit === false) {
    const span = 360 / 2 ** Math.min(Math.max(options.zoom ?? 12, 1), 20);
    minLng = first.lng - span / 2;
    maxLng = first.lng + span / 2;
    minLat = first.lat - span / 4;
    maxLat = first.lat + span / 4;
  } else {
    for (const point of points) {
      minLat = Math.min(minLat, point.lat);
      maxLat = Math.max(maxLat, point.lat);
      minLng = Math.min(minLng, point.lng);
      maxLng = Math.max(maxLng, point.lng);
    }
  }
  const midLat = (minLat + maxLat) / 2;
  const squash = Math.max(Math.cos(toRad(midLat)), 0.2);
  const spanLng = Math.max((maxLng - minLng) * squash, 0.005);
  const spanLat = Math.max(maxLat - minLat, 0.005);
  const scale = Math.min(
    (width - pad * 2) / spanLng,
    (height - pad * 2) / spanLat,
  );
  const midLng = (minLng + maxLng) / 2;
  return {
    width,
    height,
    x: (lng: number) => width / 2 + (lng - midLng) * squash * scale,
    y: (lat: number) => height / 2 - (lat - midLat) * scale,
    toLatLng: (x: number, y: number) =>
      asLatLng({
        lat: midLat - (y - height / 2) / scale,
        lng: midLng + (x - width / 2) / (squash * scale),
      }),
  };
};

export type MapCluster = {
  x: number;
  y: number;
  pins: MapPin[];
};

/**
 * Pins within `radius` plot units of each other become one counted bubble
 * (greedy, in list order, so the result is stable between revisions).
 */
export const clusterPins = (
  pins: MapPin[],
  frame: MapFrame,
  radius = 16,
): MapCluster[] => {
  const clusters: MapCluster[] = [];
  for (const pin of pins) {
    const x = frame.x(pin.lng);
    const y = frame.y(pin.lat);
    const near = clusters.find(
      (cluster) => Math.hypot(cluster.x - x, cluster.y - y) <= radius,
    );
    if (near) {
      near.pins.push(pin);
    } else {
      clusters.push({ x, y, pins: [pin] });
    }
  }
  return clusters;
};

/** A pin's place in text: its title, or its coordinates. */
export const pinText = (pin: MapPin): string =>
  pin.label || `${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)}`;

/** "40.71280, -74.00600" for a typed-coordinates field. */
export const latLngText = (at: LatLng): string =>
  `${at.lat.toFixed(5)}, ${at.lng.toFixed(5)}`;

/** Reads "lat, lng" typed by the user; undefined when it isn't one. */
export const parseLatLng = (raw: string): LatLng | undefined => {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/u.exec(
    raw,
  );
  if (!match) {
    return undefined;
  }
  return asLatLng({ lat: Number(match[1]), lng: Number(match[2]) });
};

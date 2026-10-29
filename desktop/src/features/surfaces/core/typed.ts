// Generated from the Kiingo surface renderer packages at cec9eff8903c0d5f3d7dd58145c4f4dfdf28fb98; do not edit here.
import { asNumber, isObject } from "./json";
import { formatPlainNumber, plainText } from "./text";

// Typed inputs (GU-B, 2026-10-29): NumberField, AddressField, ColorPicker.
// The Swift kit applies the same rules (`UiTyped` in KiingoMobileCore).

// --- NumberField ---------------------------------------------------------------

export type NumberFieldStyle = "decimal" | "currency" | "percent" | "unit";

export type NumberFieldFormat = {
  style: NumberFieldStyle;
  /** ISO 4217, only for currency. */
  currency?: string;
  unit?: string;
  decimals?: number;
};

export const numberFieldFormat = (
  props: Record<string, unknown>,
): NumberFieldFormat => {
  const style = (["currency", "percent", "unit"] as const).find(
    (name) => props.style === name,
  );
  const currency =
    typeof props.currency === "string" && /^[A-Z]{3}$/u.test(props.currency)
      ? props.currency
      : undefined;
  const unit = plainText(props.unit, 20);
  const decimals =
    typeof props.decimals === "number" &&
    Number.isInteger(props.decimals) &&
    props.decimals >= 0 &&
    props.decimals <= 6
      ? props.decimals
      : undefined;
  return {
    // A currency style with no valid code is a plain number.
    style: style === "currency" && !currency ? "decimal" : (style ?? "decimal"),
    ...(currency ? { currency } : {}),
    ...(unit ? { unit } : {}),
    ...(decimals !== undefined ? { decimals } : {}),
  };
};

/**
 * The number as the field shows it at rest, in `locale`: "€12,500.00",
 * "7.5%", "3 hours". Percent is the number as typed (12.5 shows 12.5%).
 */
export const formatNumberField = (
  value: number,
  format: NumberFieldFormat,
  locale?: string,
): string => {
  const digits =
    format.decimals !== undefined
      ? {
          minimumFractionDigits: format.decimals,
          maximumFractionDigits: format.decimals,
        }
      : format.style === "currency"
        ? {}
        : { maximumFractionDigits: 2 };
  try {
    if (format.style === "currency" && format.currency) {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: format.currency,
        ...digits,
      }).format(value);
    }
    const number = new Intl.NumberFormat(locale, digits).format(value);
    if (format.style === "percent") {
      return `${number}%`;
    }
    if (format.style === "unit" && format.unit) {
      return `${number} ${format.unit}`;
    }
    return number;
  } catch {
    const plain = formatPlainNumber(value);
    return format.style === "currency" && format.currency
      ? `${plain} ${format.currency}`
      : format.style === "percent"
        ? `${plain}%`
        : format.style === "unit" && format.unit
          ? `${plain} ${format.unit}`
          : plain;
  }
};

/** The number as typed while editing: no grouping, the locale's decimal mark. */
export const editableNumberText = (value: number, locale?: string): string => {
  const mark = decimalMark(locale);
  const text = formatPlainNumber(value);
  return mark === "." ? text : text.replace(".", mark);
};

/** The locale's decimal mark ("." or ","). */
export const decimalMark = (locale?: string): string => {
  try {
    const part = new Intl.NumberFormat(locale)
      .formatToParts(1.5)
      .find((item) => item.type === "decimal");
    return part?.value ?? ".";
  } catch {
    return ".";
  }
};

/**
 * What the person typed as a number, or null when empty, or undefined when
 * it isn't one. Grouping marks, spaces, currency symbols, % and the unit are
 * ignored; the locale's decimal mark is the decimal point (a lone "." still
 * reads as one where the mark is ","). Never Number("0x1f") or exponents.
 */
export const parseNumberField = (
  text: string,
  locale?: string,
): number | null | undefined => {
  const mark = decimalMark(locale);
  const group = mark === "." ? "," : ".";
  let cleaned = text.replace(/[\s  ']/gu, "");
  if (cleaned === "") {
    return null;
  }
  const negative = /^[-−(]/u.test(cleaned) || /\)$/u.test(cleaned);
  cleaned = cleaned.replace(/[^0-9.,]/gu, "");
  if (cleaned === "") {
    return undefined;
  }
  // "1.234,5" in de, "1,234.5" in en; a single other mark with 1–2 digits
  // after it reads as decimal ("12.5" typed in de).
  const groups = cleaned.split(group);
  const lastGroup = groups[groups.length - 1] ?? "";
  if (
    !cleaned.includes(mark) &&
    groups.length === 2 &&
    lastGroup.length > 0 &&
    lastGroup.length !== 3
  ) {
    cleaned = groups.join(".");
  } else {
    cleaned = cleaned.split(group).join("");
    if (mark !== ".") {
      cleaned = cleaned.replace(mark, ".");
    }
  }
  if (!/^\d*\.?\d*$/u.test(cleaned) || cleaned === ".") {
    return undefined;
  }
  const number = Number(cleaned);
  if (!Number.isFinite(number)) {
    return undefined;
  }
  return negative ? -number : number;
};

// --- AddressField ---------------------------------------------------------------

export type Address = {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
};

export const ADDRESS_PARTS = [
  { key: "line1", label: "Street", autocomplete: "address-line1", max: 200 },
  {
    key: "line2",
    label: "Apt, suite, unit",
    autocomplete: "address-line2",
    max: 200,
  },
  { key: "city", label: "City", autocomplete: "address-level2", max: 120 },
  {
    key: "region",
    label: "State or region",
    autocomplete: "address-level1",
    max: 120,
  },
  {
    key: "postalCode",
    label: "Postal code",
    autocomplete: "postal-code",
    max: 20,
  },
  { key: "country", label: "Country", autocomplete: "country", max: 2 },
] as const;

export type AddressPart = (typeof ADDRESS_PARTS)[number]["key"];

/** The address read leniently: only string parts, each cleaned and capped. */
export const addressOf = (value: unknown): Address => {
  if (!isObject(value)) {
    return {};
  }
  const out: Address = {};
  for (const part of ADDRESS_PARTS) {
    const raw = value[part.key];
    if (typeof raw !== "string") {
      continue;
    }
    const text =
      part.key === "country"
        ? /^[A-Za-z]{2}$/u.test(raw.trim())
          ? raw.trim().toUpperCase()
          : undefined
        : plainText(raw, part.max);
    if (text) {
      out[part.key] = text;
    }
  }
  return out;
};

/** The address after one part changed; null when every part is empty. */
export const withAddressPart = (
  address: Address,
  key: AddressPart,
  text: string,
): Address | null => {
  const next: Address = { ...address };
  const trimmed = key === "country" ? text.trim().toUpperCase() : text;
  if (trimmed === "") {
    delete next[key];
  } else {
    next[key] = trimmed;
  }
  return Object.keys(next).length > 0 ? next : null;
};

/** Country names in the viewer's language, else the code. */
export const countryName = (code: string, locale?: string): string => {
  try {
    const names = new Intl.DisplayNames(locale ? [locale] : undefined, {
      type: "region",
    });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
};

/** Postal lines: street, street 2, "City, Region Postal", country. */
export const addressLines = (address: Address, locale?: string): string[] => {
  const cityLine = [
    address.city,
    [address.region, address.postalCode].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
  return [
    address.line1,
    address.line2,
    cityLine,
    address.country ? countryName(address.country, locale) : undefined,
  ].filter((line): line is string => Boolean(line));
};

// --- ColorPicker -----------------------------------------------------------------

export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/u;

/** "#RRGGBB" upper-cased, or undefined. */
export const hexColor = (value: unknown): string | undefined =>
  typeof value === "string" && HEX_COLOR.test(value)
    ? value.toUpperCase()
    : undefined;

export const rgbOf = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/**
 * A plain colour word for screen readers ("dark blue", "light grey"), from
 * hue, saturation and lightness. Shared with Swift (`UiTyped.colorName`).
 */
export const colorName = (hex: string): string => {
  const [r, g, b] = rgbOf(hex).map((part) => part / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation =
    delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  const shade = lightness < 0.3 ? "dark " : lightness > 0.75 ? "light " : "";
  if (saturation < 0.15) {
    return lightness < 0.12
      ? "black"
      : lightness > 0.92
        ? "white"
        : `${shade}grey`;
  }
  let hue = 0;
  if (max === r) {
    hue = ((g - b) / delta) % 6;
  } else if (max === g) {
    hue = (b - r) / delta + 2;
  } else {
    hue = (r - g) / delta + 4;
  }
  hue = (hue * 60 + 360) % 360;
  const name =
    hue < 15 || hue >= 345
      ? "red"
      : hue < 45
        ? "orange"
        : hue < 70
          ? "yellow"
          : hue < 165
            ? "green"
            : hue < 195
              ? "teal"
              : hue < 255
                ? "blue"
                : hue < 290
                  ? "purple"
                  : "pink";
  return `${shade}${name}`;
};

/** Readable ink on a swatch: black or white by relative luminance. */
export const inkOn = (hex: string): "#000000" | "#FFFFFF" => {
  const [r, g, b] = rgbOf(hex).map((part) => {
    const c = part / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? "#000000" : "#FFFFFF";
};

export const numberOrNull = (value: unknown): number | null =>
  asNumber(value) ?? null;

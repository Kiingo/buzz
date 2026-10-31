// Generated from the Kiingo surface renderer packages at 9bead1b8e2a179fc0d6d93a384d86d28e66ddf51; do not edit here.
import { useState } from "react";
import {
  ADDRESS_PARTS,
  addressLines,
  addressOf,
  asNumber,
  colorName,
  countryName,
  editableNumberText,
  formatNumberField,
  hexColor,
  inkOn,
  numberFieldFormat,
  parseNumberField,
  withAddressPart,
  type AddressPart,
} from "../core";
import { Check } from "lucide-react";
import { cn } from "./cn";
import { useNodeContext } from "./context";
import { aria, type FieldProps } from "./field";
import { WithCopy } from "./copy";
import { fieldClass } from "./ui";

// Typed inputs (GU-B): NumberField, AddressField, ColorPicker. Logic in
// surface-core `typed.ts`; the Swift kit is the reference for behaviour.

const viewerLocale = (): string | undefined =>
  typeof navigator !== "undefined" ? navigator.language : undefined;

export const NumberInput = (props: FieldProps) => {
  const context = useNodeContext();
  const locale = viewerLocale();
  const format = numberFieldFormat(props.component.props);
  const value = asNumber(context.read(props.pointer));
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [bad, setBad] = useState(false);
  const step = Math.max(
    0.000001,
    context.number(props.component, "step", props.scope) ?? 1,
  );
  const low = context.number(props.component, "min", props.scope);
  const high = context.number(props.component, "max", props.scope);
  const atRest =
    value === undefined ? "" : formatNumberField(value, format, locale);
  const shown =
    draft ?? (value === undefined ? "" : editableNumberText(value, locale));
  const nudge = (direction: 1 | -1) => {
    let next = Number(((value ?? 0) + direction * step).toPrecision(12));
    if (low !== undefined) {
      next = Math.max(low, next);
    }
    if (high !== undefined) {
      next = Math.min(high, next);
    }
    setDraft(undefined);
    context.edit(props.pointer, next);
  };
  const affix =
    format.style === "percent"
      ? "%"
      : format.style === "unit"
        ? format.unit
        : format.style === "currency"
          ? format.currency
          : undefined;
  return (
    <WithCopy
      text={atRest}
      what={props.label}
      copyable={props.component.props.copyable !== false}
    >
      <div className="relative">
        <input
          id={props.id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={draft === undefined ? atRest : shown}
          placeholder={props.placeholder}
          disabled={props.disabled}
          onFocus={() => setDraft(shown)}
          onBlur={() => {
            setDraft(undefined);
            setBad(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              nudge(event.key === "ArrowUp" ? 1 : -1);
            }
          }}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            const parsed = parseNumberField(text, locale);
            setBad(parsed === undefined);
            if (parsed === null) {
              context.edit(props.pointer, undefined);
            } else if (parsed !== undefined && parsed !== value) {
              context.edit(props.pointer, parsed);
            }
          }}
          className={cn(fieldClass, "tabular-nums", affix ? "pr-14" : "")}
          {...aria(props)}
        />
        {affix && draft !== undefined ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground"
          >
            {affix}
          </span>
        ) : null}
      </div>
      {bad ? (
        <p className="mt-1 text-xs text-destructive" role="status">
          Enter a number.
        </p>
      ) : null}
    </WithCopy>
  );
};

export const AddressInput = (props: FieldProps) => {
  const context = useNodeContext();
  const locale = viewerLocale();
  const address = addressOf(context.read(props.pointer));
  const lines =
    context.number(props.component, "lines", props.scope) === 1 ? 1 : 2;
  const countries = Array.isArray(props.component.props.countries)
    ? props.component.props.countries
        .filter(
          (code): code is string =>
            typeof code === "string" && /^[A-Z]{2}$/u.test(code),
        )
        .slice(0, 60)
    : [];
  const fallbackCountry =
    typeof props.component.props.defaultCountry === "string" &&
    /^[A-Z]{2}$/u.test(props.component.props.defaultCountry)
      ? props.component.props.defaultCountry
      : undefined;
  const set = (key: AddressPart, text: string) => {
    const base =
      !address.country && fallbackCountry && key !== "country"
        ? { ...address, country: fallbackCountry }
        : address;
    context.edit(props.pointer, withAddressPart(base, key, text) ?? undefined);
  };
  const country = address.country ?? fallbackCountry ?? "";
  return (
    <WithCopy
      text={addressLines(address, locale).join("\n")}
      what={props.label}
      copyable={props.component.props.copyable !== false}
      top
    >
      <div className="grid grid-cols-2 gap-2" {...aria(props)}>
        {ADDRESS_PARTS.filter(
          (part) =>
            part.key !== "country" && (lines === 2 || part.key !== "line2"),
        ).map((part) => (
          <label
            key={part.key}
            className={cn(
              "flex flex-col gap-0.5 text-xs text-muted-foreground",
              part.key === "line1" || part.key === "line2" ? "col-span-2" : "",
            )}
          >
            {part.label}
            <input
              id={part.key === "line1" ? props.id : undefined}
              type="text"
              autoComplete={part.autocomplete}
              maxLength={part.max}
              value={address[part.key] ?? ""}
              disabled={props.disabled}
              onChange={(event) => set(part.key, event.target.value)}
              className={fieldClass}
            />
          </label>
        ))}
        {/* biome-ignore lint/a11y/noLabelWithoutControl: it wraps the select or the input below, whichever is shown. */}
        <label className="col-span-2 flex flex-col gap-0.5 text-xs text-muted-foreground">
          Country
          {countries.length > 0 ? (
            <select
              autoComplete="country"
              value={country}
              disabled={props.disabled}
              onChange={(event) => set("country", event.target.value)}
              className={fieldClass}
            >
              <option value="">Choose a country</option>
              {countries.map((code) => (
                <option key={code} value={code}>
                  {countryName(code, locale)}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              autoComplete="country"
              maxLength={2}
              value={country}
              placeholder="US"
              disabled={props.disabled}
              onChange={(event) =>
                set(
                  "country",
                  event.target.value.replace(/[^A-Za-z]/gu, "").slice(0, 2),
                )
              }
              aria-describedby={`${props.id}-country-name`}
              className={cn(fieldClass, "uppercase")}
            />
          )}
          {countries.length === 0 && /^[A-Z]{2}$/u.test(country) ? (
            <span id={`${props.id}-country-name`}>
              {countryName(country, locale)}
            </span>
          ) : null}
        </label>
      </div>
    </WithCopy>
  );
};

export const ColorInput = (props: FieldProps) => {
  const context = useNodeContext();
  const value = hexColor(context.read(props.pointer));
  const swatches = Array.isArray(props.component.props.swatches)
    ? [
        ...new Set(
          props.component.props.swatches
            .map(hexColor)
            .filter((hex): hex is string => Boolean(hex))
            .slice(0, 24),
        ),
      ]
    : [];
  const custom = props.component.props.allowCustom !== false;
  const set = (hex: string | undefined) => context.edit(props.pointer, hex);
  return (
    <WithCopy
      text={value ?? ""}
      what={props.label}
      copyable={props.component.props.copyable !== false}
    >
      <div className="flex flex-wrap items-center gap-2" {...aria(props)}>
        {swatches.map((hex) => {
          const selected = hex === value;
          return (
            <button
              key={hex}
              type="button"
              disabled={props.disabled}
              aria-pressed={selected}
              aria-label={`${hex}, ${colorName(hex)}`}
              title={hex}
              onClick={() => set(selected ? undefined : hex)}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full border border-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                selected
                  ? "ring-2 ring-ring ring-offset-2 ring-offset-background"
                  : "",
              )}
              style={{ backgroundColor: hex }}
            >
              {selected ? (
                <Check
                  aria-hidden
                  className="h-4 w-4"
                  style={{ color: inkOn(hex) }}
                />
              ) : null}
            </button>
          );
        })}
        {custom ? (
          <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              id={props.id}
              type="color"
              value={value ?? "#000000"}
              disabled={props.disabled}
              onChange={(event) => set(hexColor(event.target.value))}
              className="h-8 w-10 cursor-pointer rounded border border-input bg-background"
              aria-label={`${props.label}: choose any colour`}
            />
            Any colour
          </label>
        ) : null}
        <span className="text-xs tabular-nums text-foreground">
          {value ? `${value} · ${colorName(value)}` : "None"}
        </span>
      </div>
    </WithCopy>
  );
};

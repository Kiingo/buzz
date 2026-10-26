// Generated from the Kiingo surface renderer packages at d5090421e1194836177b7c492a84f74342e017c6; do not edit here.
import { useState } from "react";
import {
  ownEntry,
  appendPointer,
  asInt,
  asNumber,
  asksForSecret,
  cellText,
  formatPlainNumber,
  isObject,
  jsonEqual,
  parseDate,
  plainText,
  type ComponentType,
  type JsonValue,
  type Pointer,
  type SurfaceComponent,
} from "../core";
import { cn } from "./cn";
import { useNodeContext, type NodeContext, type NodeProps } from "./context";
import { Glyphs } from "./icons";
import { fieldClass, SurfaceButton } from "./ui";
import { aria, validZone, type FieldProps } from "./field";
import {
  EntityInput,
  FileInput,
  RecipientInput,
  ReorderInput,
  RichTextInput,
  TimeSlotInput,
} from "./pickers";

// §4.3 Inputs. Each binds `value` to a path; edits go to the controller
// (saved 600 ms after the last change). A field that asks for a secret is
// never drawn (§10, R11).

const LABEL_BESIDE = new Set<string>(["Checkbox", "Toggle"]);

export const InputView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const label = context.text(component, "label", scope, 80) ?? "Field";
  const help = context.text(component, "help", scope, 300);
  const placeholder = context.text(component, "placeholder", scope, 120);
  if (asksForSecret([label, help, placeholder])) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Glyphs.secret aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        This field asked for a password or code, so it isn’t shown. Kiingo never
        collects those here.
      </p>
    );
  }
  const pointer = context.pointer(component, scope);
  if (!pointer) {
    return null;
  }
  const id = context.domId(component, scope);
  const problem = context.problem(component, scope);
  const describedBy = problem || help ? `${id}-note` : undefined;
  const required = component.props.required === true;
  const field: FieldProps = {
    component,
    scope,
    pointer,
    id,
    label,
    placeholder: placeholder ?? "",
    disabled: !context.canEdit(component, scope),
    describedBy,
    invalid: Boolean(problem),
  };
  const beside = LABEL_BESIDE.has(component.type);
  const grouped = GROUPED.has(component.type);
  const LabelTag = grouped ? "span" : "label";
  return (
    <div
      className="flex flex-col gap-1"
      role={grouped ? "group" : undefined}
      aria-labelledby={grouped ? `${id}-label` : undefined}
    >
      {beside ? null : (
        <LabelTag
          id={`${id}-label`}
          {...(grouped ? {} : { htmlFor: id })}
          className="text-sm font-medium"
        >
          {label}
          {required ? <span aria-hidden> *</span> : null}
        </LabelTag>
      )}
      <Field type={component.type as ComponentType} {...field} />
      {problem ? (
        <p id={describedBy} className="text-xs text-destructive" role="alert">
          {problem}
        </p>
      ) : help ? (
        <p id={describedBy} className="text-xs text-muted-foreground">
          {help}
        </p>
      ) : null}
    </div>
  );
};

/** Inputs drawn as several controls under one label. */
const GROUPED = new Set<string>([
  "RichTextEditor",
  "RecipientField",
  "ChoicePicker",
  "Rating",
  "FileInput",
  "EntityPicker",
  "Reorder",
  "TimeSlotPicker",
  "Stepper",
]);

const Field = ({ type, ...props }: FieldProps & { type: ComponentType }) => {
  switch (type) {
    case "TextField":
      return <TextInput {...props} />;
    case "RichTextEditor":
      return <RichTextInput {...props} />;
    case "RecipientField":
      return <RecipientInput {...props} />;
    case "Select":
      return <SelectInput {...props} />;
    case "ChoicePicker":
      return <ChoiceInput {...props} />;
    case "Checkbox":
      return <BoolInput {...props} toggle={false} />;
    case "Toggle":
      return <BoolInput {...props} toggle />;
    case "Slider":
      return <SliderInput {...props} />;
    case "Stepper":
      return <StepperInput {...props} />;
    case "DateTimeInput":
      return <DateInput {...props} />;
    case "Rating":
      return <RatingInput {...props} />;
    case "FileInput":
      return <FileInput {...props} />;
    case "EntityPicker":
      return <EntityInput {...props} />;
    case "Reorder":
      return <ReorderInput {...props} />;
    case "TimeSlotPicker":
      return <TimeSlotInput {...props} />;
    default:
      return null;
  }
};

// --- Text ------------------------------------------------------------------------

const TEXT_TYPES: Record<string, string> = {
  email: "email",
  url: "url",
  phone: "tel",
  number: "text",
  short: "text",
};

const TextInput = (props: FieldProps) => {
  const context = useNodeContext();
  const kind = context.string(props.component, "kind") ?? "short";
  const value = context.read(props.pointer);
  const maxLength = asInt(props.component.props.maxLength);
  const [numberDraft, setNumberDraft] = useState<string | undefined>(undefined);
  if (kind === "long") {
    return (
      <textarea
        id={props.id}
        rows={4}
        value={
          typeof value === "string"
            ? value
            : value === undefined || value === null
              ? ""
              : cellText(value)
        }
        placeholder={props.placeholder}
        disabled={props.disabled}
        maxLength={maxLength}
        onChange={(event) => context.edit(props.pointer, event.target.value)}
        className={cn(fieldClass, "min-h-[5rem] resize-y")}
        {...aria(props)}
      />
    );
  }
  if (kind === "number") {
    const shown =
      numberDraft ??
      (typeof value === "number"
        ? formatPlainNumber(value)
        : typeof value === "string"
          ? value
          : "");
    return (
      <input
        id={props.id}
        type="text"
        inputMode="decimal"
        value={shown}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(event) => {
          const text = event.target.value;
          setNumberDraft(text);
          const trimmed = text.trim().replace(/,/gu, "");
          if (trimmed === "") {
            context.edit(props.pointer, undefined);
          } else if (Number.isFinite(Number(trimmed))) {
            context.edit(props.pointer, Number(trimmed));
          }
        }}
        onBlur={() => setNumberDraft(undefined)}
        className={fieldClass}
        {...aria(props)}
      />
    );
  }
  return (
    <input
      id={props.id}
      type={ownEntry(TEXT_TYPES, kind) ?? "text"}
      value={
        typeof value === "string"
          ? value
          : typeof value === "number"
            ? formatPlainNumber(value)
            : ""
      }
      placeholder={props.placeholder}
      disabled={props.disabled}
      maxLength={maxLength}
      autoComplete="off"
      autoCapitalize={kind === "email" || kind === "url" ? "none" : undefined}
      spellCheck={
        kind === "email" || kind === "url" || kind === "phone"
          ? false
          : undefined
      }
      onChange={(event) => context.edit(props.pointer, event.target.value)}
      className={fieldClass}
      {...aria(props)}
    />
  );
};
// --- Choices --------------------------------------------------------------------

type Option = {
  index: number;
  value: JsonValue;
  label: string;
  detail?: string;
};

const optionsOf = (
  context: NodeContext,
  component: SurfaceComponent,
  scope: Pointer,
): Option[] =>
  context
    .list(component, "options", scope)
    .slice(0, 200)
    .flatMap((item, index) => {
      if (isObject(item)) {
        const value = item.value ?? null;
        const detail = plainText(item.description, 500, true);
        return [
          {
            index,
            value,
            label: plainText(item.label ?? value, 200) ?? "",
            ...(detail ? { detail } : {}),
          },
        ];
      }
      const label = plainText(item, 120);
      return label ? [{ index, value: item, label }] : [];
    });

const SelectInput = (props: FieldProps) => {
  const context = useNodeContext();
  const options = optionsOf(context, props.component, props.scope);
  const current = context.read(props.pointer);
  const selected = options.find(
    (option) => current !== undefined && jsonEqual(option.value, current),
  );
  return (
    <select
      id={props.id}
      value={selected ? String(selected.index) : ""}
      disabled={props.disabled}
      onChange={(event) => {
        const option = options.find(
          (item) => String(item.index) === event.target.value,
        );
        context.edit(props.pointer, option ? option.value : undefined);
      }}
      className={fieldClass}
      {...aria(props)}
    >
      <option value="">{props.placeholder || "Choose…"}</option>
      {options.map((option) => (
        <option key={option.index} value={String(option.index)}>
          {option.label}
        </option>
      ))}
    </select>
  );
};

const ChoiceInput = (props: FieldProps) => {
  const context = useNodeContext();
  const options = optionsOf(context, props.component, props.scope);
  const multi = context.string(props.component, "mode") === "multiple";
  const style =
    context.string(props.component, "style") ?? (multi ? "checkbox" : "radio");
  const raw = context.read(props.pointer);
  const selected: JsonValue[] = Array.isArray(raw)
    ? raw
    : raw === undefined || raw === null
      ? []
      : [raw];
  const isOn = (option: Option) =>
    selected.some((value) => jsonEqual(value, option.value));
  const toggle = (option: Option) => {
    if (!multi) {
      context.edit(props.pointer, option.value);
      return;
    }
    if (isOn(option)) {
      context.edit(
        props.pointer,
        selected.filter((value) => !jsonEqual(value, option.value)),
      );
      return;
    }
    const cap = asInt(props.component.props.maxSelections);
    if (cap !== undefined && selected.length >= cap) {
      return;
    }
    context.edit(props.pointer, [...selected, option.value]);
  };
  const role = multi ? "checkbox" : "radio";
  if (style === "chips") {
    return (
      <div
        className="flex flex-wrap gap-1.5"
        role={multi ? "group" : "radiogroup"}
        aria-labelledby={`${props.id}-label`}
      >
        {options.map((option) => (
          <button
            key={option.index}
            type="button"
            role={role}
            aria-checked={isOn(option)}
            disabled={props.disabled}
            onClick={() => toggle(option)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs",
              isOn(option)
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-muted",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div
      className={cn("flex flex-col", style === "cards" ? "gap-2" : "gap-1.5")}
      role={multi ? "group" : "radiogroup"}
      aria-labelledby={`${props.id}-label`}
    >
      {options.map((option) => {
        const on = isOn(option);
        const Glyph = multi
          ? on
            ? Glyphs.checkboxOn
            : Glyphs.checkboxOff
          : on
            ? Glyphs.radioOn
            : Glyphs.radioOff;
        return (
          <button
            key={option.index}
            type="button"
            role={role}
            aria-checked={on}
            disabled={props.disabled}
            onClick={() => toggle(option)}
            className={cn(
              "flex items-start gap-2 text-left disabled:opacity-60",
              style === "cards" &&
                cn(
                  "rounded-lg border p-2.5",
                  on
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card hover:bg-muted/50",
                ),
            )}
          >
            <Glyph
              aria-hidden
              className={cn(
                "mt-0.5 h-4 w-4 shrink-0",
                on ? "text-primary" : "text-muted-foreground",
              )}
            />
            <span className="min-w-0">
              <span
                className={cn(
                  "block text-sm",
                  style === "cards" && "font-semibold",
                )}
              >
                {option.label}
              </span>
              {option.detail ? (
                <span className="block text-xs text-muted-foreground">
                  {option.detail}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
};

const BoolInput = (props: FieldProps & { toggle: boolean }) => {
  const context = useNodeContext();
  const on = context.read(props.pointer) === true;
  if (props.toggle) {
    return (
      <button
        id={props.id}
        type="button"
        role="switch"
        aria-checked={on}
        disabled={props.disabled}
        onClick={() => context.edit(props.pointer, !on)}
        className="flex items-center justify-between gap-3 text-left text-sm disabled:opacity-60"
        {...aria(props)}
      >
        <span>{props.label}</span>
        <span
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors",
            on ? "bg-primary" : "bg-muted-foreground/30",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 h-4 w-4 rounded-full bg-background shadow transition-transform",
              on ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </span>
      </button>
    );
  }
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        id={props.id}
        type="checkbox"
        checked={on}
        disabled={props.disabled}
        onChange={(event) => context.edit(props.pointer, event.target.checked)}
        className="mt-0.5 h-4 w-4 accent-primary"
        {...aria(props)}
      />
      <span>{props.label}</span>
    </label>
  );
};

// --- Numbers ---------------------------------------------------------------------

const SliderInput = (props: FieldProps) => {
  const context = useNodeContext();
  const low = context.number(props.component, "min", props.scope) ?? 0;
  const high = Math.max(
    low + 1,
    context.number(props.component, "max", props.scope) ?? 100,
  );
  const step = Math.max(
    0.0001,
    context.number(props.component, "step", props.scope) ?? 1,
  );
  const unit = context.text(props.component, "unit", props.scope, 12);
  const value = Math.min(
    Math.max(asNumber(context.read(props.pointer)) ?? low, low),
    high,
  );
  return (
    <div className="flex items-center gap-3">
      <input
        id={props.id}
        type="range"
        min={low}
        max={high}
        step={step}
        value={value}
        disabled={props.disabled}
        onChange={(event) =>
          context.edit(props.pointer, Number(event.target.value))
        }
        className="flex-1 accent-primary"
        aria-valuetext={`${formatPlainNumber(value)}${unit ? ` ${unit}` : ""}`}
        {...aria(props)}
      />
      <span className="min-w-[3rem] text-right text-xs tabular-nums">
        {formatPlainNumber(value)}
        {unit ? ` ${unit}` : ""}
      </span>
    </div>
  );
};

const StepperInput = (props: FieldProps) => {
  const context = useNodeContext();
  const low = context.number(props.component, "min", props.scope) ?? -1_000_000;
  const high = Math.max(
    low,
    context.number(props.component, "max", props.scope) ?? 1_000_000,
  );
  const step = Math.max(
    0.0001,
    context.number(props.component, "step", props.scope) ?? 1,
  );
  const value = Math.min(
    Math.max(asNumber(context.read(props.pointer)) ?? Math.max(low, 0), low),
    high,
  );
  const set = (next: number) =>
    context.edit(
      props.pointer,
      Number(Math.min(high, Math.max(low, next)).toPrecision(12)),
    );
  return (
    <div className="inline-flex items-center gap-2" {...aria(props)}>
      <SurfaceButton
        size="sm"
        aria-label={`Decrease ${props.label}`}
        disabled={props.disabled || value <= low}
        onClick={() => set(value - step)}
      >
        −
      </SurfaceButton>
      <output
        id={props.id}
        aria-live="polite"
        className="min-w-[3rem] text-center text-sm tabular-nums"
      >
        {formatPlainNumber(value)}
      </output>
      <SurfaceButton
        size="sm"
        aria-label={`Increase ${props.label}`}
        disabled={props.disabled || value >= high}
        onClick={() => set(value + step)}
      >
        +
      </SurfaceButton>
    </div>
  );
};

const RatingInput = (props: FieldProps) => {
  const context = useNodeContext();
  const scale = context.string(props.component, "scale") === "ten" ? 10 : 5;
  const current = asInt(context.read(props.pointer)) ?? 0;
  return (
    <div
      id={props.id}
      role="radiogroup"
      aria-labelledby={`${props.id}-label`}
      className="flex flex-wrap gap-1"
      onKeyDown={(event) => {
        if (props.disabled) {
          return;
        }
        if (event.key === "ArrowRight" || event.key === "ArrowUp") {
          event.preventDefault();
          context.edit(props.pointer, Math.min(scale, current + 1));
        } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
          event.preventDefault();
          context.edit(props.pointer, Math.max(1, current - 1));
        }
      }}
    >
      {Array.from({ length: scale }, (_, offset) => {
        const index = offset + 1;
        const on = scale === 5 ? index <= current : index === current;
        return (
          <button
            key={index}
            type="button"
            role="radio"
            aria-checked={index === current}
            aria-label={`${index} of ${scale}`}
            tabIndex={index === (current || 1) ? 0 : -1}
            disabled={props.disabled}
            onClick={() => context.edit(props.pointer, index)}
            className={cn(
              "inline-flex items-center justify-center disabled:opacity-60",
              scale === 5
                ? "h-7 w-7"
                : cn(
                    "h-7 min-w-[1.75rem] rounded-full text-xs tabular-nums",
                    on ? "bg-primary/20" : "bg-muted",
                  ),
            )}
          >
            {scale === 5 ? (
              <Glyphs.star
                aria-hidden
                className={cn(
                  "h-5 w-5",
                  on
                    ? "fill-amber-500 text-amber-500"
                    : "text-muted-foreground",
                )}
              />
            ) : (
              index
            )}
          </button>
        );
      })}
    </div>
  );
};

// --- Dates -----------------------------------------------------------------------

const pad = (value: number) => String(value).padStart(2, "0");

/** The wall-clock parts of `epoch` in `timeZone`. */
const zonedParts = (epoch: number, timeZone: string | undefined) => {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    format
      .formatToParts(new Date(epoch))
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
};

const offsetMinutes = (epoch: number, timeZone: string | undefined): number => {
  const parts = zonedParts(epoch, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asUtc - Math.floor(epoch / 1000) * 1000) / 60_000);
};

/** An ISO date-time as `yyyy-MM-ddTHH:mm` in the zone (for datetime-local). */
const toLocalInput = (value: unknown, zone: string | undefined): string => {
  const date = parseDate(value);
  if (!date) {
    return "";
  }
  const parts = zonedParts(date.getTime(), zone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
};

/** `yyyy-MM-ddTHH:mm` in the zone as ISO 8601 with that zone's offset (as Swift writes it). */
const fromLocalInput = (
  text: string,
  zone: string | undefined,
): string | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u.exec(text);
  if (!match) {
    return undefined;
  }
  const [, y, mo, d, h, mi] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let offset = offsetMinutes(guess, zone);
  offset = offsetMinutes(guess - offset * 60_000, zone);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};

const DateInput = (props: FieldProps) => {
  const context = useNodeContext();
  const mode = context.string(props.component, "mode") ?? "date";
  const zone = validZone(context.string(props.component, "timeZone"));
  const min =
    typeof props.component.props.min === "string"
      ? props.component.props.min
      : undefined;
  const max =
    typeof props.component.props.max === "string"
      ? props.component.props.max
      : undefined;
  const value = context.read(props.pointer);
  if (mode === "dateRange") {
    const range = isObject(value) ? value : {};
    const part = (key: "start" | "end", title: string) => {
      const pointer = appendPointer(props.pointer, key);
      const current =
        typeof range[key] === "string"
          ? (range[key] as string).slice(0, 10)
          : "";
      return (
        <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {title}
          <input
            id={key === "start" ? props.id : `${props.id}-end`}
            type="date"
            value={current}
            min={min?.slice(0, 10)}
            max={max?.slice(0, 10)}
            disabled={props.disabled}
            onChange={(event) =>
              context.edit(pointer, event.target.value || undefined)
            }
            className={fieldClass}
            {...aria(props)}
          />
        </label>
      );
    };
    return (
      <div className="flex flex-wrap gap-3">
        {part("start", "From")}
        {part("end", "To")}
      </div>
    );
  }
  if (mode === "time") {
    return (
      <input
        id={props.id}
        type="time"
        value={typeof value === "string" ? value.slice(0, 5) : ""}
        disabled={props.disabled}
        onChange={(event) =>
          context.edit(props.pointer, event.target.value || undefined)
        }
        className={fieldClass}
        {...aria(props)}
      />
    );
  }
  if (mode === "datetime") {
    return (
      <div className="flex flex-col gap-0.5">
        <input
          id={props.id}
          type="datetime-local"
          value={toLocalInput(value, zone)}
          min={min ? toLocalInput(min, zone) || undefined : undefined}
          max={max ? toLocalInput(max, zone) || undefined : undefined}
          disabled={props.disabled}
          onChange={(event) =>
            context.edit(
              props.pointer,
              fromLocalInput(event.target.value, zone),
            )
          }
          className={fieldClass}
          {...aria(props)}
        />
        {zone ? (
          <span className="text-2xs text-muted-foreground">
            Time zone: {zone.replace(/_/gu, " ")}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <input
      id={props.id}
      type="date"
      value={typeof value === "string" ? value.slice(0, 10) : ""}
      min={min?.slice(0, 10)}
      max={max?.slice(0, 10)}
      disabled={props.disabled}
      onChange={(event) =>
        context.edit(props.pointer, event.target.value || undefined)
      }
      className={fieldClass}
      {...aria(props)}
    />
  );
};

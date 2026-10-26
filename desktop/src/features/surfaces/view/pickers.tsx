// Generated from the Kiingo surface renderer packages at 280b8811c46f5aaa8c44a036f0bf0be29fabdbeb; do not edit here.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  appendPointer,
  asInt,
  asNumber,
  cellText,
  decodeEntityKey,
  ENTITY_TYPES,
  formatDay,
  formatTime,
  dayKey,
  isObject,
  jsonEqual,
  matchesFormat,
  openableUrl,
  parseDate,
  plainText,
  richTextOf,
  type EntityType,
  type JsonValue,
  type LookupItem,
} from "../core";
import { cn } from "./cn";
import { useNodeContext } from "./context";
import { EntityChip, FileRow } from "./display";
import { ENTITY_NOUNS, Glyphs } from "./icons";
import { MarkdownText } from "./markdown";
import { fieldClass, QuoteBox, SurfaceButton } from "./ui";
import { aria, validZone, type FieldProps } from "./field";

// §4.3 inputs that look things up or hold several values: the body editor,
// recipients, files, Kiingo objects, reordering and time slots.

/**
 * The body editor: Markdown on the wire (`{format: "markdown", text}`), with
 * Bold, Italic, List, Link and Quote and a preview. Opening it changes
 * nothing; only the user's own edits are saved.
 */
export const RichTextInput = (props: FieldProps) => {
  const context = useNodeContext();
  const area = useRef<HTMLTextAreaElement | null>(null);
  const [preview, setPreview] = useState(false);
  const [linking, setLinking] = useState<string | undefined>(undefined);
  const linkField = useRef<HTMLInputElement | null>(null);
  const linkOpen = linking !== undefined;
  // The link field takes focus when the Link button opens it.
  useEffect(() => {
    if (linkOpen) {
      linkField.current?.focus();
    }
  }, [linkOpen]);
  const text = richTextOf(context.read(props.pointer));
  const minLines = Math.max(
    2,
    Math.min(30, Math.round(asNumber(props.component.props.minLines) ?? 6)),
  );
  const maxLength = asInt(props.component.props.maxLength);
  const save = (next: string) =>
    context.edit(props.pointer, { format: "markdown", text: next });
  const change = (
    make: (
      value: string,
      start: number,
      end: number,
    ) => { value: string; start: number; end: number },
  ) => {
    const element = area.current;
    if (!element || props.disabled) {
      return;
    }
    const result = make(
      element.value,
      element.selectionStart,
      element.selectionEnd,
    );
    save(result.value);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(result.start, result.end);
    });
  };
  const wrap = (marker: string) =>
    change((value, start, end) => {
      const inner = value.slice(start, end);
      const wrapped =
        inner.startsWith(marker) &&
        inner.endsWith(marker) &&
        inner.length >= marker.length * 2;
      const replacement = wrapped
        ? inner.slice(marker.length, inner.length - marker.length)
        : `${marker}${inner}${marker}`;
      const next = value.slice(0, start) + replacement + value.slice(end);
      return wrapped
        ? { value: next, start, end: start + replacement.length }
        : {
            value: next,
            start: start + marker.length,
            end: start + marker.length + inner.length,
          };
    });
  const prefixLine = (prefix: string) =>
    change((value, start, end) => {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const next = value.slice(0, lineStart) + prefix + value.slice(lineStart);
      return {
        value: next,
        start: start + prefix.length,
        end: end + prefix.length,
      };
    });
  const applyLink = (address: string) => {
    const url = openableUrl(address.trim());
    if (!url || !url.startsWith("https://")) {
      return;
    }
    change((value, start, end) => {
      const label = value.slice(start, end) || url;
      const link = `[${label.replace(/[[\]]/gu, "")}](${url})`;
      return {
        value: value.slice(0, start) + link + value.slice(end),
        start: start + link.length,
        end: start + link.length,
      };
    });
    setLinking(undefined);
  };
  const tool = (name: string, run: () => void, glyph: ReactNode) => (
    <button
      type="button"
      title={name}
      aria-label={name}
      disabled={props.disabled || preview}
      onClick={run}
      className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
    >
      {glyph}
    </button>
  );
  return (
    <div className="flex flex-col gap-1">
      <div
        className="flex flex-wrap items-center gap-0.5"
        role="toolbar"
        aria-label="Formatting"
      >
        {tool("Bold", () => wrap("**"), <strong>B</strong>)}
        {tool("Italic", () => wrap("*"), <em>I</em>)}
        {tool("List", () => prefixLine("- "), "•")}
        {tool("Link", () => setLinking("https://"), "Link")}
        {tool("Quote", () => prefixLine("> "), "❝")}
        <span className="flex-1" />
        <button
          type="button"
          aria-pressed={preview}
          onClick={() => setPreview(!preview)}
          className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {preview ? "Edit" : "Preview"}
        </button>
      </div>
      {linking !== undefined ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            applyLink(linking);
          }}
        >
          <input
            type="url"
            value={linking}
            aria-label="Link address (https only)"
            onChange={(event) => setLinking(event.target.value)}
            className={cn(fieldClass, "h-8 py-1 text-xs")}
            ref={linkField}
          />
          <SurfaceButton size="sm" type="submit">
            Add
          </SurfaceButton>
          <SurfaceButton
            size="sm"
            variant="plain"
            onClick={() => setLinking(undefined)}
          >
            Cancel
          </SurfaceButton>
        </form>
      ) : null}
      {preview ? (
        <div className="min-h-[5rem] rounded-md border border-border px-3 py-2">
          {text && context.isUntrustedAt(props.pointer) ? (
            // An outside value is quoted, never links (79 W6).
            <QuoteBox text={text} />
          ) : text ? (
            <MarkdownText
              text={text}
              onLink={context.openLink}
              budget={context.markdown}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Nothing yet</p>
          )}
        </div>
      ) : (
        <textarea
          ref={area}
          id={props.id}
          value={text}
          rows={minLines}
          maxLength={maxLength}
          placeholder={props.placeholder}
          disabled={props.disabled}
          aria-labelledby={`${props.id}-label`}
          onChange={(event) => save(event.target.value)}
          className={cn(fieldClass, "resize-y leading-relaxed")}
          {...aria(props)}
        />
      )}
    </div>
  );
};

// --- Lookups ---------------------------------------------------------------------

/** Results for a typed query (2+ characters, 250 ms after the last key). */
const useLookup = (
  query: string,
  search: (text: string) => Promise<LookupItem[]>,
): LookupItem[] => {
  const [results, setResults] = useState<LookupItem[]>([]);
  const searchRef = useRef(search);
  searchRef.current = search;
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setResults([]);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchRef.current(text).then((items) => {
        if (!cancelled) {
          setResults(items);
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);
  return results;
};

const SuggestionList = ({
  items,
  onPick,
  max,
}: {
  items: LookupItem[];
  onPick: (item: LookupItem) => void;
  max: number;
}) =>
  items.length > 0 ? (
    <ul
      className="rounded-md border border-border bg-popover text-popover-foreground"
      role="listbox"
    >
      {items.slice(0, max).map((item) => (
        <li
          key={`${item.type ?? ""}:${item.id}`}
          role="option"
          aria-selected={false}
        >
          <button
            type="button"
            onClick={() => onPick(item)}
            className="w-full px-3 py-1.5 text-left hover:bg-muted"
          >
            <span className="block text-sm">{item.title}</span>
            {item.subtitle || (item.address && item.address !== item.title) ? (
              <span className="block text-xs text-muted-foreground">
                {item.subtitle ?? item.address}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  ) : null;

const Chip = ({
  children,
  onRemove,
  removeLabel,
  disabled,
}: {
  children: ReactNode;
  onRemove: () => void;
  removeLabel: string;
  disabled: boolean;
}) => (
  <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
    {children}
    <button
      type="button"
      aria-label={removeLabel}
      disabled={disabled}
      onClick={onRemove}
      className="rounded-full text-muted-foreground hover:text-foreground disabled:opacity-40"
    >
      <Glyphs.close aria-hidden className="h-3 w-3" />
    </button>
  </span>
);

/** Chips of `{email, name?, outside?}`; `outside` is the server's flag. */
export const RecipientInput = (props: FieldProps) => {
  const context = useNodeContext();
  const [query, setQuery] = useState("");
  const raw = context.read(props.pointer);
  const recipients: JsonValue[] = Array.isArray(raw)
    ? raw
    : typeof raw === "string" && raw
      ? [raw]
      : [];
  const single = props.component.props.single === true;
  const limitRaw = asInt(props.component.props.maxRecipients);
  const limit = limitRaw !== undefined ? Math.max(1, limitRaw) : undefined;
  const suggestions = useLookup(query, (text) =>
    context.controller.lookupRecipients(text),
  );
  const labelOf = (item: JsonValue) =>
    (isObject(item) ? plainText(item.name, 80) : undefined) ??
    plainText(isObject(item) ? item.email : item, 320) ??
    "?";
  const addressOf = (item: JsonValue) => (isObject(item) ? item.email : item);
  const add = (item: JsonValue) => {
    const address = String(addressOf(item) ?? "").toLowerCase();
    if (
      recipients.some(
        (existing) =>
          String(addressOf(existing) ?? "").toLowerCase() === address,
      )
    ) {
      return;
    }
    if (single) {
      context.edit(props.pointer, [item]);
    } else {
      if (limit !== undefined && recipients.length >= limit) {
        return;
      }
      context.edit(props.pointer, [...recipients, item]);
    }
    setQuery("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      {recipients.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {recipients.map((item, index) => (
            <Chip
              key={index}
              disabled={props.disabled}
              removeLabel={`Remove ${labelOf(item)}`}
              onRemove={() =>
                context.edit(
                  props.pointer,
                  recipients.filter((_, other) => other !== index),
                )
              }
            >
              {isObject(item) && item.outside === true ? (
                <Glyphs.globe
                  aria-label="Outside your organization"
                  className="h-3 w-3 text-amber-800"
                />
              ) : null}
              <span className="truncate">{labelOf(item)}</span>
            </Chip>
          ))}
        </div>
      ) : null}
      <input
        id={props.id}
        type="email"
        value={query}
        placeholder={props.placeholder || "Add a name or address"}
        disabled={props.disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            const text = query.trim();
            if (matchesFormat(text, "email")) {
              event.preventDefault();
              add({ email: text });
            }
          }
        }}
        className={fieldClass}
        {...aria(props)}
      />
      <SuggestionList
        items={suggestions}
        max={6}
        onPick={(item) =>
          add({ email: item.address ?? item.id, name: item.title })
        }
      />
    </div>
  );
};

// --- Files and objects -----------------------------------------------------------

export const FileInput = (props: FieldProps) => {
  const context = useNodeContext();
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);
  const raw = context.read(props.pointer);
  const files: JsonValue[] = Array.isArray(raw) ? raw : [];
  const maxFiles = Math.max(
    1,
    Math.min(50, Math.round(asNumber(props.component.props.maxFiles) ?? 10)),
  );
  const listed = context
    .list(props.component, "sources", props.scope)
    .filter((item): item is string => typeof item === "string");
  const sources = listed.length ? listed : ["device", "kiingo"];
  const results = useLookup(query, (text) =>
    context.controller.lookupFiles(text),
  );
  const pick = context.host.pickFiles;
  const full = files.length >= maxFiles;
  const add = (picked: JsonValue[]) => {
    const next =
      maxFiles === 1
        ? picked.slice(0, 1)
        : [...files, ...picked].slice(0, maxFiles);
    context.edit(props.pointer, next);
  };
  return (
    <div className="flex flex-col gap-1.5">
      {files.map((item, index) => (
        <div key={index} className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <FileRow
              item={item}
              outside={context.isUntrustedAt(props.pointer)}
            />
          </div>
          <SurfaceButton
            size="sm"
            variant="plain"
            aria-label="Remove"
            disabled={props.disabled}
            onClick={() =>
              context.edit(
                props.pointer,
                files.filter((_, other) => other !== index),
              )
            }
          >
            Remove
          </SurfaceButton>
        </div>
      ))}
      {sources.includes("device") && pick ? (
        <SurfaceButton
          size="sm"
          className="self-start"
          disabled={props.disabled || picking || full}
          onClick={() => {
            setPicking(true);
            void pick(maxFiles > 1)
              .then((uploaded) => {
                const refs = uploaded.map((file) => ({
                  artifactId: file.id,
                  name: file.name || "File",
                  ...(file.size !== undefined ? { size: file.size } : {}),
                  ...(file.type ? { contentType: file.type } : {}),
                }));
                if (refs.length) {
                  add(refs);
                }
              })
              .finally(() => setPicking(false));
          }}
        >
          <Glyphs.attach aria-hidden className="h-4 w-4" />
          {picking ? "Attaching…" : "Attach files"}
        </SurfaceButton>
      ) : null}
      {sources.includes("kiingo") ? (
        <>
          <input
            id={props.id}
            type="search"
            value={query}
            placeholder="Search Kiingo files"
            disabled={props.disabled || full}
            onChange={(event) => setQuery(event.target.value)}
            className={fieldClass}
            {...aria(props)}
          />
          <SuggestionList
            items={results}
            max={6}
            onPick={(item) => {
              add([{ artifactId: item.id, name: item.title }]);
              setQuery("");
            }}
          />
        </>
      ) : null}
    </div>
  );
};

export const EntityInput = (props: FieldProps) => {
  const context = useNodeContext();
  const [query, setQuery] = useState("");
  const rawType = context.string(props.component, "entityType") as
    | EntityType
    | undefined;
  const type = rawType && ENTITY_TYPES.includes(rawType) ? rawType : undefined;
  const multiple = props.component.props.multiple === true;
  const raw = context.read(props.pointer);
  const values: JsonValue[] = Array.isArray(raw)
    ? raw
    : isObject(raw)
      ? [raw]
      : [];
  const chosen = values.map((value) => decodeEntityKey(value));
  const results = useLookup(query, (text) =>
    context.controller.lookupEntities(type, text),
  );
  return (
    <div className="flex flex-col gap-1.5">
      {chosen.map((entity, index) =>
        entity ? (
          <div
            key={`${entity.type}:${entity.id}`}
            className="flex items-center gap-2"
          >
            <EntityChip
              entity={entity}
              outside={context.isUntrustedAt(props.pointer)}
            />
            <SurfaceButton
              size="sm"
              variant="plain"
              disabled={props.disabled}
              onClick={() =>
                multiple
                  ? context.edit(
                      props.pointer,
                      values.filter((_, other) => other !== index),
                    )
                  : context.edit(props.pointer, null)
              }
            >
              {multiple ? "Remove" : "Clear"}
            </SurfaceButton>
          </div>
        ) : null,
      )}
      <input
        id={props.id}
        type="search"
        value={query}
        placeholder={
          props.placeholder ||
          (type ? `Search ${ENTITY_NOUNS[type].toLowerCase()}s` : "Search")
        }
        disabled={props.disabled}
        onChange={(event) => setQuery(event.target.value)}
        className={fieldClass}
        {...aria(props)}
      />
      <SuggestionList
        items={results}
        max={8}
        onPick={(item) => {
          const itemType = (
            item.type && ENTITY_TYPES.includes(item.type as EntityType)
              ? item.type
              : (type ?? "task")
          ) as EntityType;
          const value = { type: itemType, id: item.id, label: item.title };
          if (multiple) {
            if (!chosen.some((entity) => entity?.id === item.id)) {
              context.edit(props.pointer, [...values, value]);
            }
          } else {
            context.edit(props.pointer, value);
          }
          setQuery("");
        }}
      />
    </div>
  );
};

/** The bound array, rewritten in the new order; rows read `itemTitle`/`itemSubtitle` per item. */
export const ReorderInput = (props: FieldProps) => {
  const context = useNodeContext();
  const raw = context.read(props.pointer);
  const items: JsonValue[] = Array.isArray(raw) ? raw : [];
  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= items.length) {
      return;
    }
    const next = [...items];
    [next[index], next[target]] = [next[target]!, next[index]!];
    context.edit(props.pointer, next);
  };
  return (
    <ol className="flex flex-col gap-1" aria-labelledby={`${props.id}-label`}>
      {items.map((item, index) => {
        const itemScope = appendPointer(props.pointer, index);
        const title =
          context.textOf(props.component.props.itemTitle, itemScope, 200) ??
          cellText(item);
        const subtitle = context.textOf(
          props.component.props.itemSubtitle,
          itemScope,
          300,
        );
        return (
          <li
            key={index}
            className="flex items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5"
          >
            <span className="text-xs tabular-nums text-muted-foreground">
              {index + 1}.
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{title}</span>
              {subtitle ? (
                <span className="block truncate text-xs text-muted-foreground">
                  {subtitle}
                </span>
              ) : null}
            </span>
            <button
              type="button"
              aria-label={`Move ${title} up`}
              disabled={props.disabled || index === 0}
              onClick={() => move(index, -1)}
              className="rounded p-1 text-muted-foreground hover:bg-background disabled:opacity-30"
            >
              <Glyphs.up aria-hidden className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label={`Move ${title} down`}
              disabled={props.disabled || index === items.length - 1}
              onClick={() => move(index, 1)}
              className="rounded p-1 text-muted-foreground hover:bg-background disabled:opacity-30"
            >
              <Glyphs.down aria-hidden className="h-4 w-4" />
            </button>
          </li>
        );
      })}
    </ol>
  );
};

export const TimeSlotInput = (props: FieldProps) => {
  const context = useNodeContext();
  const zone = validZone(context.string(props.component, "timeZone"));
  const multiple = props.component.props.multiple === true;
  const slots = context
    .list(props.component, "slots", props.scope)
    .slice(0, 200)
    .flatMap((item, index) => {
      const start = isObject(item) ? parseDate(item.start) : undefined;
      if (!start || !isObject(item)) {
        return [];
      }
      return [
        {
          index,
          value: item,
          start,
          label: plainText(item.label, 40) ?? formatTime(start, zone),
        },
      ];
    });
  const raw = context.read(props.pointer);
  const chosen: JsonValue[] = Array.isArray(raw)
    ? raw
    : isObject(raw)
      ? [raw]
      : [];
  const startOf = (value: JsonValue) =>
    isObject(value) ? value.start : undefined;
  const days = new Map<string, typeof slots>();
  for (const slot of [...slots].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  )) {
    const key = dayKey(slot.start, zone);
    days.set(key, [...(days.get(key) ?? []), slot]);
  }
  if (slots.length === 0) {
    return <p className="text-xs text-muted-foreground">No times offered.</p>;
  }
  return (
    <div className="flex flex-col gap-2.5">
      {[...days.entries()].map(([key, daySlots]) => (
        <div key={key} className="flex flex-col gap-1">
          <p className="text-xs font-semibold text-muted-foreground">
            {formatDay(daySlots[0]!.start, zone)}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {daySlots.map((slot) => {
              const on = chosen.some((value) =>
                jsonEqual(startOf(value), slot.value.start),
              );
              return (
                <button
                  key={slot.index}
                  type="button"
                  role={multiple ? "checkbox" : "radio"}
                  aria-checked={on}
                  aria-label={`${formatDay(slot.start, zone)} ${formatTime(slot.start, zone)}`}
                  disabled={props.disabled}
                  onClick={() => {
                    if (multiple) {
                      context.edit(
                        props.pointer,
                        on
                          ? chosen.filter(
                              (value) =>
                                !jsonEqual(startOf(value), slot.value.start),
                            )
                          : [...chosen, slot.value],
                      );
                    } else {
                      context.edit(props.pointer, slot.value);
                    }
                  }}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs tabular-nums disabled:opacity-60",
                    on
                      ? "border-primary bg-primary/15"
                      : "border-border bg-background hover:bg-muted",
                  )}
                >
                  {slot.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {zone ? (
        <span className="text-2xs text-muted-foreground">
          Times in {zone.replace(/_/gu, " ")}
        </span>
      ) : null}
    </div>
  );
};

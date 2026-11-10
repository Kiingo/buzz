// Generated from the Kiingo surface renderer packages at 1055d96f74fb6ac27bf0ebcd3c7fa12aee50be9c; do not edit here.
import { useMemo, useState } from "react";
import {
  appendPointer,
  asInt,
  asNumber,
  bindingOf,
  cellText,
  childKey,
  decodeEntityKey,
  formatCurrency,
  formatDateText,
  formatNumber,
  isObject,
  openableUrl,
  plainText,
  readAt,
  urlHost,
  type JsonValue,
  type Pointer,
} from "../core";
import { cn } from "./cn";
import { useNodeContext, type NodeProps } from "./context";
import { BadgeLabel, EntityChip } from "./display";
import { InlineMarkdown } from "./markdown";
import { catalogIcon, Glyphs } from "./icons";
import { ProxyImage } from "./media";
import { fieldClass, QuotedText, TooLargeRow } from "./ui";

// §4.2 Table and List: data-heavy display.

type ChoiceOption = { value: string; label: string };

type Column = {
  index: number;
  key: string;
  title: string;
  type: string;
  trailing: boolean;
  editable: boolean;
  currency?: string;
  width?: string;
  options: ChoiceOption[];
};

const optionsOf = (raw: JsonValue | undefined): ChoiceOption[] =>
  Array.isArray(raw)
    ? raw.flatMap((item) =>
        isObject(item) && typeof item.value === "string"
          ? [
              {
                value: item.value,
                label: plainText(item.label, 100) ?? item.value,
              },
            ]
          : [],
      )
    : [];

// Every column the agent sent (no column cap; the row scrolls sideways).
const columnsOf = (raw: JsonValue[]): Column[] =>
  raw.flatMap((item, index) => {
    if (!isObject(item) || typeof item.key !== "string") {
      return [];
    }
    const type = typeof item.type === "string" ? item.type : "text";
    const align = typeof item.align === "string" ? item.align : undefined;
    return [
      {
        index,
        key: item.key,
        title: plainText(item.title, 60) ?? item.key,
        type,
        trailing:
          align === "end" ||
          align === "right" ||
          (align === undefined && (type === "number" || type === "currency")),
        editable: item.editable === true,
        ...(typeof item.currency === "string"
          ? { currency: item.currency }
          : {}),
        ...(typeof item.width === "string" ? { width: item.width } : {}),
        options: optionsOf(item.options),
      },
    ];
  });

const fieldOf = (row: JsonValue, key: string): JsonValue | undefined =>
  isObject(row) ? row[key] : undefined;

/** A choice cell shows its option's label; a checkbox Yes or No. */
const shownText = (column: Column, value: JsonValue | undefined): string => {
  if (column.type === "checkbox") {
    return value === true ? "Yes" : value === false ? "No" : "";
  }
  if (column.type === "choice") {
    const option = column.options.find((item) => item.value === value);
    if (option) {
      return option.label;
    }
  }
  return cellText(value);
};

const compare = (
  a: JsonValue | undefined,
  b: JsonValue | undefined,
): number => {
  const x = asNumber(a);
  const y = asNumber(b);
  if (x !== undefined && y !== undefined) {
    return x - y;
  }
  if (typeof a === "boolean" || typeof b === "boolean") {
    return Number(a === true) - Number(b === true);
  }
  return cellText(a).localeCompare(cellText(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
};

/** The cells an added row starts with: empty text, unchecked, else null; then `newRow`. */
const blankRow = (
  columns: Column[],
  newRow: JsonValue | undefined,
): Record<string, JsonValue> => {
  const row: Record<string, JsonValue> = {};
  for (const column of columns) {
    row[column.key] =
      column.type === "checkbox"
        ? false
        : column.type === "text" ||
            column.type === "badge" ||
            column.type === "link"
          ? ""
          : null;
  }
  if (isObject(newRow)) {
    for (const [key, value] of Object.entries(newRow)) {
      if (value !== undefined) {
        row[key] = value;
      }
    }
  }
  return row;
};

export const TableView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const [sortKey, setSortKey] = useState<string | undefined>(undefined);
  const [ascending, setAscending] = useState(true);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const columns = columnsOf(context.list(component, "columns", scope));
  const rowsPointer = bindingOf(component.props.rows, scope);
  // Every row, not the first MAX_REPEATS: one page is drawn at a time, so a
  // long table stays whole and reachable (no row cap).
  const rawRows = context.value(component, "rows", scope);
  const all = useMemo(() => (Array.isArray(rawRows) ? rawRows : []), [rawRows]);
  const sortable = context.flag(component, "sortable", scope);
  const filterable = context.flag(component, "filterable", scope);
  const canChangeRows = Boolean(rowsPointer) && context.acceptsEdits;
  const addRows = context.flag(component, "addRows", scope) && canChangeRows;
  const removeRows =
    context.flag(component, "removeRows", scope) && canChangeRows;
  // Rows drawn per page; the catalog allows 5 to 100, 50 when unset.
  const pageSize = Math.max(
    1,
    Math.min(
      200,
      Math.round(context.number(component, "pageSize", scope) ?? 50),
    ),
  );
  const selectable = context.string(component, "selectable") ?? "none";
  const selectionPointer = bindingOf(component.props.selection, scope);
  const selectedList = (() => {
    const value = selectionPointer ? context.read(selectionPointer) : undefined;
    return Array.isArray(value)
      ? value
          .map((item) => asInt(item))
          .filter((item): item is number => item !== undefined)
      : [];
  })();
  const selected = new Set(selectedList);
  const shown = useMemo(() => {
    let out = all.map((value, index) => ({ index, value }));
    const needle = filter.trim().toLowerCase();
    if (needle) {
      out = out.filter((row) =>
        columns.some((column) =>
          shownText(column, fieldOf(row.value, column.key))
            .toLowerCase()
            .includes(needle),
        ),
      );
    }
    if (sortKey) {
      out = [...out].sort((a, b) => {
        const order = compare(
          fieldOf(a.value, sortKey),
          fieldOf(b.value, sortKey),
        );
        return ascending ? order : -order;
      });
    }
    return out;
  }, [all, columns, filter, sortKey, ascending]);
  const pageCount = Math.max(1, Math.ceil(shown.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  const first = current * pageSize;
  const pageRows = shown.slice(first, first + pageSize);
  // Rows drawn within the surface's shared cell budget (79 W6 SHOULD 5).
  const drawn = context.claimCells(
    `table:${childKey(component.id, scope)}`,
    pageRows.length,
    columns.length + (selectable !== "none" ? 1 : 0) + (removeRows ? 1 : 0),
  );
  const empty = context.text(component, "emptyText", scope, 200);
  const canSelect = Boolean(selectionPointer) && context.acceptsEdits;
  const toggle = (index: number) => {
    if (!selectionPointer) {
      return;
    }
    const next = selectable === "multi" ? [...selected] : [];
    if (selected.has(index)) {
      context.edit(
        selectionPointer,
        next.filter((item) => item !== index),
      );
    } else {
      context.edit(selectionPointer, [...next, index]);
    }
  };
  const addRow = () => {
    if (!rowsPointer) {
      return;
    }
    const row = blankRow(columns, component.props.newRow as JsonValue);
    if (Array.isArray(rawRows)) {
      context.edit(appendPointer(rowsPointer, all.length), row);
    } else {
      context.edit(rowsPointer, [row]);
    }
    // Show the new row: no filter hides it, and an unsorted table turns to
    // the last page, where it is.
    setFilter("");
    if (!sortKey) {
      setPage(Math.floor(all.length / pageSize));
    }
  };
  const removeRow = (index: number) => {
    if (!rowsPointer) {
      return;
    }
    context.edit(appendPointer(rowsPointer, index), undefined);
    // Selection holds row indexes: the removed row goes, later rows move up.
    if (selectionPointer && selectedList.length > 0) {
      const next = selectedList
        .filter((item) => item !== index)
        .map((item) => (item > index ? item - 1 : item));
      if (
        next.length !== selectedList.length ||
        next.some((item, position) => item !== selectedList[position])
      ) {
        context.edit(selectionPointer, next);
      }
    }
  };
  const cell = (column: Column, row: JsonValue, index: number) => {
    const value = fieldOf(row, column.key);
    // Outside content in a cell is a quote: never a link, chip or control
    // (79 W6).
    if (
      rowsPointer &&
      context.isUntrustedAt(
        appendPointer(appendPointer(rowsPointer, index), column.key),
      )
    ) {
      return <QuotedText text={shownText(column, value)} />;
    }
    if (column.editable && rowsPointer && context.acceptsEdits) {
      const pointer = appendPointer(
        appendPointer(rowsPointer, index),
        column.key,
      );
      return <EditableCell column={column} pointer={pointer} row={index + 1} />;
    }
    switch (column.type) {
      case "number": {
        const number = asNumber(value);
        return (
          <span className="tabular-nums">
            {number !== undefined ? formatNumber(number) : cellText(value)}
          </span>
        );
      }
      case "currency": {
        const number = asNumber(value);
        return (
          <span className="tabular-nums">
            {number !== undefined
              ? formatCurrency(number, column.currency ?? "USD")
              : cellText(value)}
          </span>
        );
      }
      case "date":
        return <span>{formatDateText(value) ?? ""}</span>;
      case "badge": {
        const text = plainText(value, 40);
        return text ? <BadgeLabel text={text} /> : null;
      }
      case "checkbox":
        return value === true ? (
          <>
            <Glyphs.checkboxOn aria-hidden className="inline h-4 w-4" />
            <span className="sr-only">Yes</span>
          </>
        ) : value === false ? (
          <span className="sr-only">No</span>
        ) : null;
      case "choice":
        return <span>{shownText(column, value)}</span>;
      case "link": {
        const link = openableUrl(isObject(value) ? value.url : value);
        if (!link) {
          return <span>{cellText(value)}</span>;
        }
        return (
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => context.openLink(link)}
          >
            {plainText(isObject(value) ? value.title : undefined, 120) ??
              urlHost(link)}
          </button>
        );
      }
      case "entity": {
        const entity = decodeEntityKey(value);
        return entity ? (
          <EntityChip entity={entity} />
        ) : (
          <span>{cellText(value)}</span>
        );
      }
      default:
        // A text cell is inline Markdown (catalog `inlineMarkdown`).
        return (
          <span className="line-clamp-3 whitespace-pre-wrap break-words">
            <InlineMarkdown text={cellText(value)} onLink={context.openLink} />
          </span>
        );
    }
  };
  return (
    <div className="flex flex-col gap-2">
      {all.length === 0 && empty ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : null}
      {filterable ? (
        <input
          type="search"
          value={filter}
          placeholder="Filter"
          aria-label="Filter rows"
          onChange={(event) => {
            setFilter(event.target.value);
            setPage(0);
          }}
          className={cn(fieldClass, "h-8 py-1 text-xs")}
        />
      ) : null}
      {all.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/50">
              <tr>
                {selectable !== "none" ? (
                  <th scope="col" className="w-8 px-2 py-1.5">
                    <span className="sr-only">Selected</span>
                  </th>
                ) : null}
                {columns.map((column) => (
                  <th
                    key={column.index}
                    scope="col"
                    aria-sort={
                      sortKey === column.key
                        ? ascending
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                    className={cn(
                      "whitespace-nowrap px-3 py-1.5 text-xs font-semibold text-muted-foreground",
                      column.trailing ? "text-right" : "text-left",
                      column.width === "narrow" && "w-20",
                      column.width === "wide" && "min-w-[16rem]",
                    )}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-0.5 hover:text-foreground"
                        onClick={() => {
                          if (sortKey === column.key) {
                            setAscending(!ascending);
                          } else {
                            setSortKey(column.key);
                            setAscending(true);
                          }
                        }}
                      >
                        {column.title}
                        {sortKey === column.key ? (
                          ascending ? (
                            <Glyphs.up aria-hidden className="h-3 w-3" />
                          ) : (
                            <Glyphs.down aria-hidden className="h-3 w-3" />
                          )
                        ) : null}
                      </button>
                    ) : (
                      column.title
                    )}
                  </th>
                ))}
                {removeRows ? (
                  <th scope="col" className="w-8 px-2 py-1.5">
                    <span className="sr-only">Remove</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {pageRows.slice(0, drawn).map((row) => {
                const isSelected = selected.has(row.index);
                return (
                  <tr
                    key={row.index}
                    className={cn(
                      "border-t border-border",
                      isSelected && "bg-primary/5",
                    )}
                  >
                    {selectable !== "none" ? (
                      <td className="px-2 py-1.5 align-top">
                        <input
                          type={selectable === "multi" ? "checkbox" : "radio"}
                          checked={isSelected}
                          disabled={!canSelect}
                          aria-label={`Select row ${row.index + 1}`}
                          onChange={() => toggle(row.index)}
                          className="h-4 w-4 accent-primary"
                        />
                      </td>
                    ) : null}
                    {columns.map((column) => (
                      <td
                        key={column.index}
                        className={cn(
                          "px-3 py-1.5 align-top",
                          column.trailing ? "text-right" : "text-left",
                        )}
                      >
                        {cell(column, row.value, row.index)}
                      </td>
                    ))}
                    {removeRows ? (
                      <td className="px-2 py-1.5 align-top">
                        <button
                          type="button"
                          aria-label={`Remove row ${row.index + 1}`}
                          title="Remove row"
                          onClick={() => removeRow(row.index)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <TrashGlyph aria-hidden className="h-4 w-4" />
                        </button>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {drawn < pageRows.length ? <TooLargeRow /> : null}
      {pageCount > 1 || addRows ? (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {addRows ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-primary hover:underline"
              onClick={addRow}
            >
              <AddGlyph aria-hidden className="h-3.5 w-3.5" />
              Add row
            </button>
          ) : null}
          {pageCount > 1 ? (
            <nav
              aria-label="Table pages"
              className="ml-auto inline-flex items-center gap-2 text-muted-foreground"
            >
              <span aria-live="polite">
                Rows {formatNumber(first + 1)}–
                {formatNumber(first + pageRows.length)} of{" "}
                {formatNumber(shown.length)}
              </span>
              <button
                type="button"
                disabled={current === 0}
                onClick={() => setPage(current - 1)}
                className="text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={current >= pageCount - 1}
                onClick={() => setPage(current + 1)}
                className="text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
              >
                Next
              </button>
            </nav>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const TrashGlyph = catalogIcon("trash");
const AddGlyph = catalogIcon("add");

const EditableCell = ({
  column,
  pointer,
  row,
}: {
  column: Column;
  pointer: Pointer;
  row: number;
}) => {
  const context = useNodeContext();
  const value = context.read(pointer);
  const numeric = column.type === "number" || column.type === "currency";
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const label = `${column.title}, row ${row}`;
  if (column.type === "checkbox") {
    return (
      <input
        type="checkbox"
        aria-label={label}
        checked={value === true}
        onChange={(event) => context.edit(pointer, event.target.checked)}
        className="h-4 w-4 accent-primary"
      />
    );
  }
  if (column.type === "choice") {
    const known = column.options.some((option) => option.value === value);
    return (
      <select
        aria-label={label}
        value={typeof value === "string" && known ? value : ""}
        onChange={(event) =>
          context.edit(
            pointer,
            event.target.value === "" ? null : event.target.value,
          )
        }
        className={cn(fieldClass, "h-8 min-w-[6rem] py-1 text-xs")}
      >
        <option value="">
          {known || value == null ? "—" : cellText(value)}
        </option>
        {column.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (column.type === "date") {
    // Stored as YYYY-MM-DD, as the catalog says; cleared is null.
    const text =
      typeof value === "string" && /^\d{4}-\d{2}-\d{2}/u.test(value)
        ? value.slice(0, 10)
        : "";
    return (
      <input
        type="date"
        aria-label={label}
        value={text}
        onChange={(event) =>
          context.edit(
            pointer,
            event.target.value === "" ? null : event.target.value,
          )
        }
        className={cn(fieldClass, "h-8 min-w-[8rem] py-1 text-xs")}
      />
    );
  }
  const shown =
    draft ?? (value === undefined || value === null ? "" : cellText(value));
  return (
    <input
      type={numeric ? "number" : "text"}
      inputMode={numeric ? "decimal" : undefined}
      aria-label={label}
      value={shown}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        if (numeric) {
          const number = text.trim() === "" ? undefined : Number(text);
          if (number === undefined || Number.isFinite(number)) {
            context.edit(pointer, number ?? null);
          }
        } else {
          context.edit(pointer, text);
        }
      }}
      onBlur={() => setDraft(undefined)}
      className={cn(
        fieldClass,
        "h-8 min-w-[5rem] py-1 text-xs",
        numeric && "text-right",
      )}
    />
  );
};

/**
 * `items: {path}`; title, subtitle, trailing and badge are read per item
 * (usually item-relative, `./title`). A tap writes the row index to
 * `selection`, then runs `onTap`.
 */
export const ListView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const pointer = bindingOf(component.props.items, scope);
  const items = pointer ? readAt(context.data, pointer) : undefined;
  // Rows drawn within the surface's shared cell budget (79 W6 SHOULD 5).
  const wanted = Array.isArray(items) ? Math.min(items.length, 500) : 0;
  const count = context.claimCells(
    `list:${childKey(component.id, scope)}`,
    wanted,
  );
  const empty = context.text(component, "emptyText", scope, 200);
  const action = context.action(component.props.onTap);
  // A row shows no words to send, so its tap never sends (79 M1/W1).
  const tappable = action !== undefined && context.canTapSilently(action);
  const selectionPointer = bindingOf(component.props.selection, scope);
  const selected = selectionPointer
    ? asInt(context.read(selectionPointer))
    : undefined;
  const leading = component.props.leading;
  const badge = component.props.badge;
  if (!pointer) {
    return empty ? (
      <p className="text-xs text-muted-foreground">{empty}</p>
    ) : null;
  }
  return (
    <div>
      {wanted === 0 && empty ? (
        <p className="py-1.5 text-xs text-muted-foreground">{empty}</p>
      ) : null}
      <ul className="divide-y divide-border">
        {Array.from({ length: count }, (_, index) => {
          const itemScope = appendPointer(pointer, index);
          const title =
            context.textOf(component.props.title, itemScope, 200) ?? "";
          const subtitle = context.textOf(
            component.props.subtitle,
            itemScope,
            300,
          );
          const trailing = context.textOf(
            component.props.trailing,
            itemScope,
            60,
          );
          const badgeText = isObject(badge)
            ? context.textOf(badge.text, itemScope, 40)
            : undefined;
          // An item that reads outside content is a quote and never an
          // action (79 W6).
          const outside =
            context.isUntrustedAt(itemScope) ||
            [
              component.props.title,
              component.props.subtitle,
              component.props.trailing,
              isObject(badge) ? badge.text : undefined,
            ].some((prop) => context.isUntrustedValue(prop, itemScope));
          if (outside) {
            return (
              <li key={index} className="py-2">
                <QuotedText
                  text={[title, subtitle, trailing, badgeText]
                    .filter(Boolean)
                    .join(" · ")}
                />
              </li>
            );
          }
          const content = (
            <span className="flex w-full items-center gap-2.5 py-2">
              {isObject(leading) ? (
                <Leading leading={leading} scope={itemScope} />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{title}</span>
                {subtitle ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {/* Inline Markdown; a tappable row's links are words
                        (no button inside its button). */}
                    <InlineMarkdown
                      text={subtitle}
                      onLink={context.openLink}
                      links={!(tappable && action)}
                    />
                  </span>
                ) : null}
              </span>
              {badgeText ? (
                <BadgeLabel
                  text={badgeText}
                  tone={
                    isObject(badge) && typeof badge.tone === "string"
                      ? badge.tone
                      : undefined
                  }
                />
              ) : null}
              {trailing ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {trailing}
                </span>
              ) : null}
            </span>
          );
          return (
            <li
              key={index}
              aria-current={selected === index ? "true" : undefined}
            >
              {tappable && action ? (
                <button
                  type="button"
                  disabled={context.busy}
                  onClick={() => {
                    if (selectionPointer && context.acceptsEdits) {
                      context.edit(selectionPointer, index);
                    }
                    context.perform(action.id, itemScope);
                  }}
                  className={cn(
                    "w-full text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected === index && "bg-primary/5",
                  )}
                >
                  {content}
                </button>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ul>
      {count < wanted ? <TooLargeRow /> : null}
    </div>
  );
};

export const Leading = ({
  leading,
  scope,
}: {
  leading: Record<string, JsonValue>;
  scope: Pointer;
}) => {
  const context = useNodeContext();
  const image = context.textOf(leading.imageUrl, scope, 2048);
  if (image) {
    return (
      <span className="h-7 w-7 shrink-0 overflow-hidden rounded-full">
        <ProxyImage
          url={image}
          alt=""
          fit="cover"
          aspect={1}
          rounded="rounded-full"
          className="h-7"
        />
      </span>
    );
  }
  const initials = context.textOf(leading.initials, scope, 3);
  if (initials) {
    return (
      <span
        aria-hidden
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-semibold"
      >
        {initials}
      </span>
    );
  }
  if (typeof leading.icon === "string") {
    const Icon = catalogIcon(leading.icon);
    return (
      <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
    );
  }
  return null;
};

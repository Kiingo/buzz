// Generated from the Kiingo surface renderer packages at 0d7eecf6d3b78f4c52514554faa33adb7a1fe131; do not edit here.
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
import { catalogIcon, Glyphs } from "./icons";
import { ProxyImage } from "./media";
import { fieldClass, QuotedText, TooLargeRow } from "./ui";

// §4.2 Table and List: data-heavy display.

type Column = {
  index: number;
  key: string;
  title: string;
  type: string;
  trailing: boolean;
  editable: boolean;
  currency?: string;
  width?: string;
};

const columnsOf = (raw: JsonValue[]): Column[] =>
  raw.slice(0, 12).flatMap((item, index) => {
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
      },
    ];
  });

const fieldOf = (row: JsonValue, key: string): JsonValue | undefined =>
  isObject(row) ? row[key] : undefined;

const compare = (
  a: JsonValue | undefined,
  b: JsonValue | undefined,
): number => {
  const x = asNumber(a);
  const y = asNumber(b);
  if (x !== undefined && y !== undefined) {
    return x - y;
  }
  return cellText(a).localeCompare(cellText(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
};

export const TableView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const [sortKey, setSortKey] = useState<string | undefined>(undefined);
  const [ascending, setAscending] = useState(true);
  const [filter, setFilter] = useState("");
  const [pages, setPages] = useState(1);
  const columns = columnsOf(context.list(component, "columns", scope));
  const rowsPointer = bindingOf(component.props.rows, scope);
  const all = context.list(component, "rows", scope);
  const sortable = context.flag(component, "sortable", scope);
  const filterable = context.flag(component, "filterable", scope);
  const pageSize = Math.max(
    1,
    Math.min(
      200,
      Math.round(context.number(component, "pageSize", scope) ?? 50),
    ),
  );
  const selectable = context.string(component, "selectable") ?? "none";
  const selectionPointer = bindingOf(component.props.selection, scope);
  const selected = new Set(
    (() => {
      const value = selectionPointer
        ? context.read(selectionPointer)
        : undefined;
      return Array.isArray(value)
        ? value
            .map((item) => asInt(item))
            .filter((item): item is number => item !== undefined)
        : [];
    })(),
  );
  const shown = useMemo(() => {
    let out = all.map((value, index) => ({ index, value }));
    const needle = filter.trim().toLowerCase();
    if (needle) {
      out = out.filter((row) =>
        columns.some((column) =>
          cellText(fieldOf(row.value, column.key))
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
  const limit = pageSize * pages;
  // Rows drawn within the surface's shared cell budget (79 W6 SHOULD 5).
  const wanted = Math.min(shown.length, limit);
  const drawn = context.claimCells(
    `table:${childKey(component.id, scope)}`,
    wanted,
    columns.length + (selectable !== "none" ? 1 : 0),
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
      return <QuotedText text={cellText(value)} />;
    }
    if (column.editable && rowsPointer && context.acceptsEdits) {
      const pointer = appendPointer(
        appendPointer(rowsPointer, index),
        column.key,
      );
      return <EditableCell column={column} pointer={pointer} />;
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
        return (
          <span className="line-clamp-3 whitespace-pre-wrap break-words">
            {cellText(value)}
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
            setPages(1);
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
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, drawn).map((row) => {
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {drawn < wanted ? (
        <TooLargeRow />
      ) : shown.length > limit ? (
        <button
          type="button"
          className="self-start text-xs text-primary hover:underline"
          onClick={() => setPages(pages + 1)}
        >
          Show {Math.min(pageSize, shown.length - limit)} more
        </button>
      ) : null}
    </div>
  );
};

const EditableCell = ({
  column,
  pointer,
}: {
  column: Column;
  pointer: Pointer;
}) => {
  const context = useNodeContext();
  const value = context.read(pointer);
  const numeric = column.type === "number" || column.type === "currency";
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const shown =
    draft ?? (value === undefined || value === null ? "" : cellText(value));
  return (
    <input
      type={numeric ? "number" : "text"}
      inputMode={numeric ? "decimal" : undefined}
      aria-label={column.title}
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
                    {subtitle}
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

const Leading = ({
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

// Generated from the Kiingo surface renderer packages at 8a4382a01c1d2046b63e7c78a1220c2c33e419a3; do not edit here.
import { useEffect, useState, type ReactNode } from "react";
import {
  asNumber,
  ENTITY_TYPES,
  formatBytes,
  isObject,
  plainId,
  plainText,
  textFileDigest,
  textFileRef,
  type EntityKey,
  type EntityType,
  type JsonValue,
} from "../core";
import { cn } from "./cn";
import { useNodeContext, type NodeProps } from "./context";
import { ENTITY_ICONS, ENTITY_NOUNS, Glyphs } from "./icons";
import { TextFileRow } from "./text-file";
import { FileCarousel, surfaceFileRefOf } from "./file-carousel";
import { QuotedText } from "./ui";
import type { SurfaceFileRef } from "./host";

// §4.2 Display, continued from display.tsx: Kiingo object chips
// (EntityRef), file rows and FileList. Titles and names are plain text;
// outside content is a quote, never a button or a lookup.

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
  wrapName = false,
  set,
}: {
  item: JsonValue;
  outside?: boolean;
  /**
   * The list this row is in, for the host's viewer to page through: the
   * openable refs and this row's place among them.
   */
  set?: { files: SurfaceFileRef[]; index: number };
  /**
   * The whole name, wrapped, not one line. An email card's attachments use
   * it, as a cut can hide a file's real extension (79
   * LOW-79-EMAILCARD-LONG-NAME).
   */
  wrapName?: boolean;
}) => {
  const context = useNodeContext();
  const host = context.host;
  const record = isObject(item) ? item : {};
  // 300 is the longest name a file ref holds (ZUiFileRef): whole, its end shows.
  const name = plainText(record.name, wrapName ? 300 : 200) ?? "File";
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
        <span
          className={cn("block text-sm", wrapName ? "break-words" : "truncate")}
        >
          {name}
        </span>
        {detail ? (
          <span className="block text-xs text-muted-foreground">{detail}</span>
        ) : null}
      </span>
    </span>
  );
  // A text or Markdown file opens in the text viewer, read with the
  // viewer's own session (`text-file.tsx`), when the host can read it. A
  // card body the card pins by sha256 (`bodyFile`) always does, so its
  // digest is checked; any other file opens in the host's viewer.
  const textFile = textFileRef(item);
  const pinnedBody =
    textFile !== undefined &&
    textFileDigest(context.data, textFile.fileId) !== undefined;
  if (textFile && host.readTextFile && (pinnedBody || !host.openFile)) {
    return <TextFileRow file={textFile}>{content}</TextFileRow>;
  }
  const ref = surfaceFileRefOf(item);
  if (ref && host.openFile) {
    const openSet = set ?? { files: [ref], index: 0 };
    const surface = context.surface;
    return (
      <button
        type="button"
        onClick={() =>
          host.openFile?.({
            files: openSet.files,
            index: openSet.index,
            surfaceId: surface.id,
            ...(surface.agentId ? { agentId: surface.agentId } : {}),
          })
        }
        className="min-w-0 text-left hover:opacity-80"
        aria-label={`Open ${name}`}
      >
        {content}
      </button>
    );
  }
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
  // The rows the viewer can page through, in list order.
  const refs = files.map((item) => surfaceFileRefOf(item));
  const openable = refs.filter((ref): ref is SurfaceFileRef => !!ref);
  // File cards in a paged row; outside content stays quoted rows.
  if (context.string(component, "layout") === "carousel" && !outside) {
    return files.length === 0 ? (
      empty ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : null
    ) : (
      <FileCarousel files={files} />
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {files.length === 0 && empty ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : null}
      {files.map((item, index) => {
        const ref = refs[index];
        return (
          <FileRow
            key={index}
            item={item}
            outside={outside}
            {...(ref
              ? { set: { files: openable, index: openable.indexOf(ref) } }
              : {})}
          />
        );
      })}
    </div>
  );
};

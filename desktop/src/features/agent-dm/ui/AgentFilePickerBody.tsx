import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import {
  agentRefsErrorSentence,
  listSessionFiles,
  type SessionFileRow,
} from "../lib/agentRefs";

/** A pause in typing before the search goes out. */
const SEARCH_DELAY_MS = 200;

type Listing = {
  rows: SessionFileRow[];
  nextCursor: string | null;
};

const baseName = (path: string) =>
  path.split("/").filter(Boolean).at(-1) ?? path;
const parentOf = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : null;
};

/**
 * "/file" (BZ-FILES): the names in the reader's own session's project
 * folder, from the host, the same list the apps' "@" picker shows. A folder
 * opens; a file is picked. Typing searches the whole folder. Names only:
 * nothing here opens or reads a file.
 */
export function AgentFilePickerBody({
  agentPubkey,
  onPick,
}: {
  agentPubkey: string;
  onPick: (path: string) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [dir, setDir] = React.useState<string | null>(null);
  const [listing, setListing] = React.useState<Listing | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [active, setActive] = React.useState(0);
  const [attempt, setAttempt] = React.useState(0);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const generation = React.useRef(0);

  const searching = query.trim().length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is Try again, which reads the same folder anew
  React.useEffect(() => {
    const owner = ++generation.current;
    setListing(null);
    setNote(null);
    setFailed(null);
    setActive(0);
    const timer = window.setTimeout(
      () => {
        listSessionFiles(agentPubkey, searching ? { query } : { dir }).then(
          (page) => {
            // Only the newest read may show its answer.
            if (owner !== generation.current) return;
            if (page.state === "unavailable") {
              setNote(page.note);
              return;
            }
            setListing({ rows: page.entries, nextCursor: page.nextCursor });
          },
          (error: unknown) => {
            if (owner !== generation.current) return;
            setFailed(agentRefsErrorSentence(error));
          },
        );
      },
      searching ? SEARCH_DELAY_MS : 0,
    );
    return () => window.clearTimeout(timer);
  }, [agentPubkey, attempt, dir, query, searching]);

  const loadMore = () => {
    const cursor = listing?.nextCursor;
    if (!cursor || loadingMore) return;
    const owner = generation.current;
    setLoadingMore(true);
    listSessionFiles(
      agentPubkey,
      searching ? { query, cursor } : { dir, cursor },
    )
      .then(
        (page) => {
          if (owner !== generation.current) return;
          if (page.state === "unavailable") {
            setNote(page.note);
            return;
          }
          setListing((current) => ({
            rows: [...(current?.rows ?? []), ...page.entries],
            nextCursor: page.nextCursor,
          }));
        },
        (error: unknown) => {
          // What showed stays; the person may ask again.
          if (owner === generation.current) {
            setFailed(agentRefsErrorSentence(error));
          }
        },
      )
      .finally(() => {
        if (owner === generation.current) setLoadingMore(false);
      });
  };

  const choose = (row: SessionFileRow) => {
    if (row.kind === "directory") {
      setQuery("");
      setDir(row.path);
      return;
    }
    onPick(row.path);
  };
  const rows = listing?.rows ?? [];

  return (
    <>
      <Input
        aria-label="Search this session's files"
        autoFocus
        data-testid="agent-file-picker-search"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (rows.length === 0) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive(
              (current) => (current + step + rows.length) % rows.length,
            );
          } else if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            event.preventDefault();
            const row = rows[active];
            if (row) choose(row);
          }
        }}
        placeholder="Search files"
        value={query}
      />
      {!searching && dir ? (
        <div className="flex items-center gap-2 text-sm">
          <Button
            onClick={() => setDir(parentOf(dir))}
            size="xs"
            type="button"
            variant="outline"
          >
            Up
          </Button>
          <span className="min-w-0 truncate text-muted-foreground">{dir}</span>
        </div>
      ) : null}
      {failed ? (
        <div className="flex items-center gap-2 text-sm" role="alert">
          <span>{failed}</span>
          <Button
            onClick={() => setAttempt((current) => current + 1)}
            size="xs"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </div>
      ) : null}
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      {!listing && !failed && !note ? (
        <p aria-live="polite" className="text-sm text-muted-foreground">
          Loading…
        </p>
      ) : null}
      {listing && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {searching ? "No files match." : "This folder is empty."}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ul aria-label="Files" className="flex flex-col gap-0.5">
          {rows.map((row, index) => (
            <li key={row.path}>
              <button
                aria-current={index === active ? "true" : undefined}
                className={cn(
                  "w-full rounded-md px-2 py-1 text-left text-sm hover:bg-accent",
                  "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
                  index === active && "bg-accent",
                )}
                data-testid="agent-file-picker-row"
                onClick={() => choose(row)}
                onMouseEnter={() => setActive(index)}
                type="button"
              >
                <span className="block truncate">
                  {baseName(row.path)}
                  {row.kind === "directory" ? "/" : ""}
                </span>
                {searching && parentOf(row.path) ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {parentOf(row.path)}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {listing?.nextCursor ? (
        <Button
          disabled={loadingMore}
          onClick={loadMore}
          size="xs"
          type="button"
          variant="outline"
        >
          {loadingMore ? "Loading…" : "More"}
        </Button>
      ) : null}
    </>
  );
}

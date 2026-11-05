import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";

import {
  type AgentRef,
  type AgentRefPickerRequest,
  agentRefsErrorSentence,
  getAgentRefsVersion,
  searchAgentRefs,
  subscribeAgentRefs,
  takeAgentRefPickerRequest,
} from "../lib/agentRefs";

/** A pause in typing before the search goes out. */
const SEARCH_DELAY_MS = 200;

/**
 * The search a "/task" or "/project" pick opens (BUZZPARITY B5): what the
 * reader can read, from the host, as they type. A pick puts its label in
 * the draft; the send carries the reference.
 */
export function AgentRefPicker({ agentPubkey }: { agentPubkey: string }) {
  React.useSyncExternalStore(
    subscribeAgentRefs,
    getAgentRefsVersion,
    getAgentRefsVersion,
  );
  const [asked, setAsked] = React.useState<AgentRefPickerRequest | null>(null);
  const [query, setQuery] = React.useState("");
  const [rows, setRows] = React.useState<AgentRef[] | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [active, setActive] = React.useState(0);
  const generation = React.useRef(0);

  React.useEffect(() => {
    const next = takeAgentRefPickerRequest(agentPubkey);
    if (next) {
      setAsked(next);
      setQuery("");
      setRows(null);
      setFailed(null);
      setActive(0);
    }
  });

  const type = asked?.type ?? null;
  // Each open (and Try again, a fresh `asked`) searches anew.
  React.useEffect(() => {
    if (!asked) return;
    const owner = ++generation.current;
    const timer = window.setTimeout(() => {
      searchAgentRefs(agentPubkey, asked.type, query).then(
        (found) => {
          // Only the newest search may show its answer.
          if (owner !== generation.current) return;
          setRows(found);
          setFailed(null);
          setActive(0);
        },
        (error: unknown) => {
          if (owner !== generation.current) return;
          setFailed(agentRefsErrorSentence(error));
        },
      );
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [agentPubkey, asked, query]);

  const close = () => {
    generation.current += 1;
    setAsked(null);
  };
  const pick = (ref: AgentRef) => {
    const request = asked;
    close();
    request?.onPick(ref);
  };
  const noun = type === "project" ? "project" : "task";

  return (
    <Dialog onOpenChange={(open) => (open ? null : close())} open={!!asked}>
      <DialogContent
        className="max-h-[80vh] max-w-lg overflow-y-auto"
        data-testid="agent-ref-picker"
      >
        <DialogHeader>
          <DialogTitle>Reference a {noun}</DialogTitle>
          <DialogDescription>
            Only what you can read. The agent gets its title with your message.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label={`Search your ${noun}s`}
          autoFocus
          data-testid="agent-ref-picker-search"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (!rows || rows.length === 0) return;
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
              if (row) pick(row);
            }
          }}
          placeholder={`Search ${noun}s`}
          value={query}
        />
        {failed ? (
          <div className="flex items-center gap-2 text-sm" role="alert">
            <span>{failed}</span>
            <Button
              onClick={() => {
                setFailed(null);
                setAsked((current) => (current ? { ...current } : current));
              }}
              size="xs"
              type="button"
              variant="outline"
            >
              Try again
            </Button>
          </div>
        ) : null}
        {!rows && !failed ? (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            Loading…
          </p>
        ) : null}
        {rows && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No {noun}s match.</p>
        ) : null}
        {rows && rows.length > 0 ? (
          <ul aria-label={`Your ${noun}s`} className="flex flex-col gap-0.5">
            {rows.map((row, index) => (
              <li key={`${row.type}:${row.id}`}>
                <button
                  aria-current={index === active ? "true" : undefined}
                  className={cn(
                    "w-full rounded-md px-2 py-1 text-left text-sm hover:bg-accent",
                    "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
                    index === active && "bg-accent",
                  )}
                  data-testid="agent-ref-picker-row"
                  onClick={() => pick(row)}
                  onMouseEnter={() => setActive(index)}
                  type="button"
                >
                  <span className="block truncate">
                    {row.title || "Untitled"}
                  </span>
                  {row.subtitle ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.subtitle}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

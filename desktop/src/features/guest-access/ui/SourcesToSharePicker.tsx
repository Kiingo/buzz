import { Lock } from "lucide-react";

import { cn } from "@/shared/lib/cn";

import { dataSourceDescription, dataSourceLabel } from "../lib/copy";

/**
 * What an owner-data approval releases (contracts §5.2.1). When the request
 * named its sources, they start checked and the owner may only narrow the
 * list; when it named none, nothing starts checked and the owner must pick
 * at least one from the requestable set. Each source says what it exposes.
 */
export function SourcesToSharePicker({
  agentName,
  disabled = false,
  mustChoose,
  onChange,
  selected,
  sources,
}: {
  agentName: string;
  disabled?: boolean;
  mustChoose: boolean;
  onChange: (next: string[]) => void;
  selected: readonly string[];
  sources: readonly string[];
}) {
  const chosen = new Set(selected);
  return (
    <fieldset
      className="space-y-1.5"
      data-testid="guest-sources-to-share"
      disabled={disabled}
    >
      <legend className="mb-1 text-sm font-medium text-foreground">
        {mustChoose ? "Choose what to share" : "What you're sharing"}
      </legend>
      <p className="text-xs text-muted-foreground">
        {mustChoose
          ? `They didn't say exactly what they need. Pick what ${agentName} may use to answer.`
          : `Approving lets ${agentName} answer once more using only what's checked. Uncheck anything you'd rather not share.`}
      </p>
      {sources.map((source) => {
        const checked = chosen.has(source);
        return (
          <label
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm",
              checked
                ? "border-primary/50 bg-primary/5"
                : "border-border/60 hover:bg-muted/40",
            )}
            data-testid={`guest-share-source-${source}`}
            key={source}
          >
            <input
              checked={checked}
              onChange={() =>
                onChange(
                  checked
                    ? selected.filter((value) => value !== source)
                    : sources.filter(
                        (value) => value === source || chosen.has(value),
                      ),
                )
              }
              type="checkbox"
              value={source}
            />
            <Lock
              aria-hidden
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500"
            />
            <span className="min-w-0">
              <span className="block text-foreground">
                {dataSourceLabel(source)}
              </span>
              {dataSourceDescription(source) ? (
                <span
                  className="block text-xs text-muted-foreground"
                  data-testid={`guest-share-source-${source}-description`}
                >
                  {dataSourceDescription(source)}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
      {selected.length === 0 ? (
        <p className="text-xs text-amber-600 dark:text-amber-400" role="status">
          Choose at least one to approve, or deny the request.
        </p>
      ) : null}
    </fieldset>
  );
}

/** Initial selection: everything requested, or nothing when the owner must pick. */
export function initialSharedSources(
  sources: readonly string[],
  mustChoose: boolean,
): string[] {
  return mustChoose ? [] : [...sources];
}

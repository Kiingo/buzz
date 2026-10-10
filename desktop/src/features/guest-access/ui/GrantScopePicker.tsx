import { cn } from "@/shared/lib/cn";

import { scopeLabel } from "../lib/copy";
import type { GrantScope } from "../lib/wire";

export const GRANT_SCOPES: readonly GrantScope[] = [
  "once",
  "thread",
  "person_days",
  "question_kind",
  "always",
];

const SCOPE_HINTS: Record<GrantScope, string> = {
  once: "Only this answer. They'll need your approval next time.",
  thread: "Answers like this in this thread go out without asking you.",
  person_days: "This person can get answers from the same data for a while.",
  question_kind:
    "Questions of this kind from this person go out without asking you.",
  always:
    "This person can always get answers from the same data. New kinds of questions flagged by the safety check still come to you.",
};

export const DEFAULT_GRANT_DAYS = 7;
const DAY_OPTIONS = [1, 7, 30, 90] as const;

export type GrantChoice = { scope: GrantScope; days: number };

/** Grant-scope picker for an approval: once, thread, N days, kind, always. */
export function GrantScopePicker({
  disabled = false,
  onChange,
  requesterName,
  requesterLinked,
  value,
}: {
  disabled?: boolean;
  onChange: (value: GrantChoice) => void;
  requesterName: string;
  requesterLinked: boolean;
  value: GrantChoice;
}) {
  return (
    <fieldset
      className="space-y-1.5"
      data-testid="guest-grant-scope-picker"
      disabled={disabled}
    >
      <legend className="mb-1 text-sm font-medium text-foreground">
        Also allow next time
      </legend>
      {GRANT_SCOPES.map((scope) => {
        // Grants are tied to a linked account; an unlinked person can only
        // be approved once.
        const unavailable = scope !== "once" && !requesterLinked;
        const checked = value.scope === scope;
        return (
          <label
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm",
              checked
                ? "border-primary/50 bg-primary/5"
                : "border-border/60 hover:bg-muted/40",
              unavailable && "cursor-not-allowed opacity-50",
            )}
            data-testid={`guest-grant-scope-${scope}`}
            key={scope}
          >
            <input
              checked={checked}
              className="mt-1"
              disabled={unavailable}
              name="guest-grant-scope"
              onChange={() => onChange({ ...value, scope })}
              type="radio"
              value={scope}
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2 text-foreground">
                {scope === "person_days"
                  ? `${requesterName} for`
                  : scopeLabel(scope)}
                {scope === "person_days" ? (
                  <select
                    aria-label="Number of days"
                    className="rounded-md border border-border/70 bg-background px-1.5 py-0.5 text-sm"
                    disabled={unavailable || disabled}
                    onChange={(event) =>
                      onChange({
                        scope: "person_days",
                        days: Number(event.target.value),
                      })
                    }
                    value={value.days}
                  >
                    {DAY_OPTIONS.map((days) => (
                      <option key={days} value={days}>
                        {days} {days === 1 ? "day" : "days"}
                      </option>
                    ))}
                  </select>
                ) : null}
              </span>
              <span className="block text-xs text-muted-foreground">
                {unavailable
                  ? `${requesterName} hasn't linked their account, so only a one-time approval is possible.`
                  : SCOPE_HINTS[scope]}
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** The `grant` body for a decision, or `null` for a one-time approval. */
export function grantForChoice(
  choice: GrantChoice,
): { scope: GrantScope; days?: number } | null {
  if (choice.scope === "once") return null;
  return choice.scope === "person_days"
    ? { scope: "person_days", days: choice.days }
    : { scope: choice.scope };
}

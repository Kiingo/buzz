import { ChevronDown } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { AdvancedRequiredBadge } from "./AdvancedRequiredBadge";

/** The "Advanced" disclosure button, with a Required badge while collapsed fields block saving. */
export function AdvancedFieldsToggle({
  expanded,
  onToggle,
  required,
}: {
  expanded: boolean;
  onToggle: () => void;
  required: boolean;
}) {
  return (
    <button
      aria-expanded={expanded}
      className="inline-flex h-9 items-center gap-1.5 text-sm font-medium text-foreground transition-colors hover:text-foreground/80 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onToggle}
      type="button"
    >
      <span>Advanced</span>
      <AdvancedRequiredBadge
        show={required}
        testId="persona-advanced-required-badge"
      />
      <ChevronDown
        className={cn(
          "h-4 w-4 text-muted-foreground transition-transform duration-150 ease-out",
          expanded && "rotate-180",
        )}
      />
    </button>
  );
}

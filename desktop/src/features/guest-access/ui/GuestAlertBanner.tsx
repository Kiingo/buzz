import { Info, ShieldAlert, X } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

import type { GuestAlert } from "../lib/store";

/**
 * Prominent banner for 46042 agent guest alerts. High-severity alerts
 * (blocked attack, suspension) are red and stay until dismissed; info alerts
 * (digest ready) are quieter.
 */
export function GuestAlertBanner({
  alerts,
  onDismiss,
  onOpenSettings,
}: {
  alerts: readonly GuestAlert[];
  onDismiss: (alertId: string) => void;
  onOpenSettings?: () => void;
}) {
  if (alerts.length === 0) return null;
  const ordered = [...alerts].sort((a, b) =>
    a.severity === b.severity
      ? b.createdAt - a.createdAt
      : a.severity === "high"
        ? -1
        : 1,
  );
  const visible = ordered.slice(0, 3);
  const hidden = ordered.length - visible.length;

  return (
    <div
      aria-live="assertive"
      className="pointer-events-none fixed inset-x-0 top-12 z-50 flex flex-col items-center gap-2 px-4"
      data-testid="guest-alert-banner"
    >
      {visible.map((alert) => {
        const high = alert.severity === "high";
        const Icon = high ? ShieldAlert : Info;
        return (
          <div
            className={cn(
              "pointer-events-auto flex w-full max-w-xl items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur",
              high
                ? "border-destructive/50 bg-destructive/10 text-foreground"
                : "border-border bg-background/95 text-foreground",
            )}
            data-severity={alert.severity}
            key={alert.alertId}
            role={high ? "alert" : "status"}
          >
            <Icon
              aria-hidden
              className={cn(
                "mt-0.5 h-4 w-4 shrink-0",
                high ? "text-destructive" : "text-blue-500",
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {high ? "Agent guest access alert" : "Agent guest access"}
              </p>
              <p className="break-words text-muted-foreground">
                {alert.content || "Something needs your attention."}
              </p>
              {onOpenSettings ? (
                <button
                  className="mt-1 text-xs underline"
                  onClick={onOpenSettings}
                  type="button"
                >
                  Review guest access
                </button>
              ) : null}
            </div>
            <Button
              aria-label="Dismiss alert"
              onClick={() => onDismiss(alert.alertId)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <X aria-hidden />
            </Button>
          </div>
        );
      })}
      {hidden > 0 ? (
        <p className="pointer-events-auto rounded-full bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow">
          {hidden} more {hidden === 1 ? "alert" : "alerts"}
        </p>
      ) : null}
    </div>
  );
}

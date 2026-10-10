import type { ReactNode } from "react";

import { Button } from "@/shared/ui/button";

import { toGuestAccessError } from "../../lib/client";

export function formatDate(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleString();
}

export function formatRelative(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "never";
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Loading, error and empty states shared by the Access tabs. */
export function QueryState({
  empty,
  emptyText,
  error,
  isLoading,
  onRetry,
  children,
}: {
  empty: boolean;
  emptyText: string;
  error: unknown;
  isLoading: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (isLoading) {
    return <p className="py-4 text-sm text-muted-foreground">Loading…</p>;
  }
  if (error) {
    return (
      <div className="space-y-2 py-4">
        <p className="text-sm text-destructive" role="alert">
          {toGuestAccessError(error).message}
        </p>
        <Button onClick={onRetry} size="sm" type="button" variant="outline">
          Retry
        </Button>
      </div>
    );
  }
  if (empty) {
    return <p className="py-4 text-sm text-muted-foreground">{emptyText}</p>;
  }
  return <>{children}</>;
}

export function MutationError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="text-sm text-destructive" role="alert">
      {toGuestAccessError(error).message}
    </p>
  );
}

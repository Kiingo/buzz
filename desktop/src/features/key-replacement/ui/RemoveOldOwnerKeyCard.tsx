import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ShieldAlert, UserMinus } from "lucide-react";

import { canonicalNpub, truncateNpub } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import {
  describeRemovalOutcome,
  describeRemovalReason,
  keyReplacementApi,
  keyReplacementStatusQueryKey,
  toKeyReplacementError,
  type RemovalOutcome,
} from "../lib/keyReplacement";
import { offeredRemoval } from "../lib/offer";

/**
 * Profile settings, after re-linking agents: lets the relay owner remove the
 * retired relay owner key the hosted service names. Shown only when the
 * service names one; disabled with a reason unless the signed-in key is the
 * relay owner and the relay still lists that key as a member. Its own
 * confirmation, never chained to the other steps.
 */
export function RemoveOldOwnerKeyCard() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: keyReplacementStatusQueryKey,
    queryFn: () => keyReplacementApi.status(),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [outcome, setOutcome] = React.useState<RemovalOutcome | null>(null);
  const [removedKey, setRemovedKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const step = offeredRemoval(status.data);
  const key = removedKey ?? step?.publicKey ?? null;
  if (!key || (!step && !outcome)) return null;

  const remove = async () => {
    if (busy || !step?.removable) return;
    setBusy(true);
    setError(null);
    try {
      const next = await keyReplacementApi.remove(step.publicKey);
      setRemovedKey(step.publicKey);
      setOutcome(next);
      setOpen(false);
      void queryClient.invalidateQueries({
        queryKey: keyReplacementStatusQueryKey,
      });
    } catch (failure) {
      setError(toKeyReplacementError(failure).message);
    } finally {
      setBusy(false);
    }
  };

  const checkAgain = async () => {
    if (busy || !outcome || !removedKey) return;
    setBusy(true);
    setError(null);
    try {
      const removed = await keyReplacementApi.removed(removedKey);
      setOutcome({ ...outcome, removed });
    } catch (failure) {
      setError(toKeyReplacementError(failure).message);
    } finally {
      setBusy(false);
    }
  };

  const short = truncateNpub(key);
  const disabledReason =
    !outcome && step && !step.removable
      ? describeRemovalReason(step.reason)
      : null;

  return (
    <section className="mt-8 min-w-0" data-testid="settings-remove-old-owner">
      <div className="space-y-3 rounded-xl border border-border/60 p-3">
        <p className="flex items-start gap-2 text-sm">
          <UserMinus aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-medium text-foreground">
              Remove old owner key.
            </span>{" "}
            The retired relay owner key {short} is still a relay member; remove
            it once your agents are re-linked.
          </span>
        </p>
        {outcome ? (
          <div className="space-y-2" role="status">
            <p className="flex items-start gap-2 text-sm">
              {outcome.removed ? (
                <CheckCircle2
                  aria-hidden
                  className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500"
                />
              ) : (
                <ShieldAlert
                  aria-hidden
                  className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
                />
              )}
              <span>{describeRemovalOutcome(outcome)}</span>
            </p>
            {outcome.accepted && !outcome.removed ? (
              <Button
                disabled={busy}
                onClick={() => void checkAgain()}
                size="sm"
                type="button"
                variant="outline"
              >
                Check again
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            <Button
              aria-describedby={
                disabledReason ? "remove-old-owner-reason" : undefined
              }
              data-testid="remove-old-owner-open"
              disabled={!step?.removable}
              onClick={() => setOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              Remove old owner key…
            </Button>
            {disabledReason ? (
              <p
                className="text-xs text-muted-foreground"
                id="remove-old-owner-reason"
              >
                {disabledReason}
              </p>
            ) : null}
          </div>
        )}
        {error && !open ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <Dialog onOpenChange={(next) => !busy && setOpen(next)} open={open}>
        <DialogContent data-testid="remove-old-owner-dialog">
          <DialogHeader>
            <DialogTitle>Remove old owner key</DialogTitle>
            <DialogDescription>
              Buzz signs one request with your current key that removes this key
              from the relay; it removes no one else.
            </DialogDescription>
          </DialogHeader>
          <dl className="space-y-1 text-sm">
            <dt className="text-xs font-medium text-muted-foreground">
              Key to remove
            </dt>
            <dd className="font-medium text-foreground">{short}</dd>
            <dd className="break-all font-mono text-xs text-muted-foreground">
              {canonicalNpub(key)}
            </dd>
          </dl>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={busy}
              onClick={() => setOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              data-testid="remove-old-owner-confirm"
              disabled={busy || !step?.removable}
              onClick={() => void remove()}
              type="button"
              variant="destructive"
            >
              {busy ? "Removing…" : "Remove and sign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

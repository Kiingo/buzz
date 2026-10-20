import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, ShieldAlert } from "lucide-react";

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
  describeOutcome,
  keyReplacementApi,
  keyReplacementStatusQueryKey as statusQueryKey,
  toKeyReplacementError,
  type KeyReplacementOutcome,
} from "../lib/keyReplacement";
import { offeredReplacement } from "../lib/offer";

/**
 * Profile settings: lets a relay owner or admin confirm, once, that their
 * current key replaced an earlier revoked key. Shown only while the native
 * check says all three conditions hold; nothing is signed until the owner
 * confirms in the dialog that names both keys.
 */
export function KeyReplacementCard() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: statusQueryKey,
    queryFn: () => keyReplacementApi.status(),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [outcome, setOutcome] = React.useState<KeyReplacementOutcome | null>(
    null,
  );
  const [confirmedKeys, setConfirmedKeys] = React.useState<{
    old: string;
    current: string;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const offer = offeredReplacement(status.data);
  // Once a request went out, keep its result on screen even though the
  // control itself is no longer offered.
  if (!offer && !outcome) return null;
  const keys = offer ?? confirmedKeys;
  if (!keys) return null;

  const confirm = async () => {
    if (busy || !offer) return;
    setBusy(true);
    setError(null);
    try {
      const next = await keyReplacementApi.confirm(offer.old);
      setConfirmedKeys(offer);
      setOutcome(next);
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: statusQueryKey });
    } catch (failure) {
      setError(toKeyReplacementError(failure).message);
    } finally {
      setBusy(false);
    }
  };

  const checkAgain = async () => {
    if (busy || !outcome || !confirmedKeys) return;
    setBusy(true);
    setError(null);
    try {
      const confirmed = await keyReplacementApi.confirmed(confirmedKeys.old);
      setOutcome({ ...outcome, confirmed });
    } catch (failure) {
      setError(toKeyReplacementError(failure).message);
    } finally {
      setBusy(false);
    }
  };

  const oldShort = truncateNpub(keys.old);
  const currentShort = truncateNpub(keys.current);

  return (
    <section className="mt-8 min-w-0" data-testid="settings-key-replacement">
      <div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
        <p className="flex items-start gap-2 text-sm">
          <KeyRound aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-medium text-foreground">
              Confirm key replacement.
            </span>{" "}
            Your earlier key {oldShort} was revoked. Confirm that your current
            key {currentShort} replaced it so the relay can move your agents to
            it.
          </span>
        </p>
        {outcome ? (
          <div className="space-y-2" role="status">
            <p className="flex items-start gap-2 text-sm">
              {outcome.confirmed ? (
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
              <span>{describeOutcome(outcome)}</span>
            </p>
            {outcome.accepted && !outcome.confirmed ? (
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
          <Button
            data-testid="key-replacement-open"
            onClick={() => setOpen(true)}
            size="sm"
            type="button"
          >
            Confirm key replacement…
          </Button>
        )}
        {error && !open ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <Dialog onOpenChange={(next) => !busy && setOpen(next)} open={open}>
        <DialogContent data-testid="key-replacement-dialog">
          <DialogHeader>
            <DialogTitle>Confirm key replacement</DialogTitle>
            <DialogDescription>
              Buzz signs one record with your current key saying it replaced
              your earlier key, and sends it to the relay; it changes nothing
              else.
            </DialogDescription>
          </DialogHeader>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                Earlier key (revoked)
              </dt>
              <dd className="font-medium text-foreground">{oldShort}</dd>
              <dd className="break-all font-mono text-xs text-muted-foreground">
                {canonicalNpub(keys.old)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                Current key (signs)
              </dt>
              <dd className="font-medium text-foreground">{currentShort}</dd>
              <dd className="break-all font-mono text-xs text-muted-foreground">
                {canonicalNpub(keys.current)}
              </dd>
            </div>
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
              data-testid="key-replacement-confirm"
              disabled={busy}
              onClick={() => void confirm()}
              type="button"
            >
              {busy ? "Confirming…" : "Confirm and sign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

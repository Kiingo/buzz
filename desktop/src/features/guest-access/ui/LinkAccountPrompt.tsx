import * as React from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { useIdentityLinkStatus } from "../hooks";
import {
  ACCOUNT_NAME,
  LINK_EXPLANATION,
  LinkAccountForm,
} from "./LinkAccountForm";

const PROMPT_STORAGE_KEY = "buzz.guestAccess.linkPromptShownAt";
const PROMPT_INTERVAL_MS = 24 * 60 * 60_000;

/** At most one link prompt per day, across restarts. */
export function shouldShowLinkPrompt(
  lastShownAt: string | null,
  now: number = Date.now(),
): boolean {
  const last = Number(lastShownAt);
  return (
    !Number.isFinite(last) || last <= 0 || now - last >= PROMPT_INTERVAL_MS
  );
}

/**
 * Nudges an unlinked user to link their account: a toast at most once a day
 * that opens the link dialog. `forceUnlinked` covers the case where the
 * route or the harness reported the owner as unlinked before the hourly
 * status check ran.
 */
export function LinkAccountPrompt({
  forceUnlinked = false,
}: {
  forceUnlinked?: boolean;
}) {
  const status = useIdentityLinkStatus();
  const [open, setOpen] = React.useState(false);
  const unlinked =
    status.data?.linked === false ||
    (forceUnlinked && status.data?.linked !== true);

  React.useEffect(() => {
    if (!unlinked) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem(PROMPT_STORAGE_KEY);
    } catch {
      // Storage unavailable: prompt this session only.
    }
    if (!shouldShowLinkPrompt(last)) return;
    try {
      localStorage.setItem(PROMPT_STORAGE_KEY, String(Date.now()));
    } catch {
      // Ignore.
    }
    toast(`Link your ${ACCOUNT_NAME} account`, {
      id: "guest-access-link-prompt",
      description:
        "Linking lets colleagues' agents answer your questions, and your agents answer theirs.",
      duration: 20_000,
      action: { label: "Link account", onClick: () => setOpen(true) },
    });
  }, [unlinked]);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent className="max-w-lg" data-testid="link-account-dialog">
        <DialogHeader>
          <DialogTitle>Link your {ACCOUNT_NAME} account</DialogTitle>
          <DialogDescription>{LINK_EXPLANATION}</DialogDescription>
        </DialogHeader>
        <LinkAccountForm
          linkUrl={status.data?.linkUrl}
          onLinked={(displayName) => {
            setOpen(false);
            toast.success(
              displayName ? `Linked as ${displayName}` : "Account linked",
            );
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

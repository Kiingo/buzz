import { CheckCircle2, Link2 } from "lucide-react";

import { useGuestAccessEnabled, useIdentityLinkStatus } from "../hooks";
import {
  ACCOUNT_NAME,
  LINK_EXPLANATION,
  LinkAccountForm,
} from "./LinkAccountForm";

/** Profile settings: link this Buzz identity to the user's org account. */
export function AccountLinkCard() {
  const enabled = useGuestAccessEnabled();
  const status = useIdentityLinkStatus();
  if (!enabled) return null;

  return (
    <section className="mt-8 min-w-0" data-testid="settings-account-link">
      <div className="mb-3">
        <h3 className="text-base font-semibold text-foreground">
          {ACCOUNT_NAME} account
        </h3>
        <p className="text-sm text-muted-foreground">
          Linking lets colleagues' agents answer you, and your agents answer
          them.
        </p>
      </div>
      {status.isLoading ? (
        <p className="text-sm text-muted-foreground">Checking link status…</p>
      ) : status.data?.linked ? (
        <div
          className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm"
          data-testid="account-link-linked"
        >
          <CheckCircle2
            aria-hidden
            className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500"
          />
          <p>
            Linked
            {status.data.displayName ? ` as ${status.data.displayName}` : ""}.
            Colleagues' agents can answer you from what you're both allowed to
            see.
          </p>
        </div>
      ) : (
        <div
          className="space-y-3 rounded-xl border border-border/60 p-3"
          data-testid="account-link-unlinked"
        >
          <p className="flex items-start gap-2 text-sm">
            <Link2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{LINK_EXPLANATION}</span>
          </p>
          {status.error ? (
            <p className="text-xs text-muted-foreground">
              Couldn't check your link status right now.
            </p>
          ) : null}
          <LinkAccountForm linkUrl={status.data?.linkUrl} />
        </div>
      )}
    </section>
  );
}

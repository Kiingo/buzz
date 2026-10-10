import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import { identityLinkStatusQueryKey, useGuestAccessConfig } from "../hooks";
import { guestAccessApi, toGuestAccessError } from "../lib/client";

export const ACCOUNT_NAME = "Kiingo";
export const DEFAULT_LINK_URL = "https://dashboard.kiingo.com/team/buzz";

/** Why linking matters, in one paragraph. */
export const LINK_EXPLANATION = `Linking proves this Buzz identity is you. Once linked, colleagues' agents can answer you from what you're both allowed to see, and your agents can answer colleagues. Until then, other people's agents can only share free/busy times and things marked shareable with you.`;

/**
 * Accepts a `KIINGO-xxxx-xxxx-xxxx-xxxx` code, tolerating lowercase, stray
 * spaces, or a pasted `/kiingo link KIINGO-…` command.
 */
export function normalizeLinkCode(input: string): string {
  const compact = input.trim().toUpperCase();
  const match = /KIINGO-[0-9A-F]{4}(?:-?[0-9A-F]{4}){3}/.exec(
    compact.replace(/\s+/g, ""),
  );
  if (!match) return compact.replace(/\s+/g, "");
  const hex = match[0].slice("KIINGO-".length).replace(/-/g, "");
  return `KIINGO-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

export function isPlausibleLinkCode(code: string): boolean {
  return /^KIINGO-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(code);
}

/**
 * Enter a `KIINGO-…` code from the dashboard and link this Buzz key. The
 * request is NIP-98-signed by the key being linked, which is the proof of
 * possession, so no agent needs to be involved.
 */
export function LinkAccountForm({
  linkUrl,
  onLinked,
}: {
  linkUrl?: string | null;
  onLinked?: (displayName: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const config = useGuestAccessConfig();
  const [code, setCode] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const normalized = normalizeLinkCode(code);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isPlausibleLinkCode(normalized) || !config.data?.communityId) {
      setError(
        `Enter the ${ACCOUNT_NAME.toUpperCase()}-… code from your dashboard.`,
      );
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await guestAccessApi.linkIdentity(
        config.data.communityId,
        normalized,
      );
      await queryClient.invalidateQueries({
        queryKey: identityLinkStatusQueryKey,
      });
      setCode("");
      onLinked?.(result.displayName);
    } catch (cause) {
      setError(toGuestAccessError(cause).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="space-y-2"
      data-testid="link-account-form"
      onSubmit={(event) => void submit(event)}
    >
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>
          Open {ACCOUNT_NAME}{" "}
          <button
            className="inline-flex items-center gap-1 text-foreground underline"
            onClick={() => void openUrl(linkUrl || DEFAULT_LINK_URL)}
            type="button"
          >
            Team → Buzz
            <ExternalLink aria-hidden className="h-3 w-3" />
          </button>{" "}
          and choose Link Buzz identity to get a code.
        </li>
        <li>Paste the code here.</li>
      </ol>
      <div className="flex gap-2">
        <Input
          aria-label="Link code"
          autoComplete="off"
          autoCorrect="off"
          className="font-mono"
          data-testid="link-account-code"
          disabled={pending}
          onChange={(event) => setCode(event.target.value)}
          placeholder={`${ACCOUNT_NAME.toUpperCase()}-…`}
          spellCheck={false}
          value={code}
        />
        <Button
          data-testid="link-account-submit"
          disabled={pending || normalized.length === 0}
          type="submit"
        >
          {pending ? "Linking…" : "Link"}
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

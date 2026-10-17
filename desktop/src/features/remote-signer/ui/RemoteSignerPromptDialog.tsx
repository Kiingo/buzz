import * as React from "react";
import { UserRound } from "lucide-react";

import { useChannelsQuery } from "@/features/channels/hooks";
import { useProfileQuery } from "@/features/profile/hooks";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import type { RemoteSignerPrompt, ScopeChoice } from "../lib/api";
import {
  SIGNER_SERVICE_NAME,
  channelTarget,
  promptActionLabel,
  publishKindLabel,
  readKindsLabel,
  requesterLines,
  shortEventId,
} from "../lib/display";
import { useNow, useRemoteSignerDecision } from "../useRemoteSigner";
import { ScopePicker } from "./ScopePicker";

function Row({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/**
 * Who signs, shown first and styled unlike any agent identity: this is the
 * user's own key, never an agent's.
 */
function SigningAsBanner({
  displayName,
  pubkey,
}: {
  displayName: string | null;
  pubkey: string | null;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl border-2 border-amber-500/70 bg-amber-500/10 px-3 py-2.5"
      data-testid="remote-signer-signing-as"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white">
        <UserRound aria-hidden className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">
          Signing as: You{displayName ? ` (${displayName})` : ""}
        </p>
        <p className="text-xs text-muted-foreground">
          Your own identity, not an agent.
          {pubkey ? ` ${truncatePubkey(pubkey)}` : ""}
        </p>
      </div>
    </div>
  );
}

/**
 * Consent prompt for one remote signing request. The backend has already
 * validated it; this shows exactly what will be signed and returns the
 * user's decision. Closing the dialog denies the request.
 */
export function RemoteSignerPromptDialog({
  prompt,
  signerPubkey,
}: {
  prompt: RemoteSignerPrompt;
  signerPubkey: string | null;
}) {
  const decision = useRemoteSignerDecision();
  const channels = useChannelsQuery();
  const profile = useProfileQuery();
  const now = useNow(true);
  const [pickingScope, setPickingScope] = React.useState(false);

  const target = channelTarget(
    prompt.channelId ?? prompt.reportedChannelId,
    channels.data,
    signerPubkey,
  );
  const secondsLeft = Math.max(0, Math.ceil((prompt.deadlineMs - now) / 1000));
  const isRead = prompt.method === "read";

  const decide = (
    choice: "allowOnce" | "deny" | "allowScope",
    scope?: ScopeChoice,
  ) => {
    if (decision.isPending) return;
    decision.mutate({ requestId: prompt.requestId, choice, scope });
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) decide("deny");
      }}
      open
    >
      <DialogContent
        className="max-h-[85vh] max-w-xl overflow-y-auto"
        data-testid="remote-signer-prompt"
      >
        <DialogHeader>
          <DialogTitle>{promptActionLabel(prompt)}</DialogTitle>
          <DialogDescription>
            {SIGNER_SERVICE_NAME} is asking Buzz to sign this as you. Nothing is{" "}
            {isRead ? "read" : "sent"} unless you allow it.
          </DialogDescription>
        </DialogHeader>

        <SigningAsBanner
          displayName={profile.data?.displayName ?? null}
          pubkey={signerPubkey}
        />

        <dl className="divide-y divide-border/50">
          <Row label="Action">{promptActionLabel(prompt)}</Row>
          <Row label={isRead ? "Reads from" : "Where"}>
            {target ? (
              <span>
                <span className="font-medium">{target.label}</span>
                {target.detail ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {target.detail}
                  </span>
                ) : null}
                {!prompt.channelId && prompt.reportedChannelId ? (
                  <span className="block text-xs text-muted-foreground">
                    Reported by the requester; this {isRead ? "read" : "event"}{" "}
                    isn't bound to it.
                  </span>
                ) : null}
              </span>
            ) : isRead ? (
              <span className="font-medium">All channels you can read</span>
            ) : (
              <span className="text-muted-foreground">No channel</span>
            )}
          </Row>
          {prompt.kind !== null ? (
            <Row label="Kind">{publishKindLabel(prompt.kind)}</Row>
          ) : null}
          {prompt.targetEventId ? (
            <Row label="Target">
              <span className="font-mono text-xs">
                {shortEventId(prompt.targetEventId)}
              </span>
              {prompt.targetContent !== null ? (
                <span className="mt-1 block whitespace-pre-wrap rounded-md bg-muted/50 px-2 py-1 text-muted-foreground">
                  {prompt.targetContent || "(empty)"}
                </span>
              ) : null}
            </Row>
          ) : null}
          {!isRead && prompt.kind !== 9005 ? (
            <Row label={prompt.kind === 7 ? "Reaction" : "Content"}>
              <span
                className="block max-h-60 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/60 bg-background px-2 py-1.5"
                data-testid="remote-signer-content"
              >
                {prompt.content || "(empty)"}
              </span>
              {prompt.mentions.length > 0 ? (
                <span className="mt-1 block text-xs text-muted-foreground">
                  Mentions {prompt.mentions.length}{" "}
                  {prompt.mentions.length === 1 ? "person" : "people"}
                </span>
              ) : null}
            </Row>
          ) : null}
          {prompt.read ? (
            <Row label="Read scope">
              <span className="block">{readKindsLabel(prompt.read.kinds)}</span>
              {prompt.read.search ? (
                <span className="block text-muted-foreground">
                  Search: “{prompt.read.search}”
                </span>
              ) : null}
              {prompt.read.unbound ? (
                <span className="block text-xs text-amber-700 dark:text-amber-400">
                  Not limited to one channel.
                </span>
              ) : null}
              <details className="mt-1 text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  Exact filters
                </summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted/50 p-2">
                  {prompt.read.filtersJson}
                </pre>
              </details>
            </Row>
          ) : null}
          <Row label="Requested by">
            {requesterLines(prompt.requester).map((line, index) => (
              <span
                className={index === 0 ? "block font-medium" : "block text-xs"}
                key={line}
              >
                {line}
              </span>
            ))}
          </Row>
        </dl>

        {pickingScope ? (
          <ScopePicker
            channelLabel={target?.known ? target.label : null}
            isPending={decision.isPending}
            onCancel={() => setPickingScope(false)}
            onConfirm={(scope) => decide("allowScope", scope)}
            prompt={prompt}
          />
        ) : null}

        {decision.error ? (
          <p className="text-sm text-destructive" role="alert">
            {decision.error instanceof Error
              ? decision.error.message
              : "Couldn't record that decision."}
          </p>
        ) : null}

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            Expires in {secondsLeft}s
          </span>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              data-testid="remote-signer-deny"
              disabled={decision.isPending}
              onClick={() => decide("deny")}
              type="button"
              variant="outline"
            >
              Deny
            </Button>
            {!pickingScope ? (
              <Button
                data-testid="remote-signer-allow-for"
                disabled={decision.isPending}
                onClick={() => setPickingScope(true)}
                type="button"
                variant="secondary"
              >
                Allow for…
              </Button>
            ) : null}
            <Button
              data-testid="remote-signer-allow-once"
              disabled={decision.isPending}
              onClick={() => decide("allowOnce")}
              type="button"
            >
              Allow once
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

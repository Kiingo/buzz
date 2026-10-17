import { openUrl } from "@tauri-apps/plugin-opener";
import { Copy, ExternalLink } from "lucide-react";

import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { readReplyDetails } from "../lib/replyDetails";
import type { TimelineMessage } from "../types";

function DetailRow({
  copyLabel,
  label,
  value,
}: {
  copyLabel?: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="break-all font-mono text-xs">{value}</div>
      </div>
      {copyLabel ? (
        <Button
          aria-label={`Copy ${label.toLowerCase()}`}
          className="h-7 w-7 shrink-0 p-0"
          onClick={() => copyTextToClipboard(value, copyLabel)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

/** Right-click / More actions -> Details: what used to clutter the chat
 *  (mission link, steering and Stop) plus the message's own identifiers. */
export function MessageDetailsDialog({
  message,
  onOpenChange,
  open,
}: {
  message: TimelineMessage;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { detailsUrl, missionId } = readReplyDetails(message.tags);
  const sentAt = new Date(message.createdAt * 1000);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md" data-testid="message-details-dialog">
        <DialogHeader>
          <DialogTitle>Message details</DialogTitle>
          <DialogDescription>
            {message.author} · {sentAt.toLocaleString()}
          </DialogDescription>
        </DialogHeader>

        {missionId || detailsUrl ? (
          <div className="rounded-md border border-border/70 p-3">
            <div className="text-sm font-medium">Kiingo mission</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Reply in this thread to steer the agent. Open the mission to see
              its status or stop it.
            </p>
            {missionId ? (
              <DetailRow
                copyLabel="Mission ID copied"
                label="Mission ID"
                value={missionId}
              />
            ) : null}
            {detailsUrl ? (
              <Button
                className="mt-2"
                data-testid="message-details-open-mission"
                onClick={() => {
                  void openUrl(detailsUrl);
                }}
                size="sm"
                type="button"
                variant="secondary"
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                Open mission in Kiingo
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="divide-y divide-border/60">
          <DetailRow
            copyLabel="Event ID copied"
            label="Event ID"
            value={message.id}
          />
          {message.pubkey ? (
            <DetailRow
              copyLabel="Author key copied"
              label="Author key"
              value={message.pubkey}
            />
          ) : null}
          <DetailRow label="Sent" value={sentAt.toISOString()} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

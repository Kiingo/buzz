import { Headphones } from "lucide-react";

import type { TimelineMessage } from "@/features/messages/types";

import { HuddleAttachment } from "./HuddleAttachment";

type HuddleServiceNoticeProps = {
  channelId: string | null;
  message: TimelineMessage;
};

/**
 * A huddle start published by the relay's huddle service: a system notice
 * with the huddle card, without an author avatar or name.
 */
export function HuddleServiceNotice({
  channelId,
  message,
}: HuddleServiceNoticeProps) {
  return (
    <div
      className="mx-1 rounded-2xl px-2 py-1"
      data-testid="huddle-service-notice"
    >
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
        <Headphones aria-hidden="true" className="h-3.5 w-3.5" />
        Huddle
      </p>
      <HuddleAttachment
        channelId={channelId}
        className="mt-2"
        message={message}
      />
    </div>
  );
}

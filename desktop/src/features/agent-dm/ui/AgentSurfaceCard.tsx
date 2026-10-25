import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import type { TimelineMessage } from "@/features/messages/types";
import {
  buzzSurfaceTapTag,
  type SurfaceController,
} from "@/features/surfaces/core";
import {
  surfaceApiOrigin,
  surfaceStore,
} from "@/features/surfaces/lib/surfaceStore";
import {
  SurfaceExpandedDialog,
  SurfaceView,
  type SurfaceHost,
} from "@/features/surfaces/view";
import { useIdentityQuery } from "@/shared/api/hooks";

import { parseSurface } from "../lib/markers";
import { sendAgentDmTaggedMessage } from "../lib/send";

/** A focus re-read waits at least this long after the last read. */
const FOCUS_REFRESH_MS = 15_000;

type Load =
  | { kind: "loading" }
  | { kind: "ready"; controller: SurfaceController }
  | { kind: "unavailable" };

/**
 * The surface an agent message points at (`buzz-surface`, §7 of
 * docs/agent-dm-markers.md), drawn under the message's own text. While it
 * loads, or when the host has no surface for this person, only the text
 * shows. A newer revision on the message, or the window regaining focus,
 * reads it again.
 */
export function AgentSurfaceCard({
  channelId,
  message,
}: {
  channelId: string;
  message: TimelineMessage;
}) {
  const marker = React.useMemo(
    () => parseSurface(message.tags),
    [message.tags],
  );
  const [load, setLoad] = React.useState<Load>({ kind: "loading" });
  const [expanded, setExpanded] = React.useState(false);
  const queryClient = useQueryClient();
  const senderPubkey = useIdentityQuery().data?.pubkey;
  const surfaceId = marker?.surfaceId;
  const revision = marker?.revision;

  React.useEffect(() => {
    if (!surfaceId) return;
    let current = true;
    void surfaceStore()
      .load(surfaceId, revision)
      .then((controller) => {
        if (!current) return;
        setLoad(
          controller ? { kind: "ready", controller } : { kind: "unavailable" },
        );
      });
    return () => {
      current = false;
    };
  }, [surfaceId, revision]);

  const controller = load.kind === "ready" ? load.controller : null;

  React.useEffect(() => {
    if (!controller) return;
    let readAt = Date.now();
    const onFocus = () => {
      if (Date.now() - readAt < FOCUS_REFRESH_MS) return;
      readAt = Date.now();
      void controller.refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [controller]);

  const host = React.useMemo<SurfaceHost>(
    () => ({
      apiOrigin: surfaceApiOrigin() ?? "https://invalid.invalid",
      openUrl: (url) => {
        void openUrl(url).catch(() => toast.error("Couldn’t open that link."));
      },
      openExpanded: () => setExpanded(true),
      // The surface's single send path (controller.sendMessage) hands over
      // exactly the words the control showed and the tap they came from:
      // the tag makes the turn a surface tap (lower trust) on the server.
      // The composer never adds it.
      sendMessage: (text, tap) => {
        void sendAgentDmTaggedMessage({
          queryClient,
          channelId,
          senderPubkey,
          content: text,
          markerTags: [buzzSurfaceTapTag(tap)],
        }).catch((error: unknown) =>
          toast.error(
            error instanceof Error ? error.message : "Failed to send that.",
          ),
        );
      },
    }),
    [queryClient, channelId, senderPubkey],
  );

  if (!controller) return null;
  return (
    <div
      className="mt-2 max-w-xl rounded-lg border border-border bg-card p-3"
      data-testid="agent-surface-card"
    >
      <SurfaceView controller={controller} host={host} />
      <SurfaceExpandedDialog
        controller={controller}
        open={expanded}
        onOpenChange={setExpanded}
        host={host}
      />
    </div>
  );
}

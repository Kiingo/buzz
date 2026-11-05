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
import { surfaceReads } from "../lib/surfaceReads";
import { surfaceFromSigner } from "../lib/surfaceCardGate";

/** A focus re-read waits at least this long after the last read. */
const FOCUS_REFRESH_MS = 15_000;

const noSubscription = () => () => {};
const noSnapshot = () => null;

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
  // Closed, the expanded sheet, or the whole window (Full screen).
  const [expanded, setExpanded] = React.useState<"closed" | "sheet" | "full">(
    "closed",
  );
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
  // Read through the controller's subscription, so a refresh that changes
  // the surface's agent key draws or hides the card at once.
  const snapshot = React.useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.getSnapshot ?? noSnapshot,
  );

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
      // Files and worker trees the surface names, read through the
      // native signed request under this surface (BUZZWIRE); openFile
      // opens the agent's Files in the Kiingo app.
      ...(surfaceId
        ? surfaceReads({
            surfaceId,
            agentId: () => controller?.getSnapshot()?.surface.agentId,
            apiOrigin: surfaceApiOrigin,
          })
        : {}),
      openExpanded: () => setExpanded("sheet"),
      // The header's Full screen button and `open` with `target: fullscreen`:
      // the same controller in a dialog the size of the window. Reads nothing.
      openFullScreen: () => setExpanded("full"),
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
    [queryClient, channelId, senderPubkey, surfaceId, controller],
  );

  // S-b: only the agent the host bound to this surface may show it here.
  if (
    !controller ||
    !snapshot ||
    !surfaceFromSigner(snapshot.surface.agentBuzzPubkey, message.signerPubkey)
  ) {
    return null;
  }
  return (
    <div
      className="mt-2 max-w-xl rounded-lg border border-border bg-card p-3"
      data-testid="agent-surface-card"
    >
      <SurfaceView controller={controller} host={host} />
      <SurfaceExpandedDialog
        controller={controller}
        open={expanded !== "closed"}
        onOpenChange={(open) => {
          if (!open) setExpanded("closed");
        }}
        host={host}
        fullScreen={expanded === "full"}
      />
    </div>
  );
}

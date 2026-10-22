import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useIdentityQuery } from "@/shared/api/hooks";

import {
  createAutoLinkScheduler,
  linkedNote,
  newAutoLinkMemory,
  readAutoLinkSetting,
  relinkQueryKeys,
  runAutoLinkPass,
  subscribeAutoLinkSetting,
} from "../lib/autoLink";
import { hostedOwnerRelinkApi } from "../lib/client";

/** The signed-in key's auto-link setting, kept in sync across mounts. */
export function useAutoLinkSetting(ownerPublicKey: string | null): boolean {
  return React.useSyncExternalStore(
    subscribeAutoLinkSetting,
    () => readAutoLinkSetting(ownerPublicKey),
    () => false,
  );
}

const isForeground = () =>
  typeof document === "undefined" || document.visibilityState === "visible";

/**
 * App-wide runner for "auto-link my new agents". Renders nothing. While the
 * owner's setting is on and this build can reach the hosted provider, it
 * runs a pass on launch, on resume and every 15 minutes in the foreground,
 * and shows a quiet "Linked: …" note when a pass linked anyone.
 */
export function HostedAutoLinkExtension() {
  const identity = useIdentityQuery();
  const owner = identity.data?.pubkey?.toLowerCase() ?? null;
  const enabled = useAutoLinkSetting(owner);
  const queryClient = useQueryClient();
  const available = useQuery({
    queryKey: relinkQueryKeys.available,
    queryFn: () => hostedOwnerRelinkApi.available(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    enabled: enabled && owner !== null,
  });
  const canRun = enabled && owner !== null && available.data === true;

  React.useEffect(() => {
    if (!canRun || owner === null) return;
    // Refusals are remembered for this key and this mount only.
    const memory = newAutoLinkMemory();
    let current = true;
    const scheduler = createAutoLinkScheduler({
      isForeground,
      now: () => Date.now(),
      setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
      clearInterval: (handle) =>
        globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
      runPass: async () => {
        const result = await runAutoLinkPass(
          {
            list: () => hostedOwnerRelinkApi.list(),
            attestPending: (agents) =>
              hostedOwnerRelinkApi.attestPending(agents),
            rebind: (agents) => hostedOwnerRelinkApi.rebind(agents),
          },
          owner,
          memory,
        );
        // A pass that finishes after the setting changed or the owner signed
        // out says nothing.
        if (!current) return;
        if (result.sent) {
          void queryClient.invalidateQueries({
            queryKey: relinkQueryKeys.agents,
          });
        }
        const note = linkedNote(result.linked);
        if (note) toast(note, { id: "hosted-auto-link" });
      },
    });
    const onResume = () => {
      if (isForeground()) scheduler.resume();
    };
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    scheduler.start();
    return () => {
      current = false;
      scheduler.stop();
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
    };
  }, [canRun, owner, queryClient]);

  return null;
}

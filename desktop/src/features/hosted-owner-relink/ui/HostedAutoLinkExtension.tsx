import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useIdentityQuery } from "@/shared/api/hooks";

import {
  createAutoLinkBackoff,
  createAutoLinkScheduler,
  linkedNote,
  newAutoLinkMemory,
  notLinkedNote,
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
 * and shows a quiet "Linked: …" note when a pass linked anyone. A pass in
 * flight stops before its next signed request once the setting is off or
 * the signed-in key changes; passes that keep failing back off, with one
 * plain note.
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
  // The signed-in key right now, for a pass that started under another.
  const ownerNow = React.useRef(owner);
  ownerNow.current = owner;

  React.useEffect(() => {
    if (!canRun || owner === null) return;
    // Refusals and backoff are remembered for this key and this mount only.
    const memory = newAutoLinkMemory();
    const backoff = createAutoLinkBackoff();
    let current = true;
    const shouldContinue = () =>
      current && ownerNow.current === owner && readAutoLinkSetting(owner);
    const scheduler = createAutoLinkScheduler({
      isForeground,
      now: () => Date.now(),
      setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
      clearInterval: (handle) =>
        globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
      runPass: async () => {
        if (!backoff.allows(Date.now())) return;
        const result = await runAutoLinkPass(
          {
            list: () => hostedOwnerRelinkApi.list(),
            attestPending: (agents, view) =>
              hostedOwnerRelinkApi.attestPending(agents, view),
            rebind: (agents, view) => hostedOwnerRelinkApi.rebind(agents, view),
          },
          owner,
          memory,
          { shouldContinue },
        );
        // A pass that finishes after the setting changed or the owner signed
        // out says nothing.
        if (!shouldContinue()) return;
        const failed = backoff.record(result, Date.now());
        if (result.sent) {
          void queryClient.invalidateQueries({
            queryKey: relinkQueryKeys.agents,
          });
        }
        const note = linkedNote(result.linked);
        if (note) toast(note, { id: "hosted-auto-link" });
        // Agents refused for good are said once, plainly, with the reason.
        const refused = notLinkedNote(result.notLinked);
        if (refused) {
          toast(refused.title, {
            id: "hosted-auto-link-refused",
            description: refused.description,
          });
        }
        // Passes that keep failing as a whole are said once per run.
        if (failed) {
          toast(failed.title, {
            id: "hosted-auto-link-failed",
            description: failed.description,
          });
        }
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

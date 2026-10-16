import * as React from "react";
import { listen } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  REMOTE_SIGNER_CHANGED_EVENT,
  remoteSignerApi,
  type RemoteSignerDecision,
  type RemoteSignerSnapshot,
} from "./lib/api";

const SNAPSHOT_KEY = ["remote-signer", "snapshot"] as const;

/**
 * The backend's remote-signer state. Reading it also lets the backend start
 * or stop its poller for the active community. Lives in the community-scoped
 * query client, so nothing leaks across a community switch.
 */
export function useRemoteSignerSnapshot() {
  return useQuery({
    queryKey: SNAPSHOT_KEY,
    queryFn: remoteSignerApi.snapshot,
    // Keep scope countdowns and expiry current even without backend events.
    refetchInterval: 30_000,
    retry: false,
    staleTime: 5_000,
  });
}

/** Refresh the snapshot whenever the backend reports a change. Mount once. */
export function useRemoteSignerEvents() {
  const queryClient = useQueryClient();
  React.useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    listen(REMOTE_SIGNER_CHANGED_EVENT, () => {
      void queryClient.invalidateQueries({ queryKey: SNAPSHOT_KEY });
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // No native event bridge (web preview): the interval refetch covers it.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queryClient]);
}

function useSnapshotMutation<Input>(
  run: (input: Input) => Promise<RemoteSignerSnapshot>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (snapshot) => {
      queryClient.setQueryData(SNAPSHOT_KEY, snapshot);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SNAPSHOT_KEY });
    },
  });
}

export function useSetRemoteSignerEnabled() {
  return useSnapshotMutation((enabled: boolean) =>
    remoteSignerApi.setEnabled(enabled),
  );
}

export function useRemoteSignerDecision() {
  return useSnapshotMutation((decision: RemoteSignerDecision) =>
    remoteSignerApi.decide(decision),
  );
}

/** Revoke one scope by id, or every scope with `undefined`. */
export function useRevokeRemoteSignerScopes() {
  return useSnapshotMutation((scopeId: string | undefined) =>
    remoteSignerApi.revokeScopes(scopeId),
  );
}

/** Ticks once a second while `active`, for countdowns. */
export function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { guestAccessApi, type GuestAccessConfig } from "./lib/client";
import {
  getGuestAccessSnapshot,
  subscribeGuestAccessStore,
  type GuestAccessSnapshot,
} from "./lib/store";
import { useIdentityQuery } from "@/shared/api/hooks";

export const guestAccessConfigQueryKey = ["guest-access", "config"] as const;
export const identityLinkStatusQueryKey = [
  "guest-access",
  "identity-status",
] as const;

/** Build-time route and community. Never changes while the app runs. */
export function useGuestAccessConfig() {
  return useQuery<GuestAccessConfig>({
    queryKey: guestAccessConfigQueryKey,
    queryFn: () => guestAccessApi.config(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** True when this build has a hosted guest route configured. */
export function useGuestAccessEnabled() {
  const config = useGuestAccessConfig();
  return Boolean(config.data?.routeUrl);
}

/**
 * Whether this user's Buzz key is linked to their organization account.
 * Polled at most once an hour (contracts §9); refetched after linking.
 */
export function useIdentityLinkStatus(options?: { enabled?: boolean }) {
  const enabled = useGuestAccessEnabled() && (options?.enabled ?? true);
  return useQuery({
    queryKey: identityLinkStatusQueryKey,
    queryFn: () => guestAccessApi.identityStatus(),
    enabled,
    staleTime: 60 * 60_000,
    refetchInterval: 60 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useGuestAccessSnapshot(): GuestAccessSnapshot {
  return React.useSyncExternalStore(
    subscribeGuestAccessStore,
    getGuestAccessSnapshot,
    getGuestAccessSnapshot,
  );
}

/** The signed-in user's pubkey, lowercased, once identity has loaded. */
export function useOwnerPubkey(): string | null {
  const identity = useIdentityQuery();
  return identity.data?.pubkey?.toLowerCase() ?? null;
}

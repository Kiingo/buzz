import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import { useGuestAccessEnabled } from "./hooks";
import { guestAccessApi } from "./lib/client";

const root = ["guest-access", "owner"] as const;
export const ownerKeys = {
  agents: [...root, "agents"] as const,
  grants: [...root, "grants"] as const,
  blocks: [...root, "blocks"] as const,
  accessLog: (agent: string | null) => [...root, "access-log", agent] as const,
  shareables: [...root, "shareables"] as const,
  suggestions: [...root, "suggestions"] as const,
  digest: (date: string) => [...root, "digest", date] as const,
};

function useOwnerQuery<T>(key: QueryKey, fn: () => Promise<T>, enabled = true) {
  const routeEnabled = useGuestAccessEnabled();
  return useQuery({
    queryKey: key,
    queryFn: fn,
    enabled: routeEnabled && enabled,
    staleTime: 30_000,
    retry: 1,
  });
}

export function useOwnerGuestAgents() {
  return useOwnerQuery(ownerKeys.agents, () => guestAccessApi.ownerAgents());
}

/** The guest endpoint registered for one agent pubkey, if any. */
export function useGuestEndpointFor(agentPubkey: string | null | undefined) {
  const agents = useOwnerGuestAgents();
  const key = agentPubkey?.toLowerCase();
  return {
    ...agents,
    endpoint: key
      ? (agents.data?.find((agent) => agent.pubkey === key) ?? null)
      : null,
  };
}

export function useOwnerGrants() {
  return useOwnerQuery(ownerKeys.grants, () => guestAccessApi.grants());
}

export function useOwnerBlocks() {
  return useOwnerQuery(ownerKeys.blocks, () => guestAccessApi.blocks());
}

export function useOwnerAccessLog(agent: string | null, enabled = true) {
  return useOwnerQuery(
    ownerKeys.accessLog(agent),
    () => guestAccessApi.accessLog(agent),
    enabled,
  );
}

export function useOwnerShareables() {
  return useOwnerQuery(ownerKeys.shareables, () => guestAccessApi.shareables());
}

export function useOwnerSuggestions() {
  return useOwnerQuery(ownerKeys.suggestions, () =>
    guestAccessApi.suggestions(),
  );
}

export function useOwnerDigest(date: string) {
  return useOwnerQuery(ownerKeys.digest(date), () =>
    guestAccessApi.digest(date),
  );
}

/** A mutation that refreshes every owner-side guest-access query on success. */
export function useOwnerMutation<TInput>(
  fn: (input: TInput) => Promise<unknown>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: root }),
  });
}

/** Yesterday as YYYY-MM-DD in UTC, the digest's default day. */
export function defaultDigestDate(now: Date = new Date()): string {
  return new Date(now.getTime() - 24 * 60 * 60_000).toISOString().slice(0, 10);
}

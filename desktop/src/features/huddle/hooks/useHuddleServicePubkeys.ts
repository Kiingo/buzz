import { useQuery } from "@tanstack/react-query";

import { useCommunities } from "@/features/communities/useCommunities";
import { relayHttpFromWs } from "@/shared/api/inviteHelpers";

import { parseHuddleServicePubkeys } from "../lib/huddleService";

const NO_SERVICES: ReadonlySet<string> = new Set();

async function fetchHuddleServicePubkeys(
  relayUrl: string,
  signal?: AbortSignal,
): Promise<ReadonlySet<string>> {
  const url = `${relayHttpFromWs(relayUrl).replace(/\/+$/, "")}/info`;
  const response = await fetch(url, {
    headers: { Accept: "application/nostr+json" },
    signal,
  });
  if (!response.ok)
    throw new Error(`Could not read relay capabilities (${response.status})`);
  return parseHuddleServicePubkeys(await response.json());
}

/** The active relay's advertised huddle service identities. */
export function useHuddleServicePubkeys(): ReadonlySet<string> {
  const { activeCommunity } = useCommunities();
  const relayUrl = activeCommunity?.relayUrl ?? "";
  const query = useQuery({
    enabled: relayUrl.length > 0,
    queryFn: ({ signal }) => fetchHuddleServicePubkeys(relayUrl, signal),
    queryKey: ["relay-capability", relayUrl, "huddle-service"],
    retry: 1,
    staleTime: 5 * 60 * 1_000,
  });
  return query.data ?? NO_SERVICES;
}

import { invoke, isTauri } from "@tauri-apps/api/core";

const COMMUNITIES_KEY = "buzz-communities";
const MACHINE_COMPLETE_PREFIX = "buzz-machine-onboarding-complete.v2";
const LEGACY_COMPLETE_PREFIX = "buzz-onboarding-complete.v1";
const COMMUNITY_COMPLETE_PREFIX = "buzz-community-onboarding-complete.v1";

export type IdentityRotationRendererContinuity = {
  contractVersion: number;
  rotationId: string;
  oldOwnerPublicKey: string;
  newOwnerPublicKey: string;
};

export type RendererContinuityMigrationResult = {
  eligible: boolean;
  migratedCompletionCount: number;
  migratedCommunityCount: number;
};

type StoredCommunity = Record<string, unknown> & {
  pubkey?: unknown;
  relayUrl?: unknown;
};

const completionKey = (prefix: string, pubkey: string) => `${prefix}:${pubkey}`;

const communityCompletionKey = (relayUrl: string, pubkey: string) =>
  `${COMMUNITY_COMPLETE_PREFIX}:${encodeURIComponent(relayUrl)}:${pubkey}`;

const validPublicKey = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function copyTrueMarker(storage: Storage, source: string, target: string) {
  try {
    if (storage.getItem(source) !== "true") return false;
    if (storage.getItem(target) === "true") return false;
    storage.setItem(target, "true");
    return true;
  } catch {
    return false;
  }
}

function readStoredCommunities(storage: Storage): StoredCommunity[] | null {
  try {
    const raw = storage.getItem(COMMUNITIES_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (
      parsed.some(
        (entry) =>
          typeof entry !== "object" || entry === null || Array.isArray(entry),
      )
    ) {
      return null;
    }
    return parsed as StoredCommunity[];
  } catch {
    return null;
  }
}

/**
 * Move only presentation/onboarding continuity from the exact former owner
 * key to its committed replacement. Transactional stores, outboxes, drafts,
 * read state, message caches, and secrets deliberately remain identity-scoped.
 */
export function migrateIdentityRotationRendererContinuity(
  status: IdentityRotationRendererContinuity,
  storage: Storage = localStorage,
): RendererContinuityMigrationResult {
  const result: RendererContinuityMigrationResult = {
    eligible: false,
    migratedCompletionCount: 0,
    migratedCommunityCount: 0,
  };
  if (
    status.contractVersion !== 1 ||
    !validPublicKey(status.oldOwnerPublicKey) ||
    !validPublicKey(status.newOwnerPublicKey) ||
    status.oldOwnerPublicKey === status.newOwnerPublicKey
  ) {
    return result;
  }
  result.eligible = true;

  const oldKey = status.oldOwnerPublicKey;
  const newKey = status.newOwnerPublicKey;
  if (
    copyTrueMarker(
      storage,
      completionKey(MACHINE_COMPLETE_PREFIX, oldKey),
      completionKey(MACHINE_COMPLETE_PREFIX, newKey),
    )
  ) {
    result.migratedCompletionCount += 1;
  }
  if (
    copyTrueMarker(
      storage,
      completionKey(LEGACY_COMPLETE_PREFIX, oldKey),
      completionKey(LEGACY_COMPLETE_PREFIX, newKey),
    )
  ) {
    result.migratedCompletionCount += 1;
  }

  const communities = readStoredCommunities(storage);
  if (!communities) return result;
  const migratedRelays = new Set<string>();
  const next = communities.map((community) => {
    if (community.pubkey !== oldKey) return community;
    if (typeof community.relayUrl === "string") {
      migratedRelays.add(community.relayUrl);
    }
    result.migratedCommunityCount += 1;
    return { ...community, pubkey: newKey };
  });
  for (const relayUrl of migratedRelays) {
    if (
      copyTrueMarker(
        storage,
        communityCompletionKey(relayUrl, oldKey),
        communityCompletionKey(relayUrl, newKey),
      )
    ) {
      result.migratedCompletionCount += 1;
    }
  }
  if (result.migratedCommunityCount > 0) {
    try {
      storage.setItem(COMMUNITIES_KEY, JSON.stringify(next));
    } catch {
      result.migratedCommunityCount = 0;
    }
  }
  return result;
}

export async function migrateIdentityRotationRendererContinuityBeforeRender() {
  if (!isTauri()) return;
  try {
    const status = await invoke<IdentityRotationRendererContinuity | null>(
      "identity_rotation_renderer_continuity",
    );
    if (status) migrateIdentityRotationRendererContinuity(status);
  } catch {
    // Native state remains authoritative. A failed presentation migration must
    // leave the normal onboarding/recovery gates intact rather than guessing.
    console.warn(
      "[identityRotation] renderer continuity migration unavailable",
    );
  }
}

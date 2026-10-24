import { KIND_HUDDLE_STARTED } from "@/shared/constants/kinds";

const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;

/**
 * The huddle service identities a relay advertises in its NIP-11 document
 * (`huddle_service_pubkeys`). Their huddle notices are system notices, never
 * messages from a user. Malformed entries are ignored.
 */
export function parseHuddleServicePubkeys(info: unknown): ReadonlySet<string> {
  const raw =
    info && typeof info === "object"
      ? (info as { huddle_service_pubkeys?: unknown }).huddle_service_pubkeys
      : undefined;
  if (!Array.isArray(raw)) return new Set();
  return new Set(
    raw
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.toLowerCase())
      .filter((entry) => HEX_PUBKEY_RE.test(entry)),
  );
}

/** Whether `message` is a huddle notice a huddle service signed. */
export function isHuddleServiceNotice(
  message: { kind?: number; signerPubkey?: string; pubkey?: string },
  servicePubkeys: ReadonlySet<string>,
): boolean {
  const signer = (message.signerPubkey ?? message.pubkey ?? "").toLowerCase();
  return message.kind === KIND_HUDDLE_STARTED && servicePubkeys.has(signer);
}

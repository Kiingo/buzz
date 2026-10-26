import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Whether an agent message's surface card may be drawn (security review
 * S6): only in a 1:1 DM whose two members are the viewer and the signing
 * agent, and only when the agent's verified owner (its NIP-OA owner
 * attestation, `ownerPubkey` on the formatted message) is the viewer. A
 * self-published agent listing alone never counts. Anything else shows the
 * message text only.
 */
export function surfaceCardAllowed(input: {
  viewerPubkey: string | undefined;
  signerPubkey: string | undefined;
  verifiedOwnerPubkey: string | null | undefined;
  memberPubkeys: readonly string[] | undefined;
}): boolean {
  const viewer = normalizePubkey(input.viewerPubkey ?? "");
  const signer = normalizePubkey(input.signerPubkey ?? "");
  const owner = normalizePubkey(input.verifiedOwnerPubkey ?? "");
  if (!viewer || !signer || viewer === signer || owner !== viewer) {
    return false;
  }
  const members = new Set(
    (input.memberPubkeys ?? []).map((pubkey) => normalizePubkey(pubkey)),
  );
  return members.size === 2 && members.has(viewer) && members.has(signer);
}

const HEX_KEY = /^[0-9a-f]{64}$/;

/**
 * Whether the surface belongs to the agent that signed the message (§7.4
 * S-b): the host's surface record names the agent's bound Buzz key
 * (`agent.buzzPubkey`), and it must be the message's signer. A missing or
 * malformed key never matches, so another agent's surface id pasted into a
 * marker shows no card.
 */
export function surfaceFromSigner(
  named: string | undefined,
  signer: string | undefined,
): boolean {
  const key = normalizePubkey(named ?? "");
  return HEX_KEY.test(key) && key === normalizePubkey(signer ?? "");
}

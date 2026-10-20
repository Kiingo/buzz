import type { KeyReplacementStatus } from "./keyReplacement";

const HEX_64 = /^[0-9a-f]{64}$/i;

/**
 * The two keys to show when the control is offered, or null. The native
 * check decides `offer` (relay owner or admin, a replaced key on record, not
 * yet archived); this also refuses a malformed or self-referencing answer so
 * the control never names a key it could not sign for.
 */
export function offeredReplacement(
  status: KeyReplacementStatus | undefined,
): { old: string; current: string } | null {
  if (!status?.offer || !status.replacement) return null;
  const old = status.replacement.oldPublicKey.toLowerCase();
  const current = status.currentPublicKey.toLowerCase();
  if (!HEX_64.test(old) || !HEX_64.test(current) || old === current) {
    return null;
  }
  return { old, current };
}

/**
 * The removal step to show, or null when the provider names no retired key.
 * A malformed key or one equal to the signed-in key is shown disabled, so
 * the step never targets a key it should not.
 */
export function offeredRemoval(
  status: KeyReplacementStatus | undefined,
): { publicKey: string; removable: boolean; reason: string | null } | null {
  const removal = status?.removal;
  if (!status || !removal) return null;
  const key = removal.publicKey.toLowerCase();
  if (!HEX_64.test(key)) return null;
  if (key === status.currentPublicKey.toLowerCase()) {
    return { publicKey: key, removable: false, reason: "is_current_key" };
  }
  return {
    publicKey: key,
    removable: removal.removable && removal.reason === null,
    reason: removal.reason ?? (removal.removable ? null : "not_owner"),
  };
}

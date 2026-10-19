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

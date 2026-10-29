/**
 * Plain words for a remote agent change the server would not accept as the
 * owner's. A hosted provision counts as the owner's only with a fresh owner
 * proof that Buzz signs; the provider reports the refusal as a code at the
 * end of its error text, e.g. "... (buzz_hosted_owner_proof_required)".
 */
const OWNER_PROOF_FAILURES: [RegExp, string][] = [
  [
    /\bbuzz_hosted_owner_proof_required\b/,
    "Buzz couldn't confirm this change came from you. Update Buzz and try again.",
  ],
  [
    /\bbuzz_hosted_owner_proof_(?:invalid|replayed)\b/,
    "Buzz couldn't confirm this change came from you. Check that your computer's clock is set correctly, then try again.",
  ],
];

/** The plain message for an owner-proof refusal, or null for anything else. */
export function describeOwnerProofFailure(message: string): string | null {
  for (const [pattern, text] of OWNER_PROOF_FAILURES) {
    if (pattern.test(message)) return text;
  }
  return null;
}

/** A provider deploy error as the person should read it. */
export function friendlyProviderDeployError(message: string): string {
  return describeOwnerProofFailure(message) ?? message;
}

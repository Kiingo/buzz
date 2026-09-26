/**
 * Relay rejection messages that mean this identity is not admitted to the
 * community. Onboarding routes these to the membership-denied screen, which
 * shows the pubkey an admin must approve.
 *
 * `restricted: pubkey not allowlisted` is the relay's definitive pubkey
 * allowlist denial. `auth-required: verification failed` is deliberately
 * absent: it also covers clock skew and fail-closed allowlist lookup errors,
 * which can clear on retry (see relayAuthPolicy.ts).
 */
const RELAY_MEMBERSHIP_DENIED_MESSAGES = [
  "You must be a relay member",
  "relay_membership_required",
  "restricted: not a relay member",
  "restricted: pubkey not allowlisted",
  "invalid: you are not a relay member",
];

export function isRelayMembershipDeniedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return RELAY_MEMBERSHIP_DENIED_MESSAGES.some((message) =>
    error.message.includes(message),
  );
}

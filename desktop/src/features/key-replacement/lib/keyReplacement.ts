import { invokeTauri } from "@/shared/api/tauri";

/** Shared by both Profile settings steps so one check serves both. */
export const keyReplacementStatusQueryKey = [
  "key-replacement",
  "status",
] as const;

/** The earlier key the hosted service verified for the same person. */
export type Replacement = {
  oldPublicKey: string;
  revokedAt: string | null;
};

/** The "Remove old owner key" step, as the native check decided it. */
export type RemovalStep = {
  publicKey: string;
  removable: boolean;
  /** `is_current_key`, `not_owner`, `not_a_member` or `is_owner`. */
  reason: string | null;
};

/** Whether to offer "Confirm key replacement", and for which keys. */
export type KeyReplacementStatus = {
  offer: boolean;
  currentPublicKey: string;
  replacement: Replacement | null;
  removal: RemovalStep | null;
};

/** Result of the one remove-member request. */
export type RemovalOutcome = {
  accepted: boolean;
  message: string;
  removed: boolean;
};

/** Result of the one archive request. */
export type KeyReplacementOutcome = {
  accepted: boolean;
  message: string;
  confirmed: boolean;
};

type Transport = {
  status: () => Promise<KeyReplacementStatus>;
  confirm: (expectedOldPublicKey: string) => Promise<KeyReplacementOutcome>;
  confirmed: (oldPublicKey: string) => Promise<boolean>;
  remove: (expectedPublicKey: string) => Promise<RemovalOutcome>;
  removed: (publicKey: string) => Promise<boolean>;
};

const tauriTransport: Transport = {
  status: () => invokeTauri<KeyReplacementStatus>("key_replacement_status"),
  confirm: (expectedOldPublicKey) =>
    invokeTauri<KeyReplacementOutcome>("confirm_key_replacement", {
      expectedOldPublicKey,
    }),
  confirmed: (oldPublicKey) =>
    invokeTauri<boolean>("key_replacement_confirmed", { oldPublicKey }),
  remove: (expectedPublicKey) =>
    invokeTauri<RemovalOutcome>("remove_old_owner_key", { expectedPublicKey }),
  removed: (publicKey) =>
    invokeTauri<boolean>("old_owner_key_removed", { publicKey }),
};

let transport: Transport = tauriTransport;

/** Test seam: replace the native transport. Returns a restore function. */
export function setKeyReplacementTransportForTests(next: Partial<Transport>) {
  const previous = transport;
  transport = { ...transport, ...next };
  return () => {
    transport = previous;
  };
}

/** A failed check or request: its code. */
export class KeyReplacementError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(describeKeyReplacementError(code));
    this.name = "KeyReplacementError";
    this.code = code;
  }
}

/** Parse a native command rejection (`{"error": code}` or plain text). */
export function toKeyReplacementError(error: unknown): KeyReplacementError {
  if (error instanceof KeyReplacementError) return error;
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed && typeof parsed.error === "string") {
      return new KeyReplacementError(parsed.error);
    }
  } catch {
    // Not a structured error.
  }
  return new KeyReplacementError("request_failed");
}

/** One sentence for a failed check or request. */
export function describeKeyReplacementError(code: string): string {
  switch (code.replace(/^buzz_hosted_/, "")) {
    case "key_replacement_not_admin":
      return "Only a relay owner or admin can confirm a key replacement.";
    case "key_replacement_none":
      return "There is no earlier key to confirm for your account.";
    case "key_replacement_changed":
      return "The earlier key on record changed, so nothing was signed; check again.";
    case "key_replacement_already_archived":
      return "The relay already archived that key without your current key as its replacement; contact support.";
    case "removal_not_owner":
      return "Only the relay owner can remove the old owner key.";
    case "removal_none":
      return "There is no old owner key to remove.";
    case "removal_changed":
      return "The old owner key on record changed, so nothing was signed; check again.";
    case "removal_is_current_key":
      return "That key is the one you're signed in with, so it can't be removed here.";
    case "removal_not_a_member":
      return "The relay no longer lists that key as a member.";
    case "removal_is_owner":
      return "The relay still lists that key as an owner, so it can't be removed here.";
    case "relay_unreachable":
    case "relay_identity_unavailable":
      return "Couldn't reach the relay; check your connection and try again.";
    case "hosted_agents_unreachable":
    case "hosted_agents_timeout":
      return "Couldn't reach the hosted service; check your connection and try again.";
    case "owner_proof_invalid":
      return "Your signature wasn't accepted; check this computer's date and time, then try again.";
    case "owner_not_linked":
      return "Your current key isn't linked to your account yet; link it, then try again.";
    case "rate_limited":
      return "Too many requests; wait a moment and try again.";
    case "response_invalid":
    case "response_too_large":
      return "The hosted service sent an answer Buzz doesn't understand.";
    case "key_replacement_unavailable":
      return "Confirming a key replacement isn't available in this build or community.";
    default:
      return "Buzz couldn't confirm the key replacement; try again.";
  }
}

/** Plain words for the result of the archive request. */
export function describeOutcome(outcome: KeyReplacementOutcome): string {
  if (outcome.confirmed) {
    return "Confirmed: the relay now lists your earlier key as replaced by your current key.";
  }
  if (outcome.accepted) {
    return "The relay accepted the request, but it doesn't show the replacement yet; check again in a moment.";
  }
  return outcome.message
    ? `The relay didn't accept the request: ${outcome.message}`
    : "The relay didn't accept the request.";
}

export const keyReplacementApi = {
  /** Check the three conditions; read-only. */
  status: async () => {
    try {
      return await transport.status();
    } catch (error) {
      throw toKeyReplacementError(error);
    }
  },

  /**
   * Sign and publish one archive of `expectedOldPublicKey`, replaced by the
   * signed-in key. Only the confirm button calls this; the native side
   * re-checks everything and signs nothing if the earlier key changed.
   */
  confirm: async (expectedOldPublicKey: string) => {
    if (!/^[0-9a-f]{64}$/i.test(expectedOldPublicKey)) {
      throw new KeyReplacementError("key_replacement_changed");
    }
    try {
      return await transport.confirm(expectedOldPublicKey);
    } catch (error) {
      throw toKeyReplacementError(error);
    }
  },

  /** Re-read whether the relay shows the replacement; read-only. */
  confirmed: async (oldPublicKey: string) => {
    try {
      return await transport.confirmed(oldPublicKey);
    } catch (error) {
      throw toKeyReplacementError(error);
    }
  },

  /**
   * Remove exactly `expectedPublicKey` from the relay. Only the "Remove old
   * owner key" confirm button calls this; the native side re-checks every
   * condition and signs nothing if any disagrees.
   */
  remove: async (expectedPublicKey: string) => {
    if (!/^[0-9a-f]{64}$/i.test(expectedPublicKey)) {
      throw new KeyReplacementError("removal_changed");
    }
    try {
      return await transport.remove(expectedPublicKey);
    } catch (error) {
      throw toKeyReplacementError(error);
    }
  },

  /** Re-read whether the relay still lists the key; read-only. */
  removed: async (publicKey: string) => {
    try {
      return await transport.removed(publicKey);
    } catch (error) {
      throw toKeyReplacementError(error);
    }
  },
};

/** Why the removal step is disabled, in one sentence. */
export function describeRemovalReason(reason: string | null): string | null {
  return reason ? describeKeyReplacementError(`removal_${reason}`) : null;
}

/** Plain words for the result of the remove-member request. */
export function describeRemovalOutcome(outcome: RemovalOutcome): string {
  if (outcome.removed) {
    return "Removed: the relay no longer lists the old owner key.";
  }
  if (outcome.accepted) {
    return "The relay accepted the request, but it still lists the key; check again in a moment.";
  }
  return outcome.message
    ? `The relay didn't accept the request: ${outcome.message}`
    : "The relay didn't accept the request.";
}

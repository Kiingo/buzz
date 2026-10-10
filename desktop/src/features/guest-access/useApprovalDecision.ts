import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { sendAgentObserverControl } from "@/shared/api/observerRelay";

import { guestAccessApi, toGuestAccessError } from "./lib/client";
import { recordApprovalResolved } from "./lib/store";
import type { ApprovalDecision, GrantScope, GuestApproval } from "./lib/wire";

export type DecisionInput = {
  decision: ApprovalDecision;
  editedText?: string;
  grant?: { scope: GrantScope; days?: number } | null;
};

type Deps = {
  decide: typeof guestAccessApi.decide;
  sendControl: (agentPubkey: string, payload: unknown) => Promise<void>;
  resolved: (approvalId: string) => void;
};

/**
 * Record a decision. The decision API is the system of record and runs
 * first; only after it succeeds does the owner-signed control frame tell the
 * agent's harness to clear its pending state and publish at once. A failed
 * frame is harmless: the harness also polls its outbox and sees 46041.
 */
export async function submitApprovalDecision(
  approval: GuestApproval,
  input: DecisionInput,
  idempotencyKey: string,
  deps: Deps,
): Promise<{ alreadyDecided: boolean }> {
  let alreadyDecided = false;
  try {
    await deps.decide(approval.approvalId, {
      decision: input.decision,
      editedText: input.editedText,
      grant:
        input.decision === "approve" || input.decision === "approve_edited"
          ? (input.grant ?? null)
          : null,
      idempotencyKey,
    });
  } catch (error) {
    const routeError = toGuestAccessError(error);
    if (routeError.code !== "approval_already_decided") throw routeError;
    alreadyDecided = true;
  }
  deps.resolved(approval.approvalId);
  if (!alreadyDecided && approval.agent.pubkey) {
    const approving =
      input.decision === "approve" || input.decision === "approve_edited";
    await deps
      .sendControl(approval.agent.pubkey, {
        type: approving ? "approve_guest_reply" : "deny_guest_reply",
        approvalId: approval.approvalId,
        ...(approval.guestTurnId ? { guestTurnId: approval.guestTurnId } : {}),
      })
      .catch((error: unknown) => {
        console.debug("Guest approval control frame not delivered", error);
      });
  }
  return { alreadyDecided };
}

const defaultDeps: Deps = {
  decide: (...args) => guestAccessApi.decide(...args),
  sendControl: sendAgentObserverControl,
  resolved: recordApprovalResolved,
};

export function useApprovalDecision(approval: GuestApproval | null) {
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // One key per approval so a retry after a network error is idempotent.
  const keyRef = React.useRef<{ id: string; key: string } | null>(null);

  const submit = React.useCallback(
    async (input: DecisionInput) => {
      if (!approval) return null;
      if (keyRef.current?.id !== approval.approvalId) {
        keyRef.current = {
          id: approval.approvalId,
          key: `desktop:${approval.approvalId}:${crypto.randomUUID()}`,
        };
      }
      setIsPending(true);
      setError(null);
      try {
        const result = await submitApprovalDecision(
          approval,
          input,
          keyRef.current.key,
          defaultDeps,
        );
        void queryClient.invalidateQueries({ queryKey: ["guest-access"] });
        return result;
      } catch (cause) {
        setError(toGuestAccessError(cause).message);
        return null;
      } finally {
        setIsPending(false);
      }
    },
    [approval, queryClient],
  );

  return { submit, isPending, error };
}

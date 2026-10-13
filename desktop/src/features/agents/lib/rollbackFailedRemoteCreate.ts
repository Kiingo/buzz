import type { ProviderCreateRollback } from "./providerCreateApi";

/**
 * Undo a remote-backend agent create that did not start, so a failed create
 * never leaves a half-created agent behind.
 *
 * Order matters: the agent goes first, through the desktop's provider
 * rollback (confirmed remote delete, or a replay of the idempotent deploy
 * when the outcome is unknown). The definition created in the same flow goes
 * only after that, so a kept agent is never orphaned from its definition.
 * Every step treats "already gone" as success, so retrying a partial rollback
 * is safe.
 */

export type RollbackSteps = {
  /** Remove the agent locally and remotely, or keep it when unconfirmed. */
  rollbackAgent: (pubkey: string) => Promise<ProviderCreateRollback>;
  /** Delete the definition created in the same flow, if any. */
  deleteDefinition?: (definitionId: string) => Promise<void>;
};

/** What a failed create left behind, for a later retry. */
export type PendingCreateCleanup = {
  agentPubkey: string | null;
  definitionId: string | null;
};

export type RollbackResult = {
  /** True when nothing created by this flow is left behind. */
  clean: boolean;
  /** Plain-language detail for whatever could not be removed. */
  leftovers: string[];
  /** What is still there, so the next attempt can finish the cleanup. */
  remaining: PendingCreateCleanup | null;
};

const ALREADY_GONE =
  /\bnot found\b|\bno such\b|does not exist|already deleted/i;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function rollbackFailedRemoteCreate(
  created: PendingCreateCleanup,
  steps: RollbackSteps,
): Promise<RollbackResult> {
  const leftovers: string[] = [];
  let agentPubkey = created.agentPubkey;
  if (agentPubkey) {
    try {
      const outcome = await steps.rollbackAgent(agentPubkey);
      if (outcome.status === "kept") {
        leftovers.push(`the agent (${outcome.reason})`);
      } else {
        agentPubkey = null;
      }
    } catch (error) {
      const message = messageOf(error);
      if (ALREADY_GONE.test(message)) agentPubkey = null;
      else leftovers.push(`the agent (${message})`);
    }
  }
  let definitionId = created.definitionId;
  if (definitionId && steps.deleteDefinition && agentPubkey === null) {
    try {
      await steps.deleteDefinition(definitionId);
      definitionId = null;
    } catch (error) {
      const message = messageOf(error);
      if (ALREADY_GONE.test(message)) definitionId = null;
      else leftovers.push(`its definition (${message})`);
    }
  }
  const clean = agentPubkey === null && definitionId === null;
  return {
    clean,
    leftovers,
    remaining: clean ? null : { agentPubkey, definitionId },
  };
}

/** The message shown in the create dialog after a failed remote start. */
export function failedRemoteCreateMessage(
  agentName: string,
  startError: string,
  rollback: RollbackResult,
  options: { submitLabel?: string; retriesCleanup?: boolean } = {},
): string {
  const base = `${agentName} couldn't start: ${startError}`;
  if (rollback.clean) {
    return `${base} Nothing was kept, so you can fix this and try again.`;
  }
  const kept = `${base} Buzz couldn't remove ${rollback.leftovers.join(" or ")}, so it kept them.`;
  return options.retriesCleanup === false
    ? `${kept} Delete ${agentName} from Agents before trying again.`
    : `${kept} Press ${options.submitLabel ?? "Create agent"} again to retry the cleanup first.`;
}

/** The message shown when a retried cleanup still could not finish. */
export function pendingCleanupMessage(rollback: RollbackResult): string {
  return `Buzz still couldn't remove ${rollback.leftovers.join(" or ")} from the last attempt, so nothing new was created. Try again in a moment.`;
}

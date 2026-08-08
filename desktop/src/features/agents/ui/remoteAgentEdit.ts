import type {
  ManagedAgent,
  RespondToMode,
  UpdateManagedAgentInput,
} from "@/shared/api/types";
import {
  canSubmitWhereToRun,
  resolveBackendIntent,
  type WhereToRunDraft,
} from "./whereToRunIntent";

export function remoteDraftForAgent(agent: ManagedAgent): WhereToRunDraft {
  if (agent.backend.type !== "provider") {
    return { runOn: "local", providerConfig: {}, probedProvider: null };
  }
  return {
    runOn: agent.backend.id,
    providerConfig: Object.fromEntries(
      Object.entries(agent.backend.config).map(([key, value]) => [
        key,
        value == null ? "" : String(value),
      ]),
    ),
    probedProvider: null,
  };
}

export function canSubmitRemoteAgentEdit(input: {
  name: string;
  draft: WhereToRunDraft;
  respondTo: RespondToMode;
  allowlistLength: number;
  isPending: boolean;
  isAvatarUploadPending: boolean;
}): boolean {
  return (
    input.name.trim().length > 0 &&
    canSubmitWhereToRun(input.draft) &&
    (input.respondTo !== "allowlist" || input.allowlistLength > 0) &&
    !input.isPending &&
    !input.isAvatarUploadPending
  );
}

type RemoteEditResult = {
  agent: ManagedAgent;
  profileSyncError: string | null;
};

export async function submitRemoteAgentEdit(input: {
  agent: ManagedAgent;
  draft: WhereToRunDraft;
  name: string;
  respondTo: RespondToMode;
  respondToAllowlist: string[];
  update: (request: UpdateManagedAgentInput) => Promise<RemoteEditResult>;
}): Promise<{ result: RemoteEditResult; backendChanged: boolean } | null> {
  const backend = resolveBackendIntent(input.draft);
  if (!backend) {
    throw new Error("Hosted execution settings are unavailable.");
  }
  const currentConfig =
    input.agent.backend.type === "provider" ? input.agent.backend.config : {};
  const backendChanged =
    JSON.stringify(backend.config) !== JSON.stringify(currentConfig);
  if (
    backendChanged &&
    !window.confirm(
      "Change this hosted agent's harness or model for future messages? A message already being processed will finish with its current settings.",
    )
  ) {
    return null;
  }
  const request: UpdateManagedAgentInput = {
    pubkey: input.agent.pubkey,
    name:
      input.name.trim() !== input.agent.name ? input.name.trim() : undefined,
    backend: backendChanged ? backend : undefined,
    respondTo:
      input.respondTo !== input.agent.respondTo ? input.respondTo : undefined,
    respondToAllowlist:
      input.respondTo === "allowlist" &&
      input.respondToAllowlist.join(",") !==
        input.agent.respondToAllowlist.join(",")
        ? input.respondToAllowlist
        : undefined,
  };
  return { result: await input.update(request), backendChanged };
}

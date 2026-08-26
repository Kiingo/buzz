import type { AgentPersona, CreateManagedAgentInput } from "@/shared/api/types";
import {
  resolveManagedAgentAvatarUrl,
  type UploadMediaBytes,
} from "../ui/managedAgentAvatar";
import type { BackendIntent } from "./instanceInputForDefinition";

/** Map a definition to a remote instance without requiring a desktop runtime. */
export async function buildProviderOwnedInstanceInput(
  persona: AgentPersona,
  backendIntent: BackendIntent,
  upload?: UploadMediaBytes,
): Promise<CreateManagedAgentInput> {
  const avatarUrl = await resolveManagedAgentAvatarUrl(
    persona.avatarUrl,
    upload,
  );
  return {
    name: persona.displayName,
    personaId: persona.id,
    systemPrompt: persona.systemPrompt,
    avatarUrl,
    harnessOverride: false,
    spawnAfterCreate: true,
    startOnAppLaunch: false,
    backend: {
      type: "provider",
      id: backendIntent.id,
      config: backendIntent.config,
    },
  };
}

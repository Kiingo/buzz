import type { WhereToRunDraft } from "./whereToRunIntent";

/**
 * Whether the selected backend is the sole authority for harness/model/provider
 * configuration. Only a successfully probed schema can opt into this mode;
 * absent, malformed, and non-boolean values fail closed to local ownership.
 */
export function providerOwnsExecutionProfile(draft: WhereToRunDraft): boolean {
  return (
    draft.runOn !== "local" &&
    draft.probedProvider?.config_schema?.["x-buzz-owns-execution-profile"] ===
      true
  );
}

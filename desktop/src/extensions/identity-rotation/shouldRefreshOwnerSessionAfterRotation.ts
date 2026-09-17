type RotationMode = "human" | "agent" | "all";

export function shouldRefreshOwnerSessionAfterRotation(
  complete: boolean,
  mode: RotationMode | null | undefined,
): boolean {
  return complete && (mode === "human" || mode === "all");
}

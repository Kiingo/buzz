import { invokeTauri } from "@/shared/api/tauri";

export function getCodexEnrollmentUrl(): Promise<string | null> {
  return invokeTauri<string | null>("get_codex_enrollment_url");
}

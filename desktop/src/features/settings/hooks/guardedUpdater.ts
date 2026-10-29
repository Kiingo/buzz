import { invokeTauri } from "@/shared/api/tauri";

/**
 * The in-app updater, through the app's own Rust commands
 * (79 LOW-BUZZ-UPDATER-JS-DOWNGRADE). The webview has no updater plugin
 * permissions, so it cannot call the plugin's `check({ allowDowngrades })`;
 * every check, download and install goes through `updater_guard` in Rust,
 * which accepts only strictly newer releases signed after this build.
 */
export type GuardedUpdate = {
  version: string;
  download: () => Promise<void>;
  install: () => Promise<void>;
  close: () => Promise<void>;
};

type GuardedUpdateInfo = {
  id: number;
  version: string;
  currentVersion: string;
};

/** Check the feed (uncached); `null` when nothing newer passes the guard. */
export async function checkForGuardedUpdate(): Promise<GuardedUpdate | null> {
  const info = await invokeTauri<GuardedUpdateInfo | null>("updater_check");
  if (!info) {
    return null;
  }
  const { id } = info;
  return {
    version: info.version,
    download: () => invokeTauri<void>("updater_download", { id }),
    install: () => invokeTauri<void>("updater_install", { id }),
    close: () => invokeTauri<void>("updater_close", { id }),
  };
}

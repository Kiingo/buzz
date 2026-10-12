/**
 * Install-time freshness for the in-app updater.
 *
 * A background check downloads an update and parks it as "ready" until the
 * user clicks Restart to update, and no further background checks run while
 * an update is ready. If newer releases ship in the meantime, installing the
 * parked download would move the user to an already-superseded version (seen
 * in practice: kiingo.5 → kiingo.6 while the feed served kiingo.8). Before
 * installing, re-check the feed and swap in the newest release.
 */

/** The parts of a Tauri updater `Update` this logic needs. */
export type UpdateHandle = {
  version: string;
  download: () => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Return the update to install: the parked download when the feed still
 * serves that version (or cannot be reached), otherwise the feed's newer
 * release, downloaded first. Superseded handles are closed.
 */
export async function freshestDownloadedUpdate<T extends UpdateHandle>(
  downloaded: T,
  deps: {
    check: () => Promise<T | null>;
    onDownloading?: (version: string) => void;
  },
): Promise<T> {
  let latest: T | null;
  try {
    latest = await deps.check();
  } catch {
    // Offline or feed error: the parked download is still a valid,
    // signature-checked update, so install it rather than fail.
    return downloaded;
  }
  // `null` means nothing newer than the running app, which cannot make the
  // parked download stale.
  if (!latest) return downloaded;
  if (latest.version === downloaded.version) {
    await latest.close().catch(() => undefined);
    return downloaded;
  }
  deps.onDownloading?.(latest.version);
  await latest.download();
  await downloaded.close().catch(() => undefined);
  return latest;
}

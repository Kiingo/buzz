//! The in-app updater's only entry points (79 LOW-BUZZ-UPDATER-JS-DOWNGRADE).
//!
//! The plugin's own `check` command accepts `allowDowngrades`, which replaces
//! the version comparator, so a webview could install an older signed build.
//! The webview therefore has no updater plugin permissions
//! (`capabilities/default.json`); it checks, downloads and installs only
//! through these commands. Each one builds the updater from the registered
//! plugin state, whose comparator is `updater_guard::accept_update`, and
//! applies the same guard again to the resulting update before handing it out,
//! downloading it or installing it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::updater_guard;

/// What the frontend's updater-unavailable branch matches when this build has
/// no updater plugin registered (debug or unconfigured builds).
const UPDATER_UNAVAILABLE: &str = "plugin updater not found";

/// Same condition `lib.rs` registers the updater plugin under; without the
/// plugin its state is absent and `updater_builder` would panic.
fn updater_registered() -> bool {
    cfg!(buzz_updater_enabled) && !cfg!(debug_assertions)
}

struct PendingUpdate {
    update: Update,
    bytes: Option<Vec<u8>>,
}

/// Updates a check returned, by handle, until installed or closed.
#[derive(Default)]
pub struct GuardedUpdates {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, PendingUpdate>>,
}

impl GuardedUpdates {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<u64, PendingUpdate>>, String> {
        self.pending
            .lock()
            .map_err(|_| "updater state is unavailable".to_string())
    }

    fn update(&self, id: u64) -> Result<Update, String> {
        self.lock()?
            .get(&id)
            .map(|pending| pending.update.clone())
            .ok_or_else(|| "update handle is no longer available".to_string())
    }
}

/// A newer release the guard accepted.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardedUpdateInfo {
    id: u64,
    version: String,
    current_version: String,
}

fn guard(update: &Update) -> Result<(), String> {
    match updater_guard::update_refusal_for(update) {
        None => Ok(()),
        Some(reason) => Err(format!("update refused: {reason}")),
    }
}

/// Check the feed (uncached). `None` when nothing newer passes the guard.
#[tauri::command]
pub async fn updater_check(
    app: AppHandle,
    updates: State<'_, GuardedUpdates>,
) -> Result<Option<GuardedUpdateInfo>, String> {
    if !updater_registered() {
        return Err(UPDATER_UNAVAILABLE.to_string());
    }
    let updater = app
        .updater_builder()
        .header("Cache-Control", "no-cache")
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    if let Some(reason) = updater_guard::update_refusal_for(&update) {
        tracing::warn!(event = "update_refused", %reason, "refused a checked update");
        return Ok(None);
    }
    let id = updates.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let info = GuardedUpdateInfo {
        id,
        version: update.version.clone(),
        current_version: update.current_version.clone(),
    };
    updates.lock()?.insert(
        id,
        PendingUpdate {
            update,
            bytes: None,
        },
    );
    Ok(Some(info))
}

/// Download and verify the update's archive, keeping it for install.
#[tauri::command]
pub async fn updater_download(updates: State<'_, GuardedUpdates>, id: u64) -> Result<(), String> {
    let update = updates.update(id)?;
    guard(&update)?;
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    let mut pending = updates.lock()?;
    let entry = pending
        .get_mut(&id)
        .ok_or_else(|| "update handle is no longer available".to_string())?;
    entry.bytes = Some(bytes);
    Ok(())
}

/// Install a downloaded update. The caller relaunches afterwards.
#[tauri::command]
pub async fn updater_install(updates: State<'_, GuardedUpdates>, id: u64) -> Result<(), String> {
    let (update, bytes) = {
        let mut pending = updates.lock()?;
        let entry = pending
            .remove(&id)
            .ok_or_else(|| "update handle is no longer available".to_string())?;
        let Some(bytes) = entry.bytes else {
            pending.insert(id, entry);
            return Err("the update has not been downloaded".to_string());
        };
        (entry.update, bytes)
    };
    guard(&update)?;
    update.install(bytes).map_err(|error| error.to_string())
}

/// Forget an update handle and any downloaded archive.
#[tauri::command]
pub fn updater_close(updates: State<'_, GuardedUpdates>, id: u64) -> Result<(), String> {
    updates.lock()?.remove(&id);
    Ok(())
}

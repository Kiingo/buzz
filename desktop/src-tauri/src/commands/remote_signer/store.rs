//! Device-local remote-signer state: the master switch, consent scopes and
//! the signing log, one entry per community and identity.
//!
//! Scopes are created only from the consent prompt on this device and are
//! never received from the broker. Nothing here holds key material or
//! signatures.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::validate::{Operation, ValidatedRequest, PUBLISH_KINDS};

pub(crate) const STORE_FILE: &str = "remote-signer.json";
const MAX_LOG_ENTRIES: usize = 200;
/// Scope lifetimes the prompt offers: 15 minutes, 1 hour, 8 hours.
pub(crate) const SCOPE_DURATIONS_MINUTES: [u32; 3] = [15, 60, 480];

/// What a scope lets Desktop approve without asking.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ScopeKind {
    /// Publish these kinds in one channel.
    Publish,
    /// Authorize reads in one channel, or in all channels when
    /// `channel_id` is `None`.
    Read,
}

/// A time-boxed consent created on this device.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Scope {
    /// Sent back as `decision_source: "scope:<id>"`.
    pub id: String,
    pub kind: ScopeKind,
    /// Publish kinds covered (empty for reads).
    #[serde(default)]
    pub kinds: Vec<u16>,
    /// `None` only for an all-channels read scope.
    pub channel_id: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds.
    pub expires_at: i64,
}

impl Scope {
    pub(crate) fn is_active(&self, now_ms: i64) -> bool {
        self.expires_at > now_ms
    }

    /// Whether this scope approves the request. Publish scopes need the
    /// event's own `h` tag to be the scope channel; read scopes need every
    /// filter bound to the scope channel unless they cover all channels.
    pub(crate) fn covers(&self, request: &ValidatedRequest, now_ms: i64) -> bool {
        if !self.is_active(now_ms) {
            return false;
        }
        match (&self.kind, &request.operation) {
            (
                ScopeKind::Publish,
                Operation::Publish {
                    event, channel_id, ..
                },
            ) => {
                let kind = event.kind.as_u16();
                self.channel_id.is_some()
                    && channel_id.as_deref() == self.channel_id.as_deref()
                    && self.kinds.contains(&kind)
                    && PUBLISH_KINDS.contains(&kind)
            }
            (ScopeKind::Read, Operation::Query { channel_id, .. }) => match &self.channel_id {
                None => true,
                Some(scope_channel) => channel_id.as_deref() == Some(scope_channel.as_str()),
            },
            _ => false,
        }
    }
}

/// One line of the local signing log. No signatures, no content.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogEntry {
    /// Unix milliseconds.
    pub at: i64,
    pub request_id: Option<String>,
    pub action: String,
    pub channel_id: Option<String>,
    /// `prompt`, `scope:<id>`, or `automatic` for refusals and expiries.
    pub decision: String,
    /// `signed`, `declined`, `refused`, `expired`, `cancelled` or `failed`.
    pub outcome: String,
    /// Published event id for signed publishes.
    pub event_id: Option<String>,
    /// Refusal or failure code.
    pub detail: Option<String>,
}

/// State for one community and identity.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileState {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub scopes: Vec<Scope>,
    #[serde(default)]
    pub log: Vec<LogEntry>,
}

impl ProfileState {
    pub(crate) fn active_scopes(&self, now_ms: i64) -> Vec<Scope> {
        self.scopes
            .iter()
            .filter(|scope| scope.is_active(now_ms))
            .cloned()
            .collect()
    }

    pub(crate) fn matching_scope(&self, request: &ValidatedRequest, now_ms: i64) -> Option<Scope> {
        self.scopes
            .iter()
            .find(|scope| scope.covers(request, now_ms))
            .cloned()
    }

    pub(crate) fn push_log(&mut self, entry: LogEntry) {
        self.log.insert(0, entry);
        self.log.truncate(MAX_LOG_ENTRIES);
    }

    fn prune(&mut self, now_ms: i64) {
        self.scopes.retain(|scope| scope.is_active(now_ms));
    }
}

/// The whole file, keyed by `<community id>|<pubkey hex>`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoreFile {
    #[serde(default)]
    pub profiles: BTreeMap<String, ProfileState>,
}

pub(crate) fn profile_key(community_id: &str, pubkey: &str) -> String {
    format!("{community_id}|{}", pubkey.to_ascii_lowercase())
}

pub(crate) fn store_path(data_dir: &Path) -> PathBuf {
    data_dir.join(STORE_FILE)
}

/// Read the store; a missing or unreadable file is an empty store (the
/// switch then reads as off, which is the safe default).
pub(crate) fn load(path: &Path) -> StoreFile {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Write the store atomically, dropping expired scopes.
pub(crate) fn save(path: &Path, store: &mut StoreFile, now_ms: i64) -> Result<(), String> {
    for profile in store.profiles.values_mut() {
        profile.prune(now_ms);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("store dir failed: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("store write failed: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("store rename failed: {e}"))
}

/// What the user picked in "Allow for…".
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScopeChoice {
    pub duration_minutes: u32,
    /// Publish scopes: the kinds to cover (must include the request's kind).
    #[serde(default)]
    pub kinds: Vec<u16>,
    /// Read scopes: true for all my channels, false for this channel.
    #[serde(default)]
    pub all_channels: bool,
}

/// Build a scope from the prompt's request and the user's choice, or refuse
/// a choice the request cannot support.
pub(crate) fn scope_for(
    request: &ValidatedRequest,
    choice: &ScopeChoice,
    now_ms: i64,
) -> Result<Scope, &'static str> {
    if !SCOPE_DURATIONS_MINUTES.contains(&choice.duration_minutes) {
        return Err("scope_duration_invalid");
    }
    let expires_at = now_ms + i64::from(choice.duration_minutes) * 60_000;
    let id = uuid::Uuid::new_v4().simple().to_string();
    match &request.operation {
        Operation::Publish {
            event, channel_id, ..
        } => {
            let channel_id = channel_id.clone().ok_or("scope_needs_channel")?;
            let kind = event.kind.as_u16();
            let mut kinds: Vec<u16> = choice
                .kinds
                .iter()
                .copied()
                .filter(|k| PUBLISH_KINDS.contains(k))
                .collect();
            if !kinds.contains(&kind) {
                kinds.push(kind);
            }
            kinds.sort_unstable();
            kinds.dedup();
            Ok(Scope {
                id,
                kind: ScopeKind::Publish,
                kinds,
                channel_id: Some(channel_id),
                created_at: now_ms,
                expires_at,
            })
        }
        Operation::Query { channel_id, .. } => {
            let channel_id = if choice.all_channels {
                None
            } else {
                Some(channel_id.clone().ok_or("scope_needs_channel")?)
            };
            Ok(Scope {
                id,
                kind: ScopeKind::Read,
                kinds: Vec::new(),
                channel_id,
                created_at: now_ms,
                expires_at,
            })
        }
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;

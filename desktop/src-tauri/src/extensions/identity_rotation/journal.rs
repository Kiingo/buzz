use std::{io::Write, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

pub(crate) const CONTRACT_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RotationMode {
    Human,
    Agent,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RotationAgentJournal {
    pub old_public_key: String,
    pub new_public_key: String,
    pub hosted: bool,
    pub provider_id: Option<String>,
    pub old_provider_agent_id: Option<String>,
    pub new_provider_agent_id: Option<String>,
    pub profile_verified: bool,
    #[serde(default)]
    pub profile_event_id: Option<String>,
    pub memory_heads_migrated: u32,
    pub memory_tombstones_preserved: u32,
    pub archive_verified: bool,
    #[serde(default)]
    pub archive_event_id: Option<String>,
    pub canary_verified: bool,
    #[serde(default)]
    pub local_runtime_was_running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ContinuityJournal {
    pub relay_memberships_verified: u32,
    pub channel_memberships_verified: u32,
    pub profiles_verified: u32,
    pub memory_heads_migrated: u32,
    pub memory_tombstones_preserved: u32,
    pub archive_pointers_verified: u32,
    #[serde(default)]
    pub owner_profile_verified: bool,
    #[serde(default)]
    pub owner_profile_event_id: Option<String>,
    #[serde(default)]
    pub owner_archive_verified: bool,
    #[serde(default)]
    pub owner_archive_event_id: Option<String>,
    pub evidence_sha256: Option<String>,
}

impl Default for ContinuityJournal {
    fn default() -> Self {
        Self {
            relay_memberships_verified: 0,
            channel_memberships_verified: 0,
            profiles_verified: 0,
            memory_heads_migrated: 0,
            memory_tombstones_preserved: 0,
            archive_pointers_verified: 0,
            owner_profile_verified: false,
            owner_profile_event_id: None,
            owner_archive_verified: false,
            owner_archive_event_id: None,
            evidence_sha256: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct IdentityRotationJournal {
    pub contract_version: u8,
    pub rotation_id: String,
    pub coordinator_origin: String,
    pub community_id: String,
    pub relay_url: String,
    pub mode: RotationMode,
    pub selected_agent_public_key: Option<String>,
    pub state: String,
    pub state_version: u32,
    pub challenge_expires_at: String,
    pub old_owner_public_key: String,
    pub new_owner_public_key: Option<String>,
    pub provider_id: String,
    pub resolve_path: String,
    pub prepare_path: String,
    pub advance_path: String,
    pub proof_kind: u16,
    pub proof_content: String,
    pub recovery_backup_verified: bool,
    pub agents: Vec<RotationAgentJournal>,
    pub continuity: ContinuityJournal,
    pub committed_locally: bool,
    pub old_authority_purged: bool,
    pub error_code: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl IdentityRotationJournal {
    pub(crate) fn is_terminal(&self) -> bool {
        matches!(self.state.as_str(), "complete" | "failed" | "aborted")
    }
}

fn journal_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("identity_rotation_app_data_unavailable: {error}"))?
        .join("identity-rotations");
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("identity_rotation_journal_unavailable: {error}"))?;
    Ok(root)
}

fn journal_path(app: &tauri::AppHandle, rotation_id: &str) -> Result<PathBuf, String> {
    let id = uuid::Uuid::parse_str(rotation_id)
        .map_err(|_| "identity_rotation_id_invalid".to_string())?;
    Ok(journal_root(app)?.join(format!("{id}.json")))
}

pub(crate) fn load(
    app: &tauri::AppHandle,
    rotation_id: &str,
) -> Result<Option<IdentityRotationJournal>, String> {
    let path = journal_path(app, rotation_id)?;
    match std::fs::read(&path) {
        Ok(bytes) => {
            let journal: IdentityRotationJournal = serde_json::from_slice(&bytes)
                .map_err(|_| "identity_rotation_journal_corrupt".to_string())?;
            if journal.contract_version != CONTRACT_VERSION || journal.rotation_id != rotation_id {
                return Err("identity_rotation_journal_corrupt".into());
            }
            Ok(Some(journal))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("identity_rotation_journal_unavailable: {error}")),
    }
}

pub(crate) fn save(
    app: &tauri::AppHandle,
    journal: &mut IdentityRotationJournal,
) -> Result<(), String> {
    journal.updated_at = chrono::Utc::now().to_rfc3339();
    validate_public_journal(journal)?;
    let path = journal_path(app, &journal.rotation_id)?;
    let payload = serde_json::to_vec_pretty(journal)
        .map_err(|error| format!("identity_rotation_journal_serialize_failed: {error}"))?;
    let mut file = atomic_write_file::AtomicWriteFile::open(&path)
        .map_err(|error| format!("identity_rotation_journal_unavailable: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("identity_rotation_journal_unavailable: {error}"))?;
    }
    file.write_all(&payload)
        .map_err(|error| format!("identity_rotation_journal_unavailable: {error}"))?;
    file.commit()
        .map_err(|error| format!("identity_rotation_journal_unavailable: {error}"))
}

pub(crate) fn latest_incomplete(
    app: &tauri::AppHandle,
) -> Result<Option<IdentityRotationJournal>, String> {
    let mut journals = Vec::new();
    for entry in std::fs::read_dir(journal_root(app)?)
        .map_err(|error| format!("identity_rotation_journal_unavailable: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("identity_rotation_journal_unavailable: {error}"))?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let bytes = std::fs::read(entry.path())
            .map_err(|error| format!("identity_rotation_journal_unavailable: {error}"))?;
        let journal: IdentityRotationJournal = serde_json::from_slice(&bytes)
            .map_err(|_| "identity_rotation_journal_corrupt".to_string())?;
        if !journal.is_terminal() {
            journals.push(journal);
        }
    }
    journals.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    if journals.len() > 1 {
        return Err("identity_rotation_multiple_incomplete".into());
    }
    Ok(journals.pop())
}

fn validate_public_journal(journal: &IdentityRotationJournal) -> Result<(), String> {
    let serialized = serde_json::to_string(journal)
        .map_err(|_| "identity_rotation_journal_serialize_failed".to_string())?;
    let lower = serialized.to_ascii_lowercase();
    if lower.contains("nsec1")
        || lower.contains("ncryptsec1")
        || lower.contains("private_key")
        || lower.contains("resume_token")
        || lower.contains("challenge\"")
        || lower.contains("password")
        || lower.contains("ciphertext")
    {
        return Err("identity_rotation_journal_contains_private_material".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_state_detection_is_explicit() {
        let mut journal: IdentityRotationJournal = serde_json::from_value(serde_json::json!({
            "contract_version": 1,
            "rotation_id": "20000000-0000-4000-8000-000000000001",
            "coordinator_origin": "https://api.example.com",
            "community_id": "chat.example.com",
            "relay_url": "wss://chat.example.com",
            "mode": "human",
            "selected_agent_public_key": null,
            "state": "planned",
            "state_version": 1,
            "challenge_expires_at": "2026-08-21T00:00:00Z",
            "old_owner_public_key": "a".repeat(64),
            "new_owner_public_key": null,
            "provider_id": "test",
            "resolve_path": "/resolve",
            "prepare_path": "/prepare",
            "advance_path": "/advance/{rotation_id}",
            "proof_kind": 27236,
            "proof_content": "buzz-identity-rotation-v1",
            "recovery_backup_verified": false,
            "agents": [],
            "continuity": ContinuityJournal::default(),
            "committed_locally": false,
            "old_authority_purged": false,
            "error_code": null,
            "created_at": "2026-08-21T00:00:00Z",
            "updated_at": "2026-08-21T00:00:00Z"
        }))
        .unwrap();
        assert!(!journal.is_terminal());
        journal.state = "complete".into();
        assert!(journal.is_terminal());
        assert!(validate_public_journal(&journal).is_ok());
        journal.state = "failed".into();
        assert!(journal.is_terminal());
        journal.state = "aborted".into();
        assert!(journal.is_terminal());
    }

    #[test]
    fn public_journal_rejects_every_private_material_family() {
        let base = serde_json::json!({
            "contract_version": 1,
            "rotation_id": "20000000-0000-4000-8000-000000000001",
            "coordinator_origin": "https://api.example.com",
            "community_id": "chat.example.com",
            "relay_url": "wss://chat.example.com",
            "mode": "agent",
            "selected_agent_public_key": "a".repeat(64),
            "state": "recoverable",
            "state_version": 3,
            "challenge_expires_at": "2026-08-21T00:00:00Z",
            "old_owner_public_key": "b".repeat(64),
            "new_owner_public_key": "b".repeat(64),
            "provider_id": "test",
            "resolve_path": "/resolve",
            "prepare_path": "/prepare",
            "advance_path": "/advance/{rotation_id}",
            "proof_kind": 27236,
            "proof_content": "buzz-identity-rotation-v1",
            "recovery_backup_verified": true,
            "agents": [],
            "continuity": ContinuityJournal::default(),
            "committed_locally": false,
            "old_authority_purged": false,
            "error_code": null,
            "created_at": "2026-08-21T00:00:00Z",
            "updated_at": "2026-08-21T00:00:00Z"
        });
        for secret in [
            "nsec1must-not-persist",
            "ncryptsec1must-not-persist",
            "private_key",
            "resume_token",
            "password",
            "ciphertext",
        ] {
            let mut value = base.clone();
            value["error_code"] = serde_json::Value::String(secret.into());
            let journal: IdentityRotationJournal = serde_json::from_value(value).unwrap();
            assert_eq!(
                validate_public_journal(&journal).unwrap_err(),
                "identity_rotation_journal_contains_private_material"
            );
        }
    }
}

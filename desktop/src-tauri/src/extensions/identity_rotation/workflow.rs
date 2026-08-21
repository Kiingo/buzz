use std::time::Duration;

use nostr::{Keys, ToBech32};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;

use crate::{
    app_state::{keyring_service, persist_imported_identity, AppState},
    managed_agents::{
        load_managed_agents, save_managed_agents, stop_managed_agent_process, try_delete_agent_key,
        BackendKind, ManagedAgentRecord,
    },
};

use super::{
    continuity::{
        archive_old_identities, clone_profiles, finalize_evidence, migrate_agent_memory,
        migrate_memberships, revoke_old_authorities, signed_owner_relay_canary, RotationIdentity,
    },
    crypto::{
        build_rotation_proof, compute_agent_auth_tag, load_agent_auth_tag, load_agent_keys,
        load_handoff_challenge, load_human_keys, load_resume_token, purge_staged_secrets,
        sha256_hex, stage_agent_keys, stage_human_keys, store_handoff_challenge,
        store_resume_token,
    },
    handoff::{IdentityRotationExtensionState, IdentityRotationHandoff},
    journal::{
        self, ContinuityJournal, IdentityRotationJournal, RotationAgentJournal, RotationMode,
    },
    provider::{discover_rotation_provider, prepare_identity_envelope, RotationProvider},
};

const MAX_COORDINATOR_RESPONSE: usize = 2 * 1024 * 1024;

async fn pick_recovery_backup_path(
    app: &tauri::AppHandle,
    suggested_filename: &str,
) -> Result<Option<std::path::PathBuf>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Password-protected Buzz identity backup", &["ncryptsec"])
        .set_file_name(suggested_filename)
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let selected = receiver
        .await
        .map_err(|_| "identity_rotation_recovery_backup_failed".to_string())?;
    selected
        .map(|path| {
            path.as_path()
                .map(std::path::Path::to_path_buf)
                .ok_or_else(|| "identity_rotation_recovery_backup_failed".to_string())
        })
        .transpose()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunIdentityRotationRequest {
    handoff_id: String,
    recovery_passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    rotation_id: &'a str,
    state: &'a str,
    message: &'a str,
    terminal: bool,
    error_code: Option<&'a str>,
}

fn emit_progress(
    app: &tauri::AppHandle,
    rotation_id: &str,
    state: &str,
    message: &str,
    terminal: bool,
    error_code: Option<&str>,
) {
    let _ = app.emit(
        "identity-rotation-progress",
        Progress {
            rotation_id,
            state,
            message,
            terminal,
            error_code,
        },
    );
}

#[derive(Debug, Clone, Deserialize)]
struct HostedInventory {
    public_key: String,
    provider_agent_id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Inventory {
    hosted_agents: Vec<HostedInventory>,
}

#[derive(Debug, Clone, Deserialize)]
struct DesktopPlan {
    contract_version: u8,
    rotation_id: String,
    mode: RotationMode,
    community_id: String,
    relay_url: String,
    old_owner_public_key: String,
    selected_agent_public_key: Option<String>,
    challenge_expires_at: String,
    inventory: Inventory,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct RotationItemStatus {
    old_public_key: String,
    new_public_key: Option<String>,
    hosted: bool,
    old_provider_agent_id: Option<String>,
    new_provider_agent_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct CoordinatorStatus {
    contract_version: u8,
    rotation_id: String,
    mode: RotationMode,
    state: String,
    state_version: u32,
    old_owner_public_key: String,
    new_owner_public_key: Option<String>,
    items: Vec<RotationItemStatus>,
}

#[derive(Debug, Deserialize)]
struct PrepareResponse {
    resume_token: String,
    status: CoordinatorStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdentityRotationPreview {
    mode: RotationMode,
    managed_agent_count: usize,
    hosted_agent_count: usize,
    agent_names: Vec<String>,
    recovery_backup_required: bool,
}

fn endpoint(origin: &str, path: &str, rotation_id: &str) -> Result<String, String> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains(['?', '#']) {
        return Err("identity_rotation_provider_contract_invalid".into());
    }
    Ok(format!(
        "{}{}",
        origin.trim_end_matches('/'),
        path.replace("{rotation_id}", rotation_id)
    ))
}

fn coordinator_error(status: reqwest::StatusCode, value: Option<&Value>) -> String {
    let code = value
        .and_then(|body| body.get("error").or_else(|| body.get("code")))
        .and_then(Value::as_str)
        .filter(|code| is_public_rotation_error_code(code));
    code.map(str::to_string)
        .unwrap_or_else(|| format!("identity_rotation_coordinator_http_{}", status.as_u16()))
}

fn is_public_rotation_error_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 96
        && (code.starts_with("identity_rotation_") || code.starts_with("buzz_identity_rotation_"))
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn public_rotation_error_code(error: &str) -> String {
    if is_public_rotation_error_code(error) {
        error.to_string()
    } else {
        "identity_rotation_internal".into()
    }
}

async fn post_json(state: &AppState, url: String, body: &Value) -> Result<Value, String> {
    let response = state
        .http_client
        .post(url)
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|_| "identity_rotation_coordinator_unreachable".to_string())?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "identity_rotation_coordinator_response_invalid".to_string())?;
    if bytes.len() > MAX_COORDINATOR_RESPONSE {
        return Err("identity_rotation_coordinator_response_too_large".into());
    }
    let value: Option<Value> = serde_json::from_slice(&bytes).ok();
    if !status.is_success() {
        return Err(coordinator_error(status, value.as_ref()));
    }
    value.ok_or_else(|| "identity_rotation_coordinator_response_invalid".to_string())
}

async fn resolve_plan(
    state: &AppState,
    provider: &RotationProvider,
    rotation_id: &str,
    challenge: &str,
    allow_expired: bool,
) -> Result<DesktopPlan, String> {
    let value = post_json(
        state,
        endpoint(
            &provider.coordinator_origin,
            &provider.resolve_path,
            rotation_id,
        )?,
        &json!({
            "contract_version": 1,
            "rotation_id": rotation_id,
            "challenge": challenge
        }),
    )
    .await?;
    let plan: DesktopPlan =
        serde_json::from_value(value).map_err(|_| "identity_rotation_plan_invalid".to_string())?;
    let expires = chrono::DateTime::parse_from_rfc3339(&plan.challenge_expires_at)
        .map_err(|_| "identity_rotation_plan_invalid".to_string())?;
    let relay = url::Url::parse(&plan.relay_url)
        .map_err(|_| "identity_rotation_plan_invalid".to_string())?;
    if plan.contract_version != 1
        || plan.rotation_id != rotation_id
        || plan.community_id.is_empty()
        || relay.scheme() != "wss"
        || relay.host_str() != Some(plan.community_id.as_str())
        || !relay.username().is_empty()
        || relay.password().is_some()
        || relay.query().is_some()
        || relay.fragment().is_some()
        || (!allow_expired && expires < chrono::Utc::now())
    {
        return Err("identity_rotation_plan_invalid".into());
    }
    Ok(plan)
}

#[tauri::command]
pub(crate) async fn inspect_identity_rotation_handoff(
    id: String,
    app: tauri::AppHandle,
    extension: State<'_, IdentityRotationExtensionState>,
) -> Result<IdentityRotationPreview, String> {
    let handoff = extension
        .get(&id)
        .ok_or_else(|| "identity_rotation_handoff_missing".to_string())?;
    if handoff.resume {
        let journal = journal::load(&app, &handoff.rotation_id)?
            .ok_or_else(|| "identity_rotation_resume_state_missing".to_string())?;
        let state = app.state::<AppState>();
        let records = {
            let _store = state
                .managed_agents_store_lock
                .lock()
                .map_err(|_| "identity_rotation_local_inventory_unavailable".to_string())?;
            load_managed_agents(&app)?
        };
        let agent_names = journal
            .agents
            .iter()
            .map(|item| {
                records
                    .iter()
                    .find(|record| {
                        record.pubkey == item.old_public_key || record.pubkey == item.new_public_key
                    })
                    .map(|record| record.name.clone())
                    .ok_or_else(|| "identity_rotation_local_inventory_changed".to_string())
            })
            .collect::<Result<Vec<String>, String>>()?;
        let recovery_backup_required =
            !journal.recovery_backup_verified && !matches!(journal.mode, RotationMode::Agent);
        return Ok(IdentityRotationPreview {
            mode: journal.mode.clone(),
            managed_agent_count: journal.agents.len(),
            hosted_agent_count: journal.agents.iter().filter(|item| item.hosted).count(),
            agent_names,
            recovery_backup_required,
        });
    }
    let origin = handoff
        .coordinator_origin
        .as_deref()
        .ok_or_else(|| "identity_rotation_handoff_invalid".to_string())?;
    let challenge = handoff
        .challenge
        .as_deref()
        .ok_or_else(|| "identity_rotation_handoff_invalid".to_string())?;
    let state = app.state::<AppState>();
    let provider = discover_rotation_provider(origin)?;
    let plan = resolve_plan(&state, &provider, &handoff.rotation_id, challenge, false).await?;
    if crate::relay::relay_ws_url_with_override(&state).trim_end_matches('/')
        != plan.relay_url.trim_end_matches('/')
    {
        return Err("identity_rotation_workspace_changed".into());
    }
    let records = {
        let _store = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        load_managed_agents(&app)?
    };
    let selected = selected_records(&plan, &records, None)?;
    Ok(IdentityRotationPreview {
        mode: plan.mode.clone(),
        managed_agent_count: selected.len(),
        hosted_agent_count: selected
            .iter()
            .filter(|record| matches!(&record.backend, BackendKind::Provider { .. }))
            .count(),
        agent_names: selected.iter().map(|record| record.name.clone()).collect(),
        recovery_backup_required: !matches!(plan.mode, RotationMode::Agent),
    })
}

fn selected_records(
    plan: &DesktopPlan,
    records: &[ManagedAgentRecord],
    journal: Option<&IdentityRotationJournal>,
) -> Result<Vec<ManagedAgentRecord>, String> {
    let candidates: Vec<_> = records
        .iter()
        .filter(|record| record.relay_url.trim_end_matches('/') == plan.relay_url)
        .cloned()
        .collect();
    let selected = match (&plan.mode, journal) {
        (RotationMode::Human, _) => Vec::new(),
        (_, Some(journal)) => journal
            .agents
            .iter()
            .map(|item| {
                records
                    .iter()
                    .find(|record| {
                        record.pubkey == item.old_public_key
                            || (!item.new_public_key.is_empty()
                                && record.pubkey == item.new_public_key)
                    })
                    .cloned()
                    .ok_or_else(|| "identity_rotation_local_inventory_changed".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?,
        (RotationMode::All, None) => candidates,
        (RotationMode::Agent, None) => candidates
            .into_iter()
            .filter(|record| {
                Some(record.pubkey.as_str()) == plan.selected_agent_public_key.as_deref()
            })
            .collect(),
    };
    if matches!(plan.mode, RotationMode::Agent) && selected.len() != 1 {
        return Err("identity_rotation_selected_agent_unavailable".into());
    }
    for hosted in &plan.inventory.hosted_agents {
        let lineage = journal.and_then(|value| {
            value
                .agents
                .iter()
                .find(|item| item.old_public_key == hosted.public_key)
        });
        let found = selected.iter().find(|record| {
            let public_key_matches = record.pubkey == hosted.public_key
                || lineage.is_some_and(|item| record.pubkey == item.new_public_key);
            let provider_id_matches = record.backend_agent_id.as_deref()
                == Some(&hosted.provider_agent_id)
                || lineage.is_some_and(|item| {
                    record.backend_agent_id.as_deref() == item.new_provider_agent_id.as_deref()
                });
            public_key_matches && provider_id_matches
        });
        if found.is_none() {
            return Err("identity_rotation_hosted_inventory_conflict".into());
        }
    }
    Ok(selected)
}

fn initial_journal(
    plan: &DesktopPlan,
    provider: &RotationProvider,
    selected: &[ManagedAgentRecord],
) -> IdentityRotationJournal {
    let now = chrono::Utc::now().to_rfc3339();
    IdentityRotationJournal {
        contract_version: 1,
        rotation_id: plan.rotation_id.clone(),
        coordinator_origin: provider.coordinator_origin.clone(),
        community_id: plan.community_id.clone(),
        relay_url: plan.relay_url.clone(),
        mode: plan.mode.clone(),
        selected_agent_public_key: plan.selected_agent_public_key.clone(),
        state: "planned".into(),
        state_version: 1,
        challenge_expires_at: plan.challenge_expires_at.clone(),
        old_owner_public_key: plan.old_owner_public_key.clone(),
        new_owner_public_key: None,
        provider_id: provider.provider_id.clone(),
        resolve_path: provider.resolve_path.clone(),
        prepare_path: provider.prepare_path.clone(),
        advance_path: provider.advance_path.clone(),
        proof_kind: provider.proof_kind,
        proof_content: provider.proof_content.clone(),
        recovery_backup_verified: false,
        agents: selected
            .iter()
            .map(|record| RotationAgentJournal {
                old_public_key: record.pubkey.clone(),
                new_public_key: String::new(),
                hosted: plan
                    .inventory
                    .hosted_agents
                    .iter()
                    .any(|agent| agent.public_key == record.pubkey),
                provider_id: match &record.backend {
                    BackendKind::Provider { id, .. } => Some(id.clone()),
                    BackendKind::Local => None,
                },
                old_provider_agent_id: record.backend_agent_id.clone(),
                new_provider_agent_id: None,
                profile_verified: false,
                profile_event_id: None,
                memory_heads_migrated: 0,
                memory_tombstones_preserved: 0,
                archive_verified: false,
                archive_event_id: None,
                canary_verified: false,
                local_runtime_was_running: false,
            })
            .collect(),
        continuity: ContinuityJournal::default(),
        committed_locally: false,
        old_authority_purged: false,
        error_code: None,
        created_at: now.clone(),
        updated_at: now,
    }
}

async fn create_recovery_backup(
    app: &tauri::AppHandle,
    passphrase: Zeroizing<String>,
) -> Result<(), String> {
    if passphrase.chars().count() < crate::key_backup::MIN_PASSPHRASE_LEN {
        return Err("identity_rotation_recovery_passphrase_too_short".into());
    }
    let app_for_backup = app.clone();
    let blob = tokio::task::spawn_blocking(move || {
        let state = app_for_backup.state::<AppState>();
        crate::create_backup_with_log_n(&state, &passphrase, crate::key_backup::BACKUP_LOG_N)
    })
    .await
    .map_err(|_| "identity_rotation_recovery_backup_failed".to_string())??;
    let path = pick_recovery_backup_path(
        app,
        &format!(
            "buzz-identity-before-rotation.{}",
            crate::key_backup::NCRYPTSEC_HRP.trim_end_matches('1')
        ),
    )
    .await?
    .ok_or_else(|| "identity_rotation_recovery_backup_required".to_string())?;
    let path_for_write = path.clone();
    tokio::task::spawn_blocking(move || {
        crate::key_backup::write_portable_backup_file(&path_for_write, &blob)
    })
    .await
    .map_err(|_| "identity_rotation_recovery_backup_failed".to_string())??;
    if std::fs::metadata(path)
        .map_err(|_| "identity_rotation_recovery_backup_failed".to_string())?
        .len()
        == 0
    {
        return Err("identity_rotation_recovery_backup_failed".into());
    }
    Ok(())
}

struct StagedAgent {
    old_public_key: String,
    old: Keys,
    new: Keys,
    old_auth_tag: Zeroizing<String>,
    new_auth_tag: Zeroizing<String>,
    hosted: bool,
    provider_config: Option<Value>,
}

fn stage_or_load_keys(
    app: &tauri::AppHandle,
    plan: &DesktopPlan,
    journal: &mut IdentityRotationJournal,
    selected: &[ManagedAgentRecord],
) -> Result<(Keys, Keys, Vec<StagedAgent>), String> {
    if journal.new_owner_public_key.is_some() {
        let old_owner = load_human_keys(&journal.rotation_id, false)?;
        let new_owner = load_human_keys(&journal.rotation_id, true)?;
        let agents = journal
            .agents
            .iter()
            .map(|agent| {
                let record = selected
                    .iter()
                    .find(|record| {
                        record.pubkey == agent.old_public_key
                            || (!agent.new_public_key.is_empty()
                                && record.pubkey == agent.new_public_key)
                    })
                    .ok_or_else(|| "identity_rotation_local_inventory_changed".to_string())?;
                Ok(StagedAgent {
                    old_public_key: agent.old_public_key.clone(),
                    old: load_agent_keys(&journal.rotation_id, &agent.old_public_key, false)?,
                    new: load_agent_keys(&journal.rotation_id, &agent.old_public_key, true)?,
                    old_auth_tag: load_agent_auth_tag(
                        &journal.rotation_id,
                        &agent.old_public_key,
                        false,
                    )?,
                    new_auth_tag: load_agent_auth_tag(
                        &journal.rotation_id,
                        &agent.old_public_key,
                        true,
                    )?,
                    hosted: agent.hosted,
                    provider_config: match &record.backend {
                        BackendKind::Provider { config, .. } => Some(config.clone()),
                        BackendKind::Local => None,
                    },
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        return Ok((old_owner, new_owner, agents));
    }

    let state = app.state::<AppState>();
    let old_owner = state.signing_keys()?;
    if old_owner.public_key().to_hex() != plan.old_owner_public_key {
        return Err("identity_rotation_owner_identity_changed".into());
    }
    let new_owner = if matches!(plan.mode, RotationMode::Agent) {
        old_owner.clone()
    } else {
        Keys::generate()
    };
    stage_human_keys(&journal.rotation_id, &old_owner, &new_owner)?;
    journal.new_owner_public_key = Some(new_owner.public_key().to_hex());
    let mut staged = Vec::new();
    for record in selected {
        let old = Keys::parse(record.private_key_nsec.trim())
            .map_err(|_| "identity_rotation_agent_key_unavailable".to_string())?;
        if old.public_key().to_hex() != record.pubkey {
            return Err("identity_rotation_agent_key_mismatch".into());
        }
        let new = Keys::generate();
        let old_auth = Zeroizing::new(match record.auth_tag.as_deref() {
            Some(value) if !value.trim().is_empty() => value.to_string(),
            _ => compute_agent_auth_tag(&old_owner, &old)?,
        });
        let new_auth = Zeroizing::new(compute_agent_auth_tag(&new_owner, &new)?);
        stage_agent_keys(
            &journal.rotation_id,
            &record.pubkey,
            &old,
            &new,
            &old_auth,
            &new_auth,
        )?;
        let item = journal
            .agents
            .iter_mut()
            .find(|item| item.old_public_key == record.pubkey)
            .ok_or_else(|| "identity_rotation_journal_corrupt".to_string())?;
        item.new_public_key = new.public_key().to_hex();
        staged.push(StagedAgent {
            old_public_key: record.pubkey.clone(),
            old,
            new,
            old_auth_tag: old_auth,
            new_auth_tag: new_auth,
            hosted: item.hosted,
            provider_config: match &record.backend {
                BackendKind::Provider { config, .. } => Some(config.clone()),
                BackendKind::Local => None,
            },
        });
    }
    journal.state = "keys_staged".into();
    journal.state_version += 1;
    journal::save(app, journal)?;
    Ok((old_owner, new_owner, staged))
}

fn proofs(
    keys: &Keys,
    journal: &IdentityRotationJournal,
    action: &str,
    old: &str,
    new: &str,
) -> Result<Value, String> {
    let challenge = load_handoff_challenge(&journal.rotation_id)?;
    build_rotation_proof(
        keys,
        &journal.rotation_id,
        action,
        &sha256_hex(challenge.as_bytes()),
        &journal.community_id,
        old,
        new,
        journal.proof_kind,
        &journal.proof_content,
    )
}

async fn prepare_coordinator(
    state: &AppState,
    provider: &RotationProvider,
    journal: &IdentityRotationJournal,
    old_owner: &Keys,
    new_owner: &Keys,
    agents: &[StagedAgent],
) -> Result<PrepareResponse, String> {
    let challenge = load_handoff_challenge(&journal.rotation_id)?;
    let old_owner_hex = old_owner.public_key().to_hex();
    let new_owner_hex = new_owner.public_key().to_hex();
    let mut prepared_agents = Vec::new();
    for agent in agents {
        let envelope = if agent.hosted {
            let nsec = Zeroizing::new(
                agent
                    .new
                    .secret_key()
                    .to_bech32()
                    .map_err(|_| "identity_rotation_agent_key_encode_failed".to_string())?,
            );
            let config = agent
                .provider_config
                .as_ref()
                .ok_or_else(|| "identity_rotation_hosted_provider_config_missing".to_string())?;
            Some(
                prepare_identity_envelope(
                    provider,
                    &journal.rotation_id,
                    &journal.community_id,
                    &journal.relay_url,
                    &agent.new.public_key().to_hex(),
                    &nsec,
                    &agent.new_auth_tag,
                    config,
                )?
                .identity_envelope,
            )
        } else {
            None
        };
        prepared_agents.push(json!({
            "old_public_key": agent.old_public_key,
            "new_public_key": agent.new.public_key().to_hex(),
            "old_identity_proof": proofs(&agent.old, journal, "prepare", &agent.old_public_key, &agent.new.public_key().to_hex())?,
            "new_identity_proof": proofs(&agent.new, journal, "prepare", &agent.old_public_key, &agent.new.public_key().to_hex())?,
            "identity_envelope": envelope
        }));
    }
    let value = post_json(
        state,
        endpoint(&provider.coordinator_origin, &provider.prepare_path, &journal.rotation_id)?,
        &json!({
            "contract_version": 1,
            "rotation_id": journal.rotation_id,
            "challenge": challenge.as_str(),
            "old_owner_proof": proofs(old_owner, journal, "prepare", &old_owner_hex, &new_owner_hex)?,
            "new_owner_proof": if matches!(journal.mode, RotationMode::Agent) { Value::Null } else { proofs(new_owner, journal, "prepare", &old_owner_hex, &new_owner_hex)? },
            "agents": prepared_agents,
            "recovery_verified": true
        }),
    )
    .await?;
    serde_json::from_value(value)
        .map_err(|_| "identity_rotation_coordinator_response_invalid".to_string())
}

async fn advance(
    state: &AppState,
    provider: &RotationProvider,
    journal: &IdentityRotationJournal,
    status: &CoordinatorStatus,
    action: &str,
    owner: Option<&Keys>,
    continuity: Option<Value>,
    error_code: Option<&str>,
) -> Result<CoordinatorStatus, String> {
    let resume = load_resume_token(&journal.rotation_id)?;
    let owner_proof = match owner {
        Some(owner) => Some(proofs(
            owner,
            journal,
            action,
            &journal.old_owner_public_key,
            journal
                .new_owner_public_key
                .as_deref()
                .ok_or_else(|| "identity_rotation_journal_corrupt".to_string())?,
        )?),
        None => None,
    };
    let value = post_json(
        state,
        endpoint(
            &provider.coordinator_origin,
            &provider.advance_path,
            &journal.rotation_id,
        )?,
        &json!({
            "contract_version": 1,
            "resume_token": resume.as_str(),
            "expected_state_version": status.state_version,
            "action": action,
            "owner_proof": owner_proof,
            "continuity": continuity,
            "error_code": error_code
        }),
    )
    .await?;
    serde_json::from_value(value)
        .map_err(|_| "identity_rotation_coordinator_response_invalid".to_string())
}

async fn coordinator_status(
    state: &AppState,
    provider: &RotationProvider,
    journal: &IdentityRotationJournal,
    current: &CoordinatorStatus,
) -> Result<CoordinatorStatus, String> {
    advance(
        state, provider, journal, current, "status", None, None, None,
    )
    .await
}

async fn report_recoverable(
    app: &tauri::AppHandle,
    journal: &IdentityRotationJournal,
    error_code: &str,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let provider = discover_rotation_provider(&journal.coordinator_origin)?;
    let status_context = CoordinatorStatus {
        contract_version: 1,
        rotation_id: journal.rotation_id.clone(),
        mode: journal.mode.clone(),
        state: journal.state.clone(),
        state_version: journal.state_version,
        old_owner_public_key: journal.old_owner_public_key.clone(),
        new_owner_public_key: journal.new_owner_public_key.clone(),
        items: Vec::new(),
    };
    let status = coordinator_status(&state, &provider, journal, &status_context).await?;
    if matches!(
        status.state.as_str(),
        "recoverable" | "complete" | "failed" | "aborted"
    ) {
        return Ok(());
    }
    let new_owner = load_human_keys(&journal.rotation_id, true)?;
    advance(
        &state,
        &provider,
        journal,
        &status,
        "report_recoverable",
        Some(&new_owner),
        None,
        Some(error_code),
    )
    .await?;
    Ok(())
}

fn continuity_value(
    value: &ContinuityJournal,
    journal: &IdentityRotationJournal,
) -> Result<Value, String> {
    let mut items = Vec::new();
    if !matches!(journal.mode, RotationMode::Agent) {
        items.push(json!({
            "item_kind": "human",
            "old_public_key": journal.old_owner_public_key,
            "new_public_key": journal.new_owner_public_key.as_deref().ok_or_else(|| "identity_rotation_journal_corrupt".to_string())?,
            "profile_verified": value.owner_profile_verified,
            "profile_event_id": value.owner_profile_event_id,
            "memory_head_count": 0,
            "memory_tombstone_count": 0,
            "archive_verified": value.owner_archive_verified,
            "archive_event_id": value.owner_archive_event_id
        }));
    }
    items.extend(journal.agents.iter().map(|item| {
        json!({
            "item_kind": "agent",
            "old_public_key": item.old_public_key,
            "new_public_key": item.new_public_key,
            "profile_verified": item.profile_verified,
            "profile_event_id": item.profile_event_id,
            "memory_head_count": item.memory_heads_migrated,
            "memory_tombstone_count": item.memory_tombstones_preserved,
            "archive_verified": item.archive_verified,
            "archive_event_id": item.archive_event_id
        })
    }));
    Ok(json!({
        "relay_memberships_verified": value.relay_memberships_verified,
        "channel_memberships_verified": value.channel_memberships_verified,
        "profiles_verified": value.profiles_verified,
        "memory_heads_migrated": value.memory_heads_migrated,
        "memory_tombstones_preserved": value.memory_tombstones_preserved,
        "archive_pointers_verified": value.archive_pointers_verified,
        "evidence_sha256": value.evidence_sha256.as_deref().ok_or_else(|| "identity_rotation_evidence_missing".to_string())?,
        "items": items
    }))
}

fn commit_local(
    app: &tauri::AppHandle,
    journal: &mut IdentityRotationJournal,
    new_owner: &Keys,
    agents: &[StagedAgent],
    status: &CoordinatorStatus,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    if !matches!(journal.mode, RotationMode::Agent) {
        let _mutation = state.identity_mutation.lock().map_err(|e| e.to_string())?;
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| "identity_rotation_app_data_unavailable".to_string())?;
        let key_path = data_dir.join("identity.key");
        let store = crate::secret_store::SecretStore::shared(keyring_service());
        crate::commit_imported_identity(&state, &data_dir, new_owner.clone(), |keys| {
            persist_imported_identity(store, keys, &key_path, &data_dir)
        })?;
    }
    let _store = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let mut records = load_managed_agents(app)?;
    for agent in agents {
        let record = records
            .iter_mut()
            .find(|record| {
                record.pubkey == agent.old_public_key
                    || record.pubkey == agent.new.public_key().to_hex()
            })
            .ok_or_else(|| "identity_rotation_local_inventory_changed".to_string())?;
        record.pubkey = agent.new.public_key().to_hex();
        record.private_key_nsec = agent
            .new
            .secret_key()
            .to_bech32()
            .map_err(|_| "identity_rotation_agent_key_encode_failed".to_string())?;
        record.auth_tag = Some(agent.new_auth_tag.to_string());
        if let Some(item) = status
            .items
            .iter()
            .find(|item| item.old_public_key == agent.old_public_key)
        {
            record.backend_agent_id = item.new_provider_agent_id.clone();
        }
        record.updated_at = chrono::Utc::now().to_rfc3339();
    }
    save_managed_agents(app, &records)?;
    journal.committed_locally = true;
    journal.state = "committed".into();
    journal::save(app, journal)
}

fn drain_selected_local_runtimes(
    app: &tauri::AppHandle,
    journal: &mut IdentityRotationJournal,
    agents: &[StagedAgent],
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _transition = state
        .managed_agent_runtime_transition
        .lock()
        .map_err(|e| e.to_string())?;
    let _store = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let mut records = load_managed_agents(app)?;
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|e| e.to_string())?;
    for record in records.iter_mut().filter(|record| {
        record.backend == BackendKind::Local
            && agents
                .iter()
                .any(|agent| agent.old_public_key == record.pubkey)
    }) {
        let was_running = runtimes.keys().any(|key| key.pubkey == record.pubkey);
        if let Some(item) = journal
            .agents
            .iter_mut()
            .find(|item| item.old_public_key == record.pubkey)
        {
            item.local_runtime_was_running |= was_running;
        }
        stop_managed_agent_process(app, record, &mut runtimes)?;
    }
    drop(runtimes);
    save_managed_agents(app, &records)?;
    journal::save(app, journal)
}

fn restart_rotated_local_runtimes(
    app: &tauri::AppHandle,
    journal: &IdentityRotationJournal,
) -> Result<(), String> {
    for item in journal
        .agents
        .iter()
        .filter(|item| item.local_runtime_was_running)
    {
        crate::managed_agents::start_managed_agent_runtime_pair_lazy(
            item.new_public_key.clone(),
            journal.relay_url.clone(),
            app.clone(),
        )?;
    }
    Ok(())
}

fn restart_original_local_runtimes(
    app: &tauri::AppHandle,
    journal: &IdentityRotationJournal,
) -> Result<(), String> {
    for item in journal
        .agents
        .iter()
        .filter(|item| item.local_runtime_was_running)
    {
        crate::managed_agents::start_managed_agent_runtime_pair_lazy(
            item.old_public_key.clone(),
            journal.relay_url.clone(),
            app.clone(),
        )?;
    }
    Ok(())
}

async fn hosted_canary(
    state: &AppState,
    journal: &IdentityRotationJournal,
    owner: &Keys,
    status: &CoordinatorStatus,
) -> Result<(), String> {
    use crate::relay::{
        parse_command_response, query_relay_at_with_keys, relay_http_base_url,
        submit_event_at_with_keys,
    };
    #[derive(Deserialize)]
    struct OpenDmAck {
        channel_id: String,
    }
    let base = relay_http_base_url(&journal.relay_url);
    for item in status.items.iter().filter(|item| item.hosted) {
        let agent = item
            .new_public_key
            .as_ref()
            .ok_or_else(|| "identity_rotation_canary_identity_missing".to_string())?;
        let opened = submit_event_at_with_keys(
            crate::events::build_dm_open(&[agent.clone()])?,
            state,
            &base,
            owner,
        )
        .await?;
        let ack: OpenDmAck = parse_command_response(&opened.message)?;
        let channel = uuid::Uuid::parse_str(&ack.channel_id)
            .map_err(|_| "identity_rotation_canary_channel_invalid".to_string())?;
        let token = format!("rotation-canary-{}", uuid::Uuid::new_v4());
        let since = chrono::Utc::now().timestamp().max(0) as u64;
        submit_event_at_with_keys(
            crate::events::build_message(
                channel,
                &format!("Reply with this exact token only: {token}"),
                None,
                &[],
                &[],
                &[],
                &[],
                &[],
                None,
                &journal.relay_url,
            )?,
            state,
            &base,
            owner,
        )
        .await?;
        let mut matched = false;
        for _ in 0..90 {
            let messages = query_relay_at_with_keys(
                state,
                &base,
                &[json!({
                    "kinds": [9],
                    "authors": [agent],
                    "#h": [ack.channel_id],
                    "since": since
                })],
                owner,
                None,
            )
            .await?;
            if messages.iter().any(|event| event.content.trim() == token) {
                matched = true;
                break;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        if !matched {
            return Err("identity_rotation_hosted_canary_timeout".into());
        }
    }
    Ok(())
}

fn mark_error(app: &tauri::AppHandle, journal: &mut IdentityRotationJournal, error: &str) {
    journal.error_code = Some(error.to_string());
    journal.state = "recoverable".into();
    let _ = journal::save(app, journal);
}

async fn execute_rotation(
    app: &tauri::AppHandle,
    handoff: IdentityRotationHandoff,
    recovery_passphrase: Option<Zeroizing<String>>,
) -> Result<IdentityRotationJournal, String> {
    let state = app.state::<AppState>();
    let existing = journal::load(app, &handoff.rotation_id)?;
    if handoff.resume && existing.is_none() {
        return Err("identity_rotation_resume_state_missing".into());
    }
    let coordinator_origin = match handoff.coordinator_origin.as_deref() {
        Some(origin) => origin.to_string(),
        None => existing
            .as_ref()
            .map(|journal| journal.coordinator_origin.clone())
            .ok_or_else(|| "identity_rotation_resume_state_missing".to_string())?,
    };
    let challenge = match handoff.challenge.as_deref() {
        Some(value) => Zeroizing::new(value.to_string()),
        None => load_handoff_challenge(&handoff.rotation_id)?,
    };
    let provider = discover_rotation_provider(&coordinator_origin)?;
    let plan = resolve_plan(
        &state,
        &provider,
        &handoff.rotation_id,
        challenge.as_str(),
        existing.is_some(),
    )
    .await?;
    if crate::relay::relay_ws_url_with_override(&state).trim_end_matches('/')
        != plan.relay_url.trim_end_matches('/')
    {
        return Err("identity_rotation_workspace_changed".into());
    }
    let records = {
        let _store = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        load_managed_agents(app)?
    };
    let selected = selected_records(&plan, &records, existing.as_ref())?;
    let mut journal = match existing {
        Some(existing) => existing,
        None => {
            store_handoff_challenge(&plan.rotation_id, challenge.as_str())?;
            let mut created = initial_journal(&plan, &provider, &selected);
            journal::save(app, &mut created)?;
            created
        }
    };
    if journal.coordinator_origin != provider.coordinator_origin
        || journal.old_owner_public_key != plan.old_owner_public_key
    {
        return Err("identity_rotation_resume_scope_mismatch".into());
    }

    if !journal.recovery_backup_verified && !matches!(plan.mode, RotationMode::Agent) {
        emit_progress(
            app,
            &journal.rotation_id,
            "recovery_verified",
            "Creating and verifying the required recovery backup…",
            false,
            None,
        );
        create_recovery_backup(
            app,
            recovery_passphrase
                .ok_or_else(|| "identity_rotation_recovery_passphrase_required".to_string())?,
        )
        .await?;
        journal.recovery_backup_verified = true;
        journal.state = "recovery_verified".into();
        journal.state_version += 1;
        journal::save(app, &mut journal)?;
    }

    emit_progress(
        app,
        &journal.rotation_id,
        "keys_staged",
        "Generating replacement identities and verifying secure storage…",
        false,
        None,
    );
    let (old_owner, new_owner, staged) = stage_or_load_keys(app, &plan, &mut journal, &selected)?;

    let mut status = match load_resume_token(&journal.rotation_id) {
        Ok(_) => {
            let status_context = CoordinatorStatus {
                contract_version: 1,
                rotation_id: journal.rotation_id.clone(),
                mode: journal.mode.clone(),
                state: journal.state.clone(),
                state_version: journal.state_version,
                old_owner_public_key: journal.old_owner_public_key.clone(),
                new_owner_public_key: journal.new_owner_public_key.clone(),
                items: Vec::new(),
            };
            coordinator_status(&state, &provider, &journal, &status_context).await?
        }
        Err(_) => {
            emit_progress(
                app,
                &journal.rotation_id,
                "replacements_ready",
                "Provisioning replacement hosted capacity with the exact prior configuration…",
                false,
                None,
            );
            let prepared =
                prepare_coordinator(&state, &provider, &journal, &old_owner, &new_owner, &staged)
                    .await?;
            store_resume_token(&journal.rotation_id, &prepared.resume_token)?;
            prepared.status
        }
    };
    if status.state == "recoverable" {
        emit_progress(
            app,
            &journal.rotation_id,
            "recoverable",
            "Resuming from the last durable coordinator checkpoint…",
            false,
            None,
        );
        status = advance(
            &state,
            &provider,
            &journal,
            &status,
            "resume",
            Some(&new_owner),
            None,
            None,
        )
        .await?;
        journal.error_code = None;
        journal.state = status.state.clone();
        journal.state_version = status.state_version;
        journal::save(app, &mut journal)?;
    }
    let mut replacement_waits = 0u16;
    while status.state == "keys_staged" && replacement_waits < 90 {
        tokio::time::sleep(Duration::from_secs(2)).await;
        status = coordinator_status(&state, &provider, &journal, &status).await?;
        replacement_waits += 1;
    }
    if status.state == "keys_staged" {
        return Err("identity_rotation_replacement_timeout".into());
    }
    if status.state == "replacements_ready" {
        emit_progress(
            app,
            &journal.rotation_id,
            "continuity_migrated",
            "Preserving relay and channel roles…",
            false,
            None,
        );
        let owner_pair = RotationIdentity {
            old: &old_owner,
            new: &new_owner,
            old_auth_tag: None,
            new_auth_tag: None,
        };
        let mut pairs = Vec::new();
        if !matches!(journal.mode, RotationMode::Agent) {
            pairs.push(RotationIdentity {
                old: &old_owner,
                new: &new_owner,
                old_auth_tag: None,
                new_auth_tag: None,
            });
        }
        for agent in &staged {
            pairs.push(RotationIdentity {
                old: &agent.old,
                new: &agent.new,
                old_auth_tag: Some(&agent.old_auth_tag),
                new_auth_tag: Some(&agent.new_auth_tag),
            });
        }
        let (relay_count, channel_count) =
            migrate_memberships(&state, &journal.relay_url, &owner_pair, &pairs).await?;
        journal.continuity.relay_memberships_verified = relay_count;
        journal.continuity.channel_memberships_verified = channel_count;
        emit_progress(
            app,
            &journal.rotation_id,
            "continuity_migrated",
            "Cloning and verifying identity profiles…",
            false,
            None,
        );
        let profile_event_ids = clone_profiles(&state, &journal.relay_url, &pairs).await?;
        journal.continuity.profiles_verified = profile_event_ids.len() as u32;
        if !matches!(journal.mode, RotationMode::Agent) {
            journal.continuity.owner_profile_event_id = profile_event_ids
                .get(&journal.old_owner_public_key)
                .cloned();
            journal.continuity.owner_profile_verified =
                journal.continuity.owner_profile_event_id.is_some();
        }
        for item in &mut journal.agents {
            item.profile_event_id = profile_event_ids.get(&item.old_public_key).cloned();
            item.profile_verified = item.profile_event_id.is_some();
        }
        emit_progress(
            app,
            &journal.rotation_id,
            "continuity_migrated",
            "Migrating current memory heads and tombstones…",
            false,
            None,
        );
        for agent in &staged {
            let pair = RotationIdentity {
                old: &agent.old,
                new: &agent.new,
                old_auth_tag: Some(&agent.old_auth_tag),
                new_auth_tag: Some(&agent.new_auth_tag),
            };
            let (heads, tombstones) =
                migrate_agent_memory(&state, &journal.relay_url, &old_owner, &new_owner, &pair)
                    .await?;
            journal.continuity.memory_heads_migrated += heads;
            journal.continuity.memory_tombstones_preserved += tombstones;
            if let Some(item) = journal
                .agents
                .iter_mut()
                .find(|item| item.old_public_key == agent.old_public_key)
            {
                item.memory_heads_migrated = heads;
                item.memory_tombstones_preserved = tombstones;
            }
        }
        finalize_evidence(&mut journal.continuity)?;
        journal.state = "continuity_migrated".into();
        journal::save(app, &mut journal)?;
        status = advance(
            &state,
            &provider,
            &journal,
            &status,
            "continuity_migrated",
            Some(&new_owner),
            Some(continuity_value(&journal.continuity, &journal)?),
            None,
        )
        .await?;
    }

    if status.state == "continuity_migrated" {
        drain_selected_local_runtimes(app, &mut journal, &staged)?;
        emit_progress(
            app,
            &journal.rotation_id,
            "committed",
            "Committing the server binding and local identities atomically…",
            false,
            None,
        );
        status = advance(
            &state,
            &provider,
            &journal,
            &status,
            "commit",
            Some(&new_owner),
            None,
            None,
        )
        .await?;
    }
    if status.state == "committed" && !journal.committed_locally {
        commit_local(app, &mut journal, &new_owner, &staged, &status)?;
    }

    if status.state == "committed" {
        restart_rotated_local_runtimes(app, &journal)?;
        emit_progress(
            app,
            &journal.rotation_id,
            "canary_verified",
            "Running the committed owner identity's signed relay canary…",
            false,
            None,
        );
        signed_owner_relay_canary(&state, &journal.relay_url, &new_owner).await?;
        emit_progress(
            app,
            &journal.rotation_id,
            "canary_verified",
            "Waiting for every replacement hosted agent to answer its private canary…",
            false,
            None,
        );
        hosted_canary(&state, &journal, &new_owner, &status).await?;
        for item in &mut journal.agents {
            if item.hosted {
                item.canary_verified = true;
            }
        }
        status = advance(
            &state,
            &provider,
            &journal,
            &status,
            "canary_verified",
            Some(&new_owner),
            None,
            None,
        )
        .await?;
        journal.state = "canary_verified".into();
        journal::save(app, &mut journal)?;
    }

    if status.state == "canary_verified" {
        emit_progress(
            app,
            &journal.rotation_id,
            "old_revoked",
            "Archiving old identities and verifying replacement pointers…",
            false,
            None,
        );
        let mut pairs = Vec::new();
        if !matches!(journal.mode, RotationMode::Agent) {
            pairs.push(RotationIdentity {
                old: &old_owner,
                new: &new_owner,
                old_auth_tag: None,
                new_auth_tag: None,
            });
        }
        for agent in &staged {
            pairs.push(RotationIdentity {
                old: &agent.old,
                new: &agent.new,
                old_auth_tag: Some(&agent.old_auth_tag),
                new_auth_tag: Some(&agent.new_auth_tag),
            });
        }
        let archive_event_ids = archive_old_identities(&state, &journal.relay_url, &pairs).await?;
        journal.continuity.archive_pointers_verified = archive_event_ids.len() as u32;
        if !matches!(journal.mode, RotationMode::Agent) {
            journal.continuity.owner_archive_event_id = archive_event_ids
                .get(&journal.old_owner_public_key)
                .cloned();
            journal.continuity.owner_archive_verified =
                journal.continuity.owner_archive_event_id.is_some();
        }
        for item in &mut journal.agents {
            item.archive_event_id = archive_event_ids.get(&item.old_public_key).cloned();
            item.archive_verified = item.archive_event_id.is_some();
        }
        finalize_evidence(&mut journal.continuity)?;
        emit_progress(
            app,
            &journal.rotation_id,
            "old_revoked",
            "Revoking prior relay and channel authority and proving denial…",
            false,
            None,
        );
        let owner_pair = RotationIdentity {
            old: &old_owner,
            new: &new_owner,
            old_auth_tag: None,
            new_auth_tag: None,
        };
        revoke_old_authorities(&state, &journal.relay_url, &owner_pair, &pairs).await?;
        status = advance(
            &state,
            &provider,
            &journal,
            &status,
            "old_revoked",
            Some(&new_owner),
            Some(continuity_value(&journal.continuity, &journal)?),
            None,
        )
        .await?;
        journal.state = "old_revoked".into();
        journal::save(app, &mut journal)?;
    }

    if status.state == "old_revoked" {
        emit_progress(
            app,
            &journal.rotation_id,
            "old_revoked",
            "Confirming old hosted capacity is fully deleted…",
            false,
            None,
        );
        let mut complete = None;
        for _ in 0..90 {
            match advance(
                &state,
                &provider,
                &journal,
                &status,
                "complete",
                Some(&new_owner),
                None,
                None,
            )
            .await
            {
                Ok(value) => {
                    complete = Some(value);
                    break;
                }
                Err(code) if code == "buzz_identity_rotation_old_endpoint_pending" => {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    status = coordinator_status(&state, &provider, &journal, &status).await?;
                }
                Err(code) => return Err(code),
            }
        }
        status = complete.ok_or_else(|| "identity_rotation_old_endpoint_timeout".to_string())?;
    }
    if status.state != "complete" {
        return Err("identity_rotation_unexpected_final_state".into());
    }
    for agent in &staged {
        try_delete_agent_key(&agent.old_public_key)?;
    }
    purge_staged_secrets(&journal)?;
    journal.old_authority_purged = true;
    journal.state = "complete".into();
    journal.state_version = status.state_version;
    journal.error_code = None;
    journal::save(app, &mut journal)?;
    emit_progress(
        app,
        &journal.rotation_id,
        "complete",
        "Identity rotation completed and old authority was purged.",
        true,
        None,
    );
    Ok(journal)
}

#[tauri::command]
pub(crate) fn identity_rotation_status(
    rotation_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<Option<IdentityRotationJournal>, String> {
    match rotation_id {
        Some(id) => journal::load(&app, &id),
        None => journal::latest_incomplete(&app),
    }
}

#[tauri::command]
pub(crate) async fn run_identity_rotation(
    request: RunIdentityRotationRequest,
    app: tauri::AppHandle,
    extension: State<'_, IdentityRotationExtensionState>,
) -> Result<IdentityRotationJournal, String> {
    let _operation = extension.operation.lock().await;
    let handoff = extension
        .get(&request.handoff_id)
        .ok_or_else(|| "identity_rotation_handoff_missing".to_string())?;
    let rotation_id = handoff.rotation_id.clone();
    let passphrase = request.recovery_passphrase.map(Zeroizing::new);
    match execute_rotation(&app, handoff, passphrase).await {
        Ok(journal) => Ok(journal),
        Err(code) => {
            let public_code = public_rotation_error_code(&code);
            if let Ok(Some(mut journal)) = journal::load(&app, &rotation_id) {
                // The local journal remains authoritative when the network is
                // unavailable. When reachable, mirror the pause to the
                // coordinator so another launch resumes the exact checkpoint.
                let _ = report_recoverable(&app, &journal, &public_code).await;
                mark_error(&app, &mut journal, &public_code);
            }
            emit_progress(&app, &rotation_id, "recoverable", "Identity rotation paused safely. You can resume after resolving the reported issue.", true, Some(&public_code));
            Err(public_code)
        }
    }
}

#[tauri::command]
pub(crate) async fn abort_identity_rotation(
    rotation_id: String,
    app: tauri::AppHandle,
    extension: State<'_, IdentityRotationExtensionState>,
) -> Result<IdentityRotationJournal, String> {
    let _operation = extension.operation.lock().await;
    let mut journal = journal::load(&app, &rotation_id)?
        .ok_or_else(|| "identity_rotation_not_found".to_string())?;
    if matches!(journal.state.as_str(), "failed" | "aborted") {
        return Ok(journal);
    }
    if journal.committed_locally
        || matches!(
            journal.state.as_str(),
            "committed" | "canary_verified" | "old_revoked" | "complete"
        )
    {
        return Err("identity_rotation_abort_after_commit".into());
    }
    if load_resume_token(&journal.rotation_id).is_ok() {
        let state = app.state::<AppState>();
        let provider = discover_rotation_provider(&journal.coordinator_origin)?;
        let status_context = CoordinatorStatus {
            contract_version: 1,
            rotation_id: journal.rotation_id.clone(),
            mode: journal.mode.clone(),
            state: journal.state.clone(),
            state_version: journal.state_version,
            old_owner_public_key: journal.old_owner_public_key.clone(),
            new_owner_public_key: journal.new_owner_public_key.clone(),
            items: Vec::new(),
        };
        let status = coordinator_status(&state, &provider, &journal, &status_context).await?;
        if matches!(
            status.state.as_str(),
            "committed" | "canary_verified" | "old_revoked" | "complete"
        ) {
            return Err("identity_rotation_abort_after_commit".into());
        }
        if status.state == "failed" {
            journal.state = "failed".into();
            journal.state_version = status.state_version;
            journal::save(&app, &mut journal)?;
            return Ok(journal);
        }
        if status.state != "aborted" {
            advance(
                &state, &provider, &journal, &status, "abort", None, None, None,
            )
            .await?;
        }
    }
    restart_original_local_runtimes(&app, &journal)?;
    purge_staged_secrets(&journal)?;
    journal.state = "aborted".into();
    journal.old_authority_purged = false;
    journal.error_code = None;
    journal::save(&app, &mut journal)?;
    emit_progress(
        &app,
        &rotation_id,
        "aborted",
        "Identity rotation was aborted before cutover.",
        true,
        None,
    );
    Ok(journal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coordinator_paths_cannot_escape_signed_origin() {
        assert_eq!(
            endpoint("https://api.example.com/buzz", "/resolve", "id").unwrap(),
            "https://api.example.com/buzz/resolve"
        );
        assert!(endpoint("https://api.example.com", "//evil.example.com", "id").is_err());
    }

    #[test]
    fn coordinator_errors_are_bounded_codes() {
        let value = json!({"error": "buzz_identity_rotation_old_endpoint_pending"});
        assert_eq!(
            coordinator_error(reqwest::StatusCode::CONFLICT, Some(&value)),
            "buzz_identity_rotation_old_endpoint_pending"
        );
        assert_eq!(
            coordinator_error(
                reqwest::StatusCode::BAD_GATEWAY,
                Some(&json!({"error": "<html>secret"}))
            ),
            "identity_rotation_coordinator_http_502"
        );
    }
}

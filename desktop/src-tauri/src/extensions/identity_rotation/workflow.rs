use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use zeroize::Zeroizing;

use crate::{
    app_state::AppState,
    managed_agents::{load_managed_agents, BackendKind, ManagedAgentRecord},
};

use super::{
    continuity::{
        archive_old_identities, clone_profiles, finalize_evidence, migrate_agent_memory,
        migrate_memberships, revoke_old_channel_authorities, signed_owner_relay_canary,
        verify_old_relay_authorities_revoked, RotationIdentity,
    },
    coordinator::{
        advance, continuity_value, coordinator_status, prepare_coordinator,
        public_rotation_error_code, report_recoverable, resolve_plan, AdvanceRequest,
        CoordinatorStatus, DesktopPlan,
    },
    crypto::{
        load_handoff_challenge, load_resume_token, purge_staged_secrets, store_handoff_challenge,
        store_resume_token,
    },
    handoff::{IdentityRotationExtensionState, IdentityRotationHandoff},
    inventory::{reconcile_postcommit_provider_lineage, selected_records},
    journal::{
        self, ContinuityJournal, IdentityRotationJournal, RotationAgentJournal, RotationMode,
    },
    local::{
        commit_local, create_recovery_backup, drain_selected_local_runtimes, hosted_canary,
        purge_old_agent_keys, restart_original_local_runtimes, restart_rotated_local_runtimes,
        stage_or_load_keys,
    },
    provider::{discover_rotation_provider, RotationProvider},
};

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdentityRotationPreview {
    mode: RotationMode,
    managed_agent_count: usize,
    hosted_agent_count: usize,
    agent_names: Vec<String>,
    recovery_backup_required: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdentityRotationRendererContinuity {
    contract_version: u8,
    rotation_id: String,
    old_owner_public_key: String,
    new_owner_public_key: String,
}

fn renderer_continuity_projection(
    journal: IdentityRotationJournal,
    current_owner_public_key: &str,
) -> Result<Option<IdentityRotationRendererContinuity>, String> {
    let Some(new_owner_public_key) = journal.new_owner_public_key.clone() else {
        return Err("identity_rotation_journal_corrupt".into());
    };
    let valid_key =
        |value: &str| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !valid_key(&journal.old_owner_public_key)
        || !valid_key(&new_owner_public_key)
        || journal.old_owner_public_key == new_owner_public_key
    {
        return Err("identity_rotation_journal_corrupt".into());
    }
    if current_owner_public_key != new_owner_public_key {
        return Ok(None);
    }
    Ok(Some(IdentityRotationRendererContinuity {
        contract_version: journal.contract_version,
        rotation_id: journal.rotation_id,
        old_owner_public_key: journal.old_owner_public_key,
        new_owner_public_key,
    }))
}

#[tauri::command]
pub(crate) async fn identity_rotation_renderer_continuity(
    app: tauri::AppHandle,
) -> Result<Option<IdentityRotationRendererContinuity>, String> {
    let Some(journal) = journal::latest_committed_owner_rotation(&app)? else {
        return Ok(None);
    };
    let current_owner_public_key = app
        .state::<AppState>()
        .signing_keys()
        .map_err(|_| "identity_rotation_renderer_identity_unavailable".to_string())?
        .public_key()
        .to_hex();
    renderer_continuity_projection(journal, &current_owner_public_key)
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
                error_code: journal.error_code.clone(),
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
    if reconcile_postcommit_provider_lineage(&mut journal, &records, &status)? {
        journal::save(app, &mut journal)?;
    }
    if status.state == "recoverable" {
        emit_progress(
            app,
            &journal.rotation_id,
            "recoverable",
            "Resuming from the last durable coordinator checkpoint…",
            false,
            None,
        );
        status = advance(AdvanceRequest {
            state: &state,
            provider: &provider,
            journal: &journal,
            status: &status,
            action: "resume",
            owner: Some(&new_owner),
            continuity: None,
            error_code: None,
        })
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
        status = advance(AdvanceRequest {
            state: &state,
            provider: &provider,
            journal: &journal,
            status: &status,
            action: "continuity_migrated",
            owner: Some(&new_owner),
            continuity: Some(continuity_value(&journal.continuity, &journal)?),
            error_code: None,
        })
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
        status = advance(AdvanceRequest {
            state: &state,
            provider: &provider,
            journal: &journal,
            status: &status,
            action: "commit",
            owner: Some(&new_owner),
            continuity: None,
            error_code: None,
        })
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
        signed_owner_relay_canary(&state, &journal.relay_url, &new_owner)
            .await
            .map_err(|error| {
                if super::coordinator::is_public_rotation_error_code(&error) {
                    error
                } else {
                    "identity_rotation_owner_canary_failed".to_string()
                }
            })?;
        emit_progress(
            app,
            &journal.rotation_id,
            "canary_verified",
            "Waiting for every replacement hosted agent to answer its private canary…",
            false,
            None,
        );
        hosted_canary(&state, &journal, &new_owner, &status)
            .await
            .map_err(|error| {
                if super::coordinator::is_public_rotation_error_code(&error) {
                    error
                } else {
                    "identity_rotation_hosted_canary_failed".to_string()
                }
            })?;
        for item in &mut journal.agents {
            if item.hosted {
                item.canary_verified = true;
            }
        }
        status = advance(AdvanceRequest {
            state: &state,
            provider: &provider,
            journal: &journal,
            status: &status,
            action: "canary_verified",
            owner: Some(&new_owner),
            continuity: None,
            error_code: None,
        })
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
        // Archive lineage is a durable, idempotent checkpoint. Persist it
        // before any authority removal so a crash never discards verified
        // relay evidence or repeats destructive work blindly.
        journal::save(app, &mut journal)?;
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
        revoke_old_channel_authorities(&state, &journal.relay_url, &owner_pair, &pairs).await?;
        status = advance(AdvanceRequest {
            state: &state,
            provider: &provider,
            journal: &journal,
            status: &status,
            action: "old_revoked",
            owner: Some(&new_owner),
            continuity: Some(continuity_value(&journal.continuity, &journal)?),
            error_code: None,
        })
        .await?;
        journal.state = "old_revoked".into();
        journal::save(app, &mut journal)?;
    }

    if status.state == "old_revoked" {
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
        let owner_pair = RotationIdentity {
            old: &old_owner,
            new: &new_owner,
            old_auth_tag: None,
            new_auth_tag: None,
        };
        emit_progress(
            app,
            &journal.rotation_id,
            "old_revoked",
            "Verifying every prior relay identity is explicitly denied...",
            false,
            None,
        );
        verify_old_relay_authorities_revoked(&state, &journal.relay_url, &owner_pair, &pairs)
            .await?;
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
            match advance(AdvanceRequest {
                state: &state,
                provider: &provider,
                journal: &journal,
                status: &status,
                action: "complete",
                owner: Some(&new_owner),
                continuity: None,
                error_code: None,
            })
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
        return Err(status
            .error_code
            .as_deref()
            .filter(|code| super::coordinator::is_public_rotation_error_code(code))
            .unwrap_or("identity_rotation_coordinator_recoverable")
            .to_string());
    }
    purge_old_agent_keys(&staged)?;
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
            let mut public_code = public_rotation_error_code(&code);
            if let Ok(Some(mut journal)) = journal::load(&app, &rotation_id) {
                if public_code == "identity_rotation_internal" && journal.committed_locally {
                    public_code = "identity_rotation_postcommit_internal".into();
                }
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
            error_code: journal.error_code.clone(),
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
            advance(AdvanceRequest {
                state: &state,
                provider: &provider,
                journal: &journal,
                status: &status,
                action: "abort",
                owner: None,
                continuity: None,
                error_code: None,
            })
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
mod renderer_continuity_tests {
    use super::*;

    fn committed_journal() -> IdentityRotationJournal {
        serde_json::from_value(serde_json::json!({
            "contract_version": 1,
            "rotation_id": "20000000-0000-4000-8000-000000000001",
            "coordinator_origin": "https://api.example.com",
            "community_id": "chat.example.com",
            "relay_url": "wss://chat.example.com",
            "mode": "all",
            "selected_agent_public_key": null,
            "state": "recoverable",
            "state_version": 10,
            "challenge_expires_at": "2026-08-21T00:00:00Z",
            "old_owner_public_key": "a".repeat(64),
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
            "committed_locally": true,
            "old_authority_purged": false,
            "error_code": null,
            "created_at": "2026-08-21T00:00:00Z",
            "updated_at": "2026-08-21T00:00:00Z"
        }))
        .unwrap()
    }

    #[test]
    fn renderer_projection_requires_the_exact_committed_replacement() {
        let journal = committed_journal();
        assert!(
            renderer_continuity_projection(journal.clone(), &"c".repeat(64))
                .unwrap()
                .is_none()
        );
        let projection = renderer_continuity_projection(journal, &"b".repeat(64))
            .unwrap()
            .unwrap();
        assert_eq!(projection.old_owner_public_key, "a".repeat(64));
        assert_eq!(projection.new_owner_public_key, "b".repeat(64));
    }

    #[test]
    fn renderer_projection_is_public_key_only_and_rejects_corruption() {
        let projection = renderer_continuity_projection(committed_journal(), &"b".repeat(64))
            .unwrap()
            .unwrap();
        let serialized = serde_json::to_value(projection).unwrap();
        assert_eq!(serialized.as_object().unwrap().len(), 4);
        assert!(serialized.get("providerId").is_none());
        assert!(serialized.get("agents").is_none());
        assert!(serialized.get("recoveryBackupVerified").is_none());

        let mut corrupt = committed_journal();
        corrupt.new_owner_public_key = Some("invalid".into());
        assert_eq!(
            renderer_continuity_projection(corrupt, "invalid").unwrap_err(),
            "identity_rotation_journal_corrupt"
        );
    }
}

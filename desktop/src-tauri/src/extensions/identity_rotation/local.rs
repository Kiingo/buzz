use std::time::Duration;

use nostr::{Keys, ToBech32};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Manager;
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
    coordinator::{CoordinatorStatus, DesktopPlan},
    crypto::{
        compute_agent_auth_tag, load_agent_auth_tag, load_agent_keys, load_human_keys,
        stage_agent_keys, stage_human_keys,
    },
    journal::{self, IdentityRotationJournal, RotationMode},
};

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

pub(super) async fn create_recovery_backup(
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

pub(super) struct StagedAgent {
    pub(super) old_public_key: String,
    pub(super) old: Keys,
    pub(super) new: Keys,
    pub(super) old_auth_tag: Zeroizing<String>,
    pub(super) new_auth_tag: Zeroizing<String>,
    pub(super) hosted: bool,
    pub(super) provider_config: Option<Value>,
}

pub(super) fn stage_or_load_keys(
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

pub(super) fn commit_local(
    app: &tauri::AppHandle,
    journal: &mut IdentityRotationJournal,
    new_owner: &Keys,
    agents: &[StagedAgent],
    status: &CoordinatorStatus,
) -> Result<(), String> {
    // Validate the entire coordinator lineage before changing the human key.
    // A partial provider response must never leave the owner committed while
    // an agent deployment cannot be durably associated with its replacement.
    for agent in agents {
        let replacement_public_key = agent.new.public_key().to_hex();
        let journal_item = journal
            .agents
            .iter()
            .find(|item| item.old_public_key == agent.old_public_key)
            .ok_or_else(|| "identity_rotation_journal_corrupt".to_string())?;
        let status_item = status
            .items
            .iter()
            .find(|item| item.old_public_key == agent.old_public_key)
            .ok_or_else(|| "identity_rotation_coordinator_response_invalid".to_string())?;
        if status_item.new_public_key.as_deref() != Some(replacement_public_key.as_str())
            || status_item.hosted != journal_item.hosted
            || status_item.old_provider_agent_id.as_deref()
                != journal_item.old_provider_agent_id.as_deref()
            || (agent.hosted
                && status_item
                    .new_provider_agent_id
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty()))
        {
            return Err("identity_rotation_coordinator_response_invalid".into());
        }
    }
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
            let journal_item = journal
                .agents
                .iter_mut()
                .find(|journal_item| journal_item.old_public_key == agent.old_public_key)
                .ok_or_else(|| "identity_rotation_journal_corrupt".to_string())?;
            journal_item.new_provider_agent_id = item.new_provider_agent_id.clone();
        }
        record.updated_at = chrono::Utc::now().to_rfc3339();
    }
    save_managed_agents(app, &records)?;
    journal.committed_locally = true;
    journal.state = "committed".into();
    journal::save(app, journal)
}

pub(super) fn drain_selected_local_runtimes(
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

pub(super) fn restart_rotated_local_runtimes(
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

pub(super) fn restart_original_local_runtimes(
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

fn build_hosted_canary_message(
    channel: uuid::Uuid,
    token: &str,
    agent: &str,
    relay_url: &str,
) -> Result<nostr::EventBuilder, String> {
    crate::events::build_message(
        channel,
        &format!("Reply with this exact token only: {token}"),
        None,
        &[agent],
        &[],
        &[],
        &[],
        &[],
        None,
        relay_url,
    )
}

pub(super) async fn hosted_canary(
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
            crate::events::build_dm_open(std::slice::from_ref(agent))?,
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
            build_hosted_canary_message(channel, &token, agent, &journal.relay_url)?,
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

pub(super) fn purge_old_agent_keys(agents: &[StagedAgent]) -> Result<(), String> {
    for agent in agents {
        try_delete_agent_key(&agent.old_public_key)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_canary_explicitly_mentions_its_target_agent() {
        let channel = uuid::Uuid::new_v4();
        let agent = "11".repeat(32);
        let token = "rotation-canary-test";
        let event =
            build_hosted_canary_message(channel, token, &agent, "wss://community.example.test")
                .expect("canary message should build")
                .sign_with_keys(&Keys::generate())
                .expect("canary message should sign");

        assert_eq!(
            event.content,
            format!("Reply with this exact token only: {token}")
        );
        assert!(event.tags.iter().any(|tag| {
            let values = tag.as_slice();
            values.first().map(String::as_str) == Some("p")
                && values.get(1).map(String::as_str) == Some(agent.as_str())
        }));
    }
}

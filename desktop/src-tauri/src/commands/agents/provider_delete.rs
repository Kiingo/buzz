use tauri::{AppHandle, Manager};

use crate::{
    app_state::AppState,
    managed_agents::{
        current_instance_id, load_managed_agents,
        provider_delete::{
            build_provider_delete_owner_proof, community_id_from_relay, prepare_provider_delete,
        },
        resolve_provider_binary, save_managed_agents, stop_managed_agent_process,
        sync_managed_agent_processes, try_regenerate_nest, BackendKind, ManagedAgentRecord,
    },
    relay::{effective_agent_relay_url, relay_ws_url_with_override},
};

use super::{archive_managed_agent_pending, tombstone_managed_agent_pending};

#[derive(Debug, Clone, PartialEq)]
struct AgentDeleteFingerprint {
    pubkey: String,
    persona_id: Option<String>,
    backend: BackendKind,
    backend_agent_id: Option<String>,
    relay_url: String,
}

impl From<&ManagedAgentRecord> for AgentDeleteFingerprint {
    fn from(record: &ManagedAgentRecord) -> Self {
        Self {
            pubkey: record.pubkey.clone(),
            persona_id: record.persona_id.clone(),
            backend: record.backend.clone(),
            backend_agent_id: record.backend_agent_id.clone(),
            relay_url: record.relay_url.clone(),
        }
    }
}

fn assert_delete_fingerprint(
    current: &ManagedAgentRecord,
    expected: &AgentDeleteFingerprint,
) -> Result<(), String> {
    if AgentDeleteFingerprint::from(current) != *expected {
        return Err(format!(
            "agent {} changed while remote deletion was being confirmed; local state was preserved and deletion can be retried",
            expected.pubkey
        ));
    }
    Ok(())
}

fn legacy_delete_guard(force_remote_delete: bool) -> Result<(), String> {
    if force_remote_delete {
        Ok(())
    } else {
        Err("cannot delete a deployed remote agent without force_remote_delete: true".to_string())
    }
}

pub(super) async fn delete_managed_agent(
    pubkey: String,
    force_remote_delete: Option<bool>,
    app: AppHandle,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let snapshot = {
            let _store_guard = state
                .managed_agents_store_lock
                .lock()
                .map_err(|error| error.to_string())?;
            let mut records = load_managed_agents(&app)?;
            let mut runtimes = state
                .managed_agent_processes
                .lock()
                .map_err(|error| error.to_string())?;
            let (sync_changed, exited_pubkeys) = sync_managed_agent_processes(
                &mut records,
                &mut runtimes,
                &current_instance_id(&app),
            );
            if sync_changed {
                save_managed_agents(&app, &records)?;
            }
            for exited in &exited_pubkeys {
                state.clear_agent_session_caches(exited);
            }
            records
                .iter()
                .find(|record| record.pubkey == pubkey)
                .cloned()
                .ok_or_else(|| format!("agent {pubkey} not found"))?
        };
        let fingerprint = AgentDeleteFingerprint::from(&snapshot);

        let mut confirmed_owner: Option<String> = None;
        let mut confirmed_relay: Option<String> = None;
        if let (
            BackendKind::Provider { id: provider_id, .. },
            Some(provider_agent_id),
        ) = (&snapshot.backend, snapshot.backend_agent_id.as_deref())
        {
            let binary = resolve_provider_binary(provider_id)?;
            let prepared = prepare_provider_delete(&binary)?;
            if prepared.protocol_version() == 1 {
                legacy_delete_guard(force_remote_delete.unwrap_or(false))?;
            } else if !prepared.supports_confirmed_delete() {
                return Err(format!(
                    "provider {provider_id} does not advertise confirmed delete; delete the remote agent first"
                ));
            } else {
                // Provider inspection and deletion use the same staged bytes.
                // The proof contains no URL, revision, or provider lifecycle state.
                let owner_keys = state.signing_keys()?;
                let owner_public_key = owner_keys.public_key().to_hex();
                let effective_relay = effective_agent_relay_url(
                    &snapshot.relay_url,
                    &relay_ws_url_with_override(&state),
                );
                let community_id = community_id_from_relay(&effective_relay)?;
                let request_id = uuid::Uuid::new_v4().to_string();
                let owner_proof = build_provider_delete_owner_proof(
                    &owner_keys,
                    provider_id,
                    &request_id,
                    provider_agent_id,
                    &community_id,
                )?;
                prepared
                    .confirm_delete(&request_id, provider_agent_id, owner_proof)
                    .map_err(|error| {
                        format!(
                            "provider could not confirm deletion of {}: {error}; local state was preserved",
                            snapshot.name
                        )
                    })?;
                confirmed_owner = Some(owner_public_key);
                confirmed_relay = Some(effective_relay);
            }
        }

        // Re-read mutable scope before the local commit. A retry safely
        // rediscovers a terminal provider endpoint after either conflict.
        if let Some(expected_owner) = confirmed_owner.as_deref() {
            let current_owner = state.signing_keys()?.public_key().to_hex();
            if current_owner != expected_owner {
                return Err(
                    "active identity changed while remote deletion was being confirmed; local state was preserved and deletion can be retried"
                        .to_string(),
                );
            }
        }
        let current_workspace_relay = relay_ws_url_with_override(&state);

        {
            let _store_guard = state
                .managed_agents_store_lock
                .lock()
                .map_err(|error| error.to_string())?;
            let mut records = load_managed_agents(&app)?;
            let mut runtimes = state
                .managed_agent_processes
                .lock()
                .map_err(|error| error.to_string())?;
            let (sync_changed, exited_pubkeys) = sync_managed_agent_processes(
                &mut records,
                &mut runtimes,
                &current_instance_id(&app),
            );
            if sync_changed {
                save_managed_agents(&app, &records)?;
            }
            for exited in &exited_pubkeys {
                state.clear_agent_session_caches(exited);
            }

            let current = records
                .iter()
                .find(|record| record.pubkey == pubkey)
                .ok_or_else(|| {
                    format!(
                        "agent {pubkey} changed while remote deletion was being confirmed; local state was preserved"
                    )
                })?;
            assert_delete_fingerprint(current, &fingerprint)?;
            if let Some(expected_relay) = confirmed_relay.as_deref() {
                let current_relay =
                    effective_agent_relay_url(&current.relay_url, &current_workspace_relay);
                if current_relay != expected_relay {
                    return Err(
                        "active community changed while remote deletion was being confirmed; local state was preserved and deletion can be retried"
                            .to_string(),
                    );
                }
            }

            let persona_id = current.persona_id.clone();
            let current = records
                .iter_mut()
                .find(|record| record.pubkey == pubkey)
                .ok_or_else(|| format!("agent {pubkey} not found"))?;
            stop_managed_agent_process(&app, current, &mut runtimes)?;
            state.clear_agent_session_caches(&pubkey);
            records.retain(|record| record.pubkey != pubkey);
            save_managed_agents(&app, &records)?;
            crate::managed_agents::delete_agent_key(&pubkey);
            tombstone_managed_agent_pending(&app, &state, &pubkey);
            archive_managed_agent_pending(&app, &state, &pubkey, persona_id.as_deref());
        }
        try_regenerate_nest(&app);
        Ok(())
    })
    .await
    .map_err(|error| format!("spawn_blocking failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> ManagedAgentRecord {
        serde_json::from_value(serde_json::json!({
            "pubkey": "agent", "name": "Agent", "relay_url": "", "acp_command": "",
            "agent_command": "", "agent_args": [], "mcp_command": "",
            "turn_timeout_seconds": 0, "system_prompt": null, "created_at": "",
            "updated_at": "", "last_started_at": null, "last_stopped_at": null,
            "last_exit_code": null, "last_error": null,
            "backend": {"type": "provider", "id": "example", "config": {"region": "west"}},
            "backend_agent_id": "remote-1", "persona_id": "persona-1"
        }))
        .expect("record")
    }

    #[test]
    fn direct_delete_fingerprint_covers_remote_identity_and_configuration() {
        let original = record();
        let fingerprint = AgentDeleteFingerprint::from(&original);
        assert!(assert_delete_fingerprint(&original, &fingerprint).is_ok());

        let mut changed = original.clone();
        changed.backend_agent_id = Some("remote-2".to_string());
        assert!(assert_delete_fingerprint(&changed, &fingerprint).is_err());
        changed = original.clone();
        changed.backend = BackendKind::Provider {
            id: "example".to_string(),
            config: serde_json::json!({"region": "east"}),
        };
        assert!(assert_delete_fingerprint(&changed, &fingerprint).is_err());
        changed = original;
        changed.persona_id = Some("persona-2".to_string());
        assert!(assert_delete_fingerprint(&changed, &fingerprint).is_err());
    }

    #[test]
    fn only_confirmed_protocol_v1_preserves_the_legacy_force_bypass() {
        assert!(legacy_delete_guard(false).is_err());
        assert!(legacy_delete_guard(true).is_ok());
    }
}

use std::collections::{BTreeMap, HashSet};

use tauri::{AppHandle, Manager};

use crate::{
    app_state::AppState,
    managed_agents::{
        current_instance_id, delete_agent_key, load_managed_agents, load_personas, load_teams,
        provider_delete::{
            build_provider_delete_owner_proof, community_id_from_relay, prepare_provider_delete,
            PreparedProviderDelete,
        },
        resolve_provider_binary, save_managed_agents, save_personas, stop_managed_agent_process,
        sync_managed_agent_processes, try_regenerate_nest, validate_persona_deletion, BackendKind,
        ManagedAgentRecord,
    },
    relay::{effective_agent_relay_url, relay_ws_url_with_override},
};

use super::{collect_cascade_pubkeys, commit_cascade_agents, tombstone_persona_pending};

#[derive(Debug, Clone, PartialEq)]
struct ProviderCascadeFingerprint {
    pubkey: String,
    persona_id: Option<String>,
    backend: BackendKind,
    backend_agent_id: Option<String>,
    relay_url: String,
}

impl From<&ManagedAgentRecord> for ProviderCascadeFingerprint {
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

#[derive(Debug, Clone)]
struct ProviderCascadeTarget {
    name: String,
    provider_id: String,
    provider_agent_id: String,
    fingerprint: ProviderCascadeFingerprint,
}

fn provider_cascade_targets(
    agents: &[ManagedAgentRecord],
    cascade: &HashSet<String>,
) -> Vec<ProviderCascadeTarget> {
    let mut targets = agents
        .iter()
        .filter_map(|record| {
            if !cascade.contains(&record.pubkey) {
                return None;
            }
            let BackendKind::Provider { id, .. } = &record.backend else {
                return None;
            };
            let provider_agent_id = record.backend_agent_id.clone()?;
            Some(ProviderCascadeTarget {
                name: record.name.clone(),
                provider_id: id.clone(),
                provider_agent_id,
                fingerprint: ProviderCascadeFingerprint::from(record),
            })
        })
        .collect::<Vec<_>>();
    targets.sort_by(|left, right| left.fingerprint.pubkey.cmp(&right.fingerprint.pubkey));
    targets
}

fn manual_workflow_error(persona_id: &str, targets: &[ProviderCascadeTarget]) -> String {
    let names = targets
        .iter()
        .map(|target| target.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "persona {persona_id} has provider-deployed agent instances ({names}); delete those agent instances first"
    )
}

fn require_confirmed_delete_preflight(
    persona_id: &str,
    targets: &[ProviderCascadeTarget],
    mut supports_confirmed_delete: impl FnMut(&str) -> bool,
) -> Result<(), String> {
    let mut every_target_is_supported = true;
    for target in targets {
        if !supports_confirmed_delete(&target.provider_id) {
            every_target_is_supported = false;
        }
    }
    if every_target_is_supported {
        Ok(())
    } else {
        Err(manual_workflow_error(persona_id, targets))
    }
}

fn run_remote_deletes<T>(
    targets: &[T],
    mut invoke: impl FnMut(&T) -> Result<(), String>,
) -> Result<(), String> {
    for target in targets {
        invoke(target)?;
    }
    Ok(())
}

fn assert_cascade_revalidated(
    persona_id: &str,
    expected_cascade: &HashSet<String>,
    expected_providers: &[ProviderCascadeTarget],
    current_agents: &[ManagedAgentRecord],
) -> Result<(), String> {
    let current_cascade: HashSet<String> = collect_cascade_pubkeys(current_agents, persona_id)
        .into_iter()
        .collect();
    if &current_cascade != expected_cascade {
        return Err(format!(
            "persona {persona_id} agent instances changed while remote deletion was being confirmed; local state was preserved and deletion can be retried"
        ));
    }
    for expected in expected_providers {
        let current = current_agents
            .iter()
            .find(|record| record.pubkey == expected.fingerprint.pubkey)
            .ok_or_else(|| {
                format!(
                    "persona {persona_id} agent instances changed while remote deletion was being confirmed; local state was preserved"
                )
            })?;
        if ProviderCascadeFingerprint::from(current) != expected.fingerprint {
            return Err(format!(
                "provider agent {} changed while remote deletion was being confirmed; local state was preserved and deletion can be retried",
                expected.name
            ));
        }
    }
    Ok(())
}

pub(super) async fn delete_persona(id: String, app: AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let (cascade, targets, initial_d_tag) = {
            let _store_guard = state
                .managed_agents_store_lock
                .lock()
                .map_err(|error| error.to_string())?;
            let personas = load_personas(&app)?;
            let persona = personas
                .iter()
                .find(|record| record.id == id)
                .ok_or_else(|| format!("persona {id} not found"))?;
            let referenced_by_team = load_teams(&app)?.iter().any(|team| {
                team.persona_ids
                    .iter()
                    .any(|persona_id| persona_id == id.as_str())
            });
            validate_persona_deletion(persona, referenced_by_team)?;
            let d_tag = crate::managed_agents::persona_events::persona_d_tag(persona);

            let mut agents = load_managed_agents(&app)?;
            let mut runtimes = state
                .managed_agent_processes
                .lock()
                .map_err(|error| error.to_string())?;
            let (sync_changed, exited_pubkeys) = sync_managed_agent_processes(
                &mut agents,
                &mut runtimes,
                &current_instance_id(&app),
            );
            if sync_changed {
                save_managed_agents(&app, &agents)?;
            }
            for pubkey in &exited_pubkeys {
                state.clear_agent_session_caches(pubkey);
            }
            drop(runtimes);

            let cascade: HashSet<String> = collect_cascade_pubkeys(&agents, &id)
                .into_iter()
                .collect();
            let targets = provider_cascade_targets(&agents, &cascade);
            (cascade, targets, d_tag)
        };

        // Negotiate every distinct provider before the first remote mutation.
        // Sessions retain the exact immutable bytes inspected during preflight.
        let mut providers = BTreeMap::<String, PreparedProviderDelete>::new();
        for target in &targets {
            if !providers.contains_key(&target.provider_id) {
                let binary = resolve_provider_binary(&target.provider_id)?;
                let prepared = prepare_provider_delete(&binary).map_err(|error| {
                    format!(
                        "could not inspect provider {} before deleting persona {id}: {error}; no agents were deleted",
                        target.provider_id
                    )
                })?;
                providers.insert(target.provider_id.clone(), prepared);
            }
        }
        require_confirmed_delete_preflight(&id, &targets, |provider_id| {
            providers.get(provider_id).is_some_and(|provider| {
                provider.protocol_version() == 2 && provider.supports_confirmed_delete()
            })
        })?;

        let mut confirmed_owner: Option<String> = None;
        let mut confirmed_workspace_relay: Option<String> = None;
        if !targets.is_empty() {
            let owner_keys = state.signing_keys()?;
            let owner_public_key = owner_keys.public_key().to_hex();
            let workspace_relay = relay_ws_url_with_override(&state);

            run_remote_deletes(&targets, |target| {
                let request_id = uuid::Uuid::new_v4().to_string();
                let effective_relay = effective_agent_relay_url(
                    &target.fingerprint.relay_url,
                    &workspace_relay,
                );
                let community_id = community_id_from_relay(&effective_relay)?;
                let proof = build_provider_delete_owner_proof(
                    &owner_keys,
                    &target.provider_id,
                    &request_id,
                    &target.provider_agent_id,
                    &community_id,
                )?;
                providers
                    .get(&target.provider_id)
                    .ok_or_else(|| "provider delete preflight was lost".to_string())?
                    .confirm_delete(&request_id, &target.provider_agent_id, proof)
                    .map_err(|error| {
                        format!(
                            "provider could not confirm deletion of {}: {error}; local persona and agent records were preserved and deletion can be retried",
                            target.name
                        )
                })
            })?;
            confirmed_owner = Some(owner_public_key);
            confirmed_workspace_relay = Some(workspace_relay);
        }

        if let Some(expected_owner) = confirmed_owner.as_deref() {
            if state.signing_keys()?.public_key().to_hex() != expected_owner {
                return Err(
                    "active identity changed while persona deletion was being confirmed; local state was preserved and deletion can be retried"
                        .to_string(),
                );
            }
        }
        let current_workspace_relay = relay_ws_url_with_override(&state);
        if let Some(expected_workspace_relay) = confirmed_workspace_relay.as_deref() {
            if current_workspace_relay != expected_workspace_relay {
                return Err(
                    "active community changed while persona deletion was being confirmed; local state was preserved and deletion can be retried"
                        .to_string(),
                );
            }
        }

        {
            let _store_guard = state
                .managed_agents_store_lock
                .lock()
                .map_err(|error| error.to_string())?;
            let mut personas = load_personas(&app)?;
            let persona = personas
                .iter()
                .find(|record| record.id == id)
                .ok_or_else(|| {
                    format!(
                        "persona {id} changed while remote deletion was being confirmed; local state was preserved"
                    )
                })?;
            let referenced_by_team = load_teams(&app)?.iter().any(|team| {
                team.persona_ids
                    .iter()
                    .any(|persona_id| persona_id == id.as_str())
            });
            validate_persona_deletion(persona, referenced_by_team)?;
            if crate::managed_agents::persona_events::persona_d_tag(persona) != initial_d_tag {
                return Err(format!(
                    "persona {id} changed while remote deletion was being confirmed; local state was preserved and deletion can be retried"
                ));
            }

            let mut agents = load_managed_agents(&app)?;
            {
                let mut runtimes = state
                    .managed_agent_processes
                    .lock()
                    .map_err(|error| error.to_string())?;
                let (sync_changed, exited_pubkeys) = sync_managed_agent_processes(
                    &mut agents,
                    &mut runtimes,
                    &current_instance_id(&app),
                );
                if sync_changed {
                    save_managed_agents(&app, &agents)?;
                }
                for pubkey in &exited_pubkeys {
                    state.clear_agent_session_caches(pubkey);
                }
            }
            assert_cascade_revalidated(&id, &cascade, &targets, &agents)?;

            for pubkey in &cascade {
                if let Some(record) = agents.iter_mut().find(|record| record.pubkey == *pubkey) {
                    let mut runtimes = state
                        .managed_agent_processes
                        .lock()
                        .map_err(|error| error.to_string())?;
                    if let Err(error) = stop_managed_agent_process(&app, record, &mut runtimes) {
                        eprintln!(
                            "buzz-desktop: delete_persona: failed to stop agent {pubkey}: {error}"
                        );
                    }
                }
            }
            if !cascade.is_empty() {
                commit_cascade_agents(&mut agents, &cascade, |records| {
                    save_managed_agents(&app, records)
                })?;
            }
            personas.retain(|record| record.id != id);
            save_personas(&app, &personas)?;

            for pubkey in &cascade {
                state.clear_agent_session_caches(pubkey);
                delete_agent_key(pubkey);
                super::super::agents::tombstone_managed_agent_pending(&app, &state, pubkey);
                super::super::agents::archive_managed_agent_pending(
                    &app,
                    &state,
                    pubkey,
                    Some(&id),
                );
            }
            tombstone_persona_pending(&app, &state, &initial_d_tag);
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

    fn record(pubkey: &str, provider_id: Option<&str>) -> ManagedAgentRecord {
        let backend = provider_id.map_or_else(
            || serde_json::json!({"type": "local"}),
            |id| serde_json::json!({"type": "provider", "id": id, "config": {}}),
        );
        serde_json::from_value(serde_json::json!({
            "pubkey": pubkey, "name": pubkey, "persona_id": "persona-1",
            "relay_url": "", "acp_command": "", "agent_command": "",
            "agent_args": [], "mcp_command": "", "turn_timeout_seconds": 0,
            "system_prompt": null, "created_at": "", "updated_at": "",
            "last_started_at": null, "last_stopped_at": null,
            "last_exit_code": null, "last_error": null, "backend": backend,
            "backend_agent_id": provider_id.map(|_| format!("remote-{pubkey}"))
        }))
        .expect("record")
    }

    #[test]
    fn mixed_provider_preflight_names_every_remote_target_without_mutation() {
        let agents = vec![
            record("v2", Some("confirmed")),
            record("v1", Some("legacy")),
        ];
        let cascade: HashSet<String> = agents.iter().map(|agent| agent.pubkey.clone()).collect();
        let targets = provider_cascade_targets(&agents, &cascade);
        assert_eq!(targets.len(), 2);
        assert_eq!(
            manual_workflow_error("persona-1", &targets),
            "persona persona-1 has provider-deployed agent instances (v1, v2); delete those agent instances first"
        );
        let mut provider_inspections = 0;
        let result = require_confirmed_delete_preflight("persona-1", &targets, |provider_id| {
            provider_inspections += 1;
            provider_id == "confirmed"
        });
        assert!(result.is_err());
        assert_eq!(provider_inspections, 2);
    }

    #[test]
    fn remote_failure_stops_the_sequence_before_any_local_commit_stage() {
        let targets = ["first", "second", "third"];
        let mut invoked = Vec::new();
        let result = run_remote_deletes(&targets, |target| {
            invoked.push(*target);
            if *target == "second" {
                Err("remote failure".to_string())
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        assert_eq!(invoked, vec!["first", "second"]);

        invoked.clear();
        run_remote_deletes(&targets, |target| {
            invoked.push(*target);
            Ok(())
        })
        .expect("retry after partial remote success");
        assert_eq!(invoked, targets);
    }

    #[test]
    fn successful_remote_sequence_allows_the_existing_cascade_commit() {
        let mut agents = vec![record("remote", Some("confirmed")), record("local", None)];
        let cascade: HashSet<String> = agents.iter().map(|agent| agent.pubkey.clone()).collect();
        let targets = provider_cascade_targets(&agents, &cascade);
        let mut remote_confirmations = Vec::new();
        run_remote_deletes(&targets, |target| {
            remote_confirmations.push(target.fingerprint.pubkey.clone());
            Ok(())
        })
        .expect("all remote confirmations");
        let mut persisted = false;
        commit_cascade_agents(&mut agents, &cascade, |_| {
            persisted = true;
            Ok(())
        })
        .expect("local cascade commit");
        assert_eq!(remote_confirmations, ["remote"]);
        assert!(persisted);
        assert!(agents.is_empty());
    }

    #[test]
    fn exact_cascade_and_provider_fingerprints_are_revalidated() {
        let original = vec![record("remote", Some("confirmed")), record("local", None)];
        let cascade: HashSet<String> = original.iter().map(|agent| agent.pubkey.clone()).collect();
        let targets = provider_cascade_targets(&original, &cascade);
        assert!(assert_cascade_revalidated("persona-1", &cascade, &targets, &original).is_ok());

        let mut added = original.clone();
        added.push(record("new", None));
        assert!(assert_cascade_revalidated("persona-1", &cascade, &targets, &added).is_err());

        let mut changed = original;
        changed[0].backend_agent_id = Some("remote-changed".to_string());
        assert!(assert_cascade_revalidated("persona-1", &cascade, &targets, &changed).is_err());
    }
}

use tauri::AppHandle;

use crate::{
    app_state::AppState,
    managed_agents::{
        build_managed_agent_summary, find_managed_agent_mut, load_global_agent_config,
        load_managed_agents, load_personas, save_managed_agents, validate_provider_config,
        validate_provider_presentation_snapshot, BackendKind, ManagedAgentRecord,
        ManagedAgentSummary,
    },
    util::now_iso,
};

/// Apply local model/provider/prompt edits while preserving definition-owned
/// values on linked instances.
pub(super) fn apply_model_provider_prompt_update(
    record: &mut ManagedAgentRecord,
    model: Option<Option<String>>,
    provider: Option<Option<String>>,
    system_prompt: Option<Option<String>>,
) {
    if record.persona_id.is_some() {
        return;
    }
    if let Some(model_update) = model {
        record.model = model_update;
    }
    if let Some(provider_update) = provider {
        record.provider = provider_update;
    }
    if let Some(prompt_update) = system_prompt {
        record.system_prompt = prompt_update;
    }
}

pub(super) struct PendingProviderUpdate {
    provider_id: String,
    config: serde_json::Value,
    cached_binary_path: Option<String>,
    agent_json: serde_json::Value,
    previous_backend: BackendKind,
    previous_system_prompt: Option<String>,
}

/// Keep prompt-only hosted edits on the same optimistic revision contract as
/// provider execution-profile edits. Providers without a revision field are
/// still redeployed; revision ownership remains with providers that advertise
/// it in their generic config schema.
pub(super) fn apply_provider_prompt_revision(
    current: &BackendKind,
    next: &mut BackendKind,
    current_prompt: Option<&str>,
    next_prompt: Option<&str>,
) -> Result<bool, String> {
    if current_prompt.and_then(normalized_provider_prompt)
        == next_prompt.and_then(normalized_provider_prompt)
    {
        return Ok(false);
    }
    let (
        BackendKind::Provider {
            id: current_id,
            config: current_config,
            ..
        },
        BackendKind::Provider {
            id: next_id,
            config: next_config,
            ..
        },
    ) = (current, next)
    else {
        return Ok(false);
    };
    if current_id != next_id {
        return Err("Changing the remote provider requires creating a new agent so its identity cannot be moved accidentally.".to_string());
    }

    let current_revision = current_config
        .get("profile_revision")
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|raw| raw.parse().ok()))
        })
        .filter(|revision| *revision > 0);
    let Some(current_revision) = current_revision else {
        return Ok(true);
    };
    let next_revision = next_config
        .get("profile_revision")
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|raw| raw.parse().ok()))
        })
        .unwrap_or(current_revision);
    if next_revision == current_revision {
        next_config
            .as_object_mut()
            .ok_or_else(|| "provider config must be an object".to_string())?
            .insert(
                "profile_revision".to_string(),
                serde_json::Value::Number((current_revision + 1).into()),
            );
    } else if next_revision != current_revision + 1 {
        return Err("provider profile revision changed unexpectedly".to_string());
    }
    Ok(true)
}

fn normalized_provider_prompt(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Apply one definition-owned prompt revision to every linked provider
/// instance. Local instances keep resolving the live definition directly.
pub(super) fn apply_definition_prompt_revisions(
    records: &mut [ManagedAgentRecord],
    persona_id: &str,
    current_prompt: &str,
    next_prompt: &str,
) -> Result<Vec<String>, String> {
    let current_prompt = normalized_provider_prompt(current_prompt);
    let next_prompt = normalized_provider_prompt(next_prompt);
    if current_prompt == next_prompt {
        return Ok(Vec::new());
    }

    let mut pubkeys = Vec::new();
    for record in records.iter_mut() {
        if record.persona_id.as_deref() != Some(persona_id)
            || !matches!(record.backend, BackendKind::Provider { .. })
        {
            continue;
        }
        let current_backend = record.backend.clone();
        if apply_provider_prompt_revision(
            &current_backend,
            &mut record.backend,
            current_prompt,
            next_prompt,
        )? {
            record.updated_at = now_iso();
            pubkeys.push(record.pubkey.clone());
        }
    }
    Ok(pubkeys)
}

struct DefinitionPromptProviderTarget {
    pubkey: String,
    provider_id: String,
    config: serde_json::Value,
    cached_binary_path: Option<String>,
    agent_json: serde_json::Value,
}

/// Redeploy all linked provider instances after their authoritative definition
/// has been saved. Every target is attempted so one unavailable endpoint does
/// not prevent the remaining agents from receiving the new revision.
pub(super) async fn deploy_definition_prompt_updates(
    app: &AppHandle,
    state: &AppState,
    pubkeys: Vec<String>,
) -> Result<(), String> {
    let mut failures = Vec::new();
    for pubkey in pubkeys {
        let target = (|| -> Result<DefinitionPromptProviderTarget, String> {
            let _store_guard = state
                .managed_agents_store_lock
                .lock()
                .map_err(|error| error.to_string())?;
            let records = load_managed_agents(app)?;
            let record = records
                .iter()
                .find(|record| record.pubkey == pubkey)
                .ok_or_else(|| format!("agent {pubkey} not found"))?;
            let BackendKind::Provider { id, config, .. } = &record.backend else {
                return Err(format!("agent {pubkey} is no longer provider-backed"));
            };
            Ok(DefinitionPromptProviderTarget {
                pubkey: pubkey.clone(),
                provider_id: id.clone(),
                config: config.clone(),
                cached_binary_path: record.provider_binary_path.clone(),
                agent_json: super::agents::build_deploy_payload(app, state, record)?,
            })
        })();
        let target = match target {
            Ok(target) => target,
            Err(error) => {
                failures.push(error);
                continue;
            }
        };
        if let Err(error) = super::agents::deploy_to_provider(
            app,
            state,
            &target.pubkey,
            &target.provider_id,
            &target.config,
            target.agent_json,
            target.cached_binary_path.as_deref(),
        )
        .await
        {
            failures.push(error);
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "The agent definition was saved, but {} hosted instance(s) could not be updated yet. Retry starting the affected agent after checking its provider connection: {}",
            failures.len(),
            failures[0]
        ))
    }
}

pub(super) fn validate_requested_provider_backend(
    requested: Option<&BackendKind>,
) -> Result<(), String> {
    if let Some(BackendKind::Provider { config, .. }) = requested {
        validate_provider_config(config)?;
    }
    Ok(())
}

/// Produce an in-place provider profile update while keeping the execution
/// provider and remote identity stable. `profile_revision` is desktop-owned
/// when present in the provider schema: callers cannot skip or replay a
/// revision by editing the read-only field in the webview.
pub(super) fn updated_provider_backend(
    current: &BackendKind,
    requested: &BackendKind,
) -> Result<Option<BackendKind>, String> {
    let (
        BackendKind::Provider {
            id: current_id,
            config: current_config,
            name: current_name,
            summary: current_summary,
        },
        BackendKind::Provider {
            id: requested_id,
            config: requested_config,
            name: requested_name,
            summary: requested_summary,
        },
    ) = (current, requested)
    else {
        return Err(
            "Changing an existing agent between this computer and a remote provider requires creating a new agent."
                .to_string(),
        );
    };
    if current_id != requested_id {
        return Err(
            "Changing the remote provider requires creating a new agent so its identity cannot be moved accidentally."
                .to_string(),
        );
    }
    validate_provider_config(requested_config)?;
    validate_provider_presentation_snapshot(requested_name, requested_summary)?;

    let presentation_changed =
        current_name != requested_name || current_summary != requested_summary;

    let mut next = requested_config.clone();
    let current_revision = current_config
        .get("profile_revision")
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|raw| raw.parse().ok()))
        })
        .filter(|revision| *revision > 0);
    if let Some(current_revision) = current_revision {
        let current_without_revision = {
            let mut value = current_config.clone();
            value
                .as_object_mut()
                .expect("validated provider config is an object")
                .remove("profile_revision");
            value
        };
        let next_without_revision = {
            let mut value = next.clone();
            value
                .as_object_mut()
                .expect("validated provider config is an object")
                .remove("profile_revision");
            value
        };
        if current_without_revision == next_without_revision && !presentation_changed {
            return Ok(None);
        }
        if current_without_revision != next_without_revision {
            next.as_object_mut()
                .expect("validated provider config is an object")
                .insert(
                    "profile_revision".to_string(),
                    serde_json::Value::Number((current_revision + 1).into()),
                );
        } else {
            next.as_object_mut()
                .expect("validated provider config is an object")
                .insert(
                    "profile_revision".to_string(),
                    serde_json::Value::Number(current_revision.into()),
                );
        }
    } else if current_config == &next && !presentation_changed {
        return Ok(None);
    }

    Ok(Some(BackendKind::Provider {
        id: current_id.clone(),
        config: next,
        name: requested_name.clone(),
        summary: requested_summary.clone(),
    }))
}

pub(super) fn provider_update_required(
    record: &ManagedAgentRecord,
    previous_record: &ManagedAgentRecord,
) -> bool {
    record.backend != previous_record.backend
        || (matches!(record.backend, BackendKind::Provider { .. })
            && record.system_prompt != previous_record.system_prompt)
}

pub(super) fn prepare_provider_update(
    app: &AppHandle,
    state: &AppState,
    record: &ManagedAgentRecord,
    previous_record: &ManagedAgentRecord,
) -> Result<Option<PendingProviderUpdate>, String> {
    if !provider_update_required(record, previous_record) {
        return Ok(None);
    }
    let BackendKind::Provider { id, config, .. } = &record.backend else {
        unreachable!("provider updates cannot switch execution kind")
    };
    Ok(Some(PendingProviderUpdate {
        provider_id: id.clone(),
        config: config.clone(),
        cached_binary_path: record.provider_binary_path.clone(),
        agent_json: super::agents::build_deploy_payload(app, state, record)?,
        previous_backend: previous_record.backend.clone(),
        previous_system_prompt: previous_record.system_prompt.clone(),
    }))
}

pub(super) async fn apply_provider_update(
    app: &AppHandle,
    state: &AppState,
    summary: ManagedAgentSummary,
    update: Option<PendingProviderUpdate>,
) -> Result<ManagedAgentSummary, String> {
    let Some(update) = update else {
        return Ok(summary);
    };
    if let Err(error) = super::agents::deploy_to_provider(
        app,
        state,
        &summary.pubkey,
        &update.provider_id,
        &update.config,
        update.agent_json,
        update.cached_binary_path.as_deref(),
    )
    .await
    {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|lock_error| lock_error.to_string())?;
        let mut records = load_managed_agents(app)?;
        let record = find_managed_agent_mut(&mut records, &summary.pubkey)?;
        record.backend = update.previous_backend;
        record.system_prompt = update.previous_system_prompt;
        record.updated_at = now_iso();
        save_managed_agents(app, &records)?;
        return Err(format!(
            "Hosted execution settings were not changed: {error}"
        ));
    }

    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|lock_error| lock_error.to_string())?;
    let records = load_managed_agents(app)?;
    let runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|lock_error| lock_error.to_string())?;
    let record = records
        .iter()
        .find(|record| record.pubkey == summary.pubkey)
        .ok_or_else(|| format!("agent {} not found", summary.pubkey))?;
    build_managed_agent_summary(
        app,
        record,
        &runtimes,
        &load_personas(app).unwrap_or_default(),
        &load_global_agent_config(app).unwrap_or_default(),
    )
}

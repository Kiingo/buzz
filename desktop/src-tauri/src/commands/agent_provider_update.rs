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

pub(super) fn prepare_provider_update(
    app: &AppHandle,
    state: &AppState,
    record: &ManagedAgentRecord,
    previous_record: &ManagedAgentRecord,
) -> Result<Option<PendingProviderUpdate>, String> {
    if record.backend == previous_record.backend {
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

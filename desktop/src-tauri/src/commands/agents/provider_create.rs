use tauri::AppHandle;

use crate::managed_agents::{
    load_global_agent_config, load_personas, probe_provider_info, provider_owns_execution_profile,
    resolve_provider_binary, validate_provider_config, BackendKind, CreateManagedAgentRequest,
};

/// Validate one provider-backed create request and stamp the capability derived
/// from the platform-verified provider. Local creates are a no-op.
pub(super) async fn prepare_provider_backend(
    backend: &mut BackendKind,
) -> Result<Option<String>, String> {
    let (id, config) = match backend {
        BackendKind::Local => return Ok(None),
        BackendKind::Provider { id, config, .. } => (id.clone(), config.clone()),
    };
    validate_provider_config(&config)?;
    let path = resolve_provider_binary(&id)?;
    let probe_path = path.clone();
    let info = tokio::task::spawn_blocking(move || probe_provider_info(&probe_path))
        .await
        .map_err(|error| format!("spawn_blocking failed: {error}"))??;
    backend.set_owns_execution_profile(provider_owns_execution_profile(&info));
    Ok(Some(path.display().to_string()))
}

/// Refuse a desktop-only shared-compute selection before a non-owning remote
/// record is persisted. Provider-owned backends reach this point only after a
/// platform-verified probe and therefore do not use Buzz's desktop mesh.
pub(super) fn validate_remote_execution_profile(
    app: &AppHandle,
    input: &CreateManagedAgentRequest,
) -> Result<(), String> {
    if !matches!(input.backend, BackendKind::Provider { .. })
        || input.backend.owns_execution_profile()
    {
        return Ok(());
    }

    let definition_provider = if let Some(persona_id) = input.persona_id.as_deref() {
        load_personas(app)?
            .into_iter()
            .find(|persona| persona.id == persona_id)
            .and_then(|persona| persona.provider)
    } else {
        None
    };
    let global_provider = load_global_agent_config(app)?.provider;
    let provider = definition_provider
        .or_else(|| input.provider.clone())
        .or(global_provider);

    super::deploy::ensure_remote_provider_supported(provider.as_deref(), false)
}

use tauri::AppHandle;

use crate::{
    app_state::AppState,
    managed_agents::{
        discover_provider_candidates, load_managed_agents, provider_config_sha256, provider_deploy,
        resolve_provider_binary, save_managed_agents, BackendKind, ManagedAgentRecord,
    },
    util::now_iso,
};

/// Deploy an agent to a provider backend. Resolves the binary, calls deploy via
/// spawn_blocking, and persists the result (backend_agent_id or last_error).
///
/// Idempotency: calling deploy on an already-deployed agent sends the same payload
/// again. Providers are expected to handle this as an update-in-place or no-op —
/// the protocol does not include an explicit `undeploy` operation (deferred to v2).
///
/// Returns Ok(()) on success, Err(message) on failure. Either way the record is
/// updated and saved before returning.
pub(in crate::commands) async fn deploy_to_provider(
    app: &AppHandle,
    state: &AppState,
    pubkey: &str,
    provider_id: &str,
    config: &serde_json::Value,
    agent_json: serde_json::Value,
    cached_binary_path: Option<&str>,
) -> Result<(), String> {
    // Resolve via discovered candidates only. Cached path must match BOTH
    // "is a discovered candidate" AND "belongs to this provider_id". A tampered
    // record cannot redirect deploys to a different provider's binary.
    let bin_path = cached_binary_path
        .map(std::path::PathBuf::from)
        .filter(|p| p.exists())
        .map(|p| p.canonicalize().unwrap_or(p))
        .filter(|canonical| {
            discover_provider_candidates().iter().any(|(id, cp)| {
                id == provider_id && cp.canonicalize().ok().as_ref() == Some(canonical)
            })
        })
        .map_or_else(|| resolve_provider_binary(provider_id), Ok)?;

    let config_hash = provider_config_sha256(config)?;
    let relay_url = agent_json
        .get("relay_url")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "provider deploy payload is missing relay_url".to_string())?;
    let relay = url::Url::parse(relay_url)
        .map_err(|error| format!("provider deploy relay_url is invalid: {error}"))?;
    if relay.scheme() != "wss"
        || relay.username() != ""
        || relay.password().is_some()
        || relay.query().is_some()
        || relay.fragment().is_some()
        || (relay.path() != "/" && !relay.path().is_empty())
    {
        return Err("provider deploy relay_url must be a bare wss community URL".to_string());
    }
    let community_id = relay
        .host_str()
        .ok_or_else(|| "provider deploy relay_url has no community host".to_string())?;
    let normalized_relay_url = match relay.port() {
        Some(port) => format!("wss://{community_id}:{port}"),
        None => format!("wss://{community_id}"),
    };
    let proof_request_id = uuid::Uuid::new_v4().to_string();
    let proof_content = serde_json::json!({
        "version": 1,
        "action": "deploy",
        "provider_id": provider_id,
        "request_id": proof_request_id,
        "community_id": community_id,
        "relay_url": normalized_relay_url,
        "agent_public_key": pubkey,
        "provider_config_sha256": config_hash,
        "expires_at": chrono::Utc::now().timestamp() + 300,
    });
    let owner_proof = nostr::EventBuilder::new(
        nostr::Kind::Custom(27236),
        serde_json::to_string(&proof_content)
            .map_err(|error| format!("failed to serialize provider proof: {error}"))?,
    )
    .sign_with_keys(&state.signing_keys()?)
    .map_err(|error| format!("failed to sign provider deployment proof: {error}"))?;
    let owner_proof = serde_json::to_value(owner_proof)
        .map_err(|error| format!("failed to serialize provider deployment proof: {error}"))?;
    let config_clone = config.clone();
    let deploy_result = tokio::task::spawn_blocking(move || {
        provider_deploy(&bin_path, &agent_json, &config_clone, Some(&owner_proof))
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?;

    // Persist result under lock.
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let mut records = load_managed_agents(app)?;
    let rec = records
        .iter_mut()
        .find(|r| r.pubkey == pubkey)
        .ok_or_else(|| format!("agent {pubkey} not found"))?;

    match deploy_result {
        Ok((backend_agent_id, lifecycle_state)) => {
            if rec
                .backend_agent_id
                .as_deref()
                .is_some_and(|existing| existing != backend_agent_id.as_str())
            {
                let error = "provider returned a different remote agent id for an in-place update"
                    .to_string();
                rec.last_error = Some(error.clone());
                rec.updated_at = now_iso();
                save_managed_agents(app, &records)?;
                return Err(error);
            }
            rec.backend_agent_id = Some(backend_agent_id);
            rec.provider_lifecycle_state = lifecycle_state;
            rec.last_started_at = Some(now_iso());
            rec.updated_at = now_iso();
            rec.last_error = None;
        }
        Err(ref e) => {
            rec.last_error = Some(e.clone());
            rec.updated_at = now_iso();
            save_managed_agents(app, &records)?;
            return Err(e.clone());
        }
    }
    save_managed_agents(app, &records)?;
    Ok(())
}

fn provider_profile_revision(config: &serde_json::Value) -> u64 {
    config
        .get("profile_revision")
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|raw| raw.parse().ok()))
        })
        .filter(|value| *value > 0)
        .unwrap_or(1)
}

pub(in crate::commands) fn control_provider_record(
    state: &AppState,
    record: &ManagedAgentRecord,
    operation: &str,
) -> Result<crate::managed_agents::ProviderLifecycleState, String> {
    let BackendKind::Provider { id, config, .. } = &record.backend else {
        return Err("agent is not provider-backed".to_string());
    };
    let agent_id = record
        .backend_agent_id
        .as_deref()
        .ok_or_else(|| "remote agent has no provider deployment id".to_string())?;
    let revision = provider_profile_revision(config);
    let proof_request_id = uuid::Uuid::new_v4().to_string();
    let proof_content = serde_json::json!({
        "version": 1,
        "action": operation,
        "provider_id": id,
        "request_id": proof_request_id,
        "provider_agent_id": agent_id,
        "expected_profile_revision": revision,
        "expires_at": chrono::Utc::now().timestamp() + 300,
    });
    let owner_proof = nostr::EventBuilder::new(
        nostr::Kind::Custom(27236),
        serde_json::to_string(&proof_content)
            .map_err(|error| format!("failed to serialize provider proof: {error}"))?,
    )
    .sign_with_keys(&state.signing_keys()?)
    .map_err(|error| format!("failed to sign provider control proof: {error}"))?;
    let owner_proof = serde_json::to_value(owner_proof)
        .map_err(|error| format!("failed to serialize provider control proof: {error}"))?;
    let binary = resolve_provider_binary(id)?;
    let response = crate::managed_agents::provider_control(
        &binary,
        operation,
        agent_id,
        revision,
        &owner_proof,
    )?;
    crate::managed_agents::parse_provider_lifecycle_state(&response)
}

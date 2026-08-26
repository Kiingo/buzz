use nostr::{Keys, ToBech32};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;
use zeroize::Zeroizing;

use crate::app_state::AppState;

use super::{
    crypto::{
        build_rotation_proof, load_handoff_challenge, load_human_keys, load_resume_token,
        sha256_hex, RotationProofRequest,
    },
    journal::{ContinuityJournal, IdentityRotationJournal, RotationMode},
    local::StagedAgent,
    provider::{
        discover_rotation_provider, prepare_identity_envelope, PrepareIdentityEnvelopeRequest,
        RotationProvider,
    },
};

const MAX_COORDINATOR_RESPONSE: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
pub(super) struct HostedInventory {
    pub(super) public_key: String,
    pub(super) provider_agent_id: String,
    pub(super) provider_config_sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct Inventory {
    pub(super) hosted_agents: Vec<HostedInventory>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct DesktopPlan {
    pub(super) contract_version: u8,
    pub(super) rotation_id: String,
    pub(super) mode: RotationMode,
    pub(super) community_id: String,
    pub(super) relay_url: String,
    pub(super) old_owner_public_key: String,
    pub(super) selected_agent_public_key: Option<String>,
    pub(super) challenge_expires_at: String,
    pub(super) inventory: Inventory,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct RotationItemStatus {
    pub(super) old_public_key: String,
    pub(super) new_public_key: Option<String>,
    pub(super) hosted: bool,
    pub(super) old_provider_agent_id: Option<String>,
    pub(super) new_provider_agent_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct CoordinatorStatus {
    pub(super) contract_version: u8,
    pub(super) rotation_id: String,
    pub(super) mode: RotationMode,
    pub(super) state: String,
    pub(super) state_version: u32,
    pub(super) old_owner_public_key: String,
    pub(super) new_owner_public_key: Option<String>,
    #[serde(default)]
    pub(super) error_code: Option<String>,
    pub(super) items: Vec<RotationItemStatus>,
}

#[derive(Debug, Deserialize)]
pub(super) struct PrepareResponse {
    pub(super) resume_token: String,
    pub(super) status: CoordinatorStatus,
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

pub(super) fn is_public_rotation_error_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 96
        && (code.starts_with("identity_rotation_") || code.starts_with("buzz_identity_rotation_"))
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

pub(super) fn public_rotation_error_code(error: &str) -> String {
    if is_public_rotation_error_code(error) {
        error.to_string()
    } else if error.contains("backup file already exists") {
        "identity_rotation_backup_file_exists".into()
    } else if error.contains("actor not authorized: must be admin or owner") {
        "identity_rotation_relay_membership_admin_required".into()
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

pub(super) async fn resolve_plan(
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
        || plan.inventory.hosted_agents.iter().any(|hosted| {
            hosted.provider_config_sha256.len() != 64
                || !hosted
                    .provider_config_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
        || (!allow_expired && expires < chrono::Utc::now())
    {
        return Err("identity_rotation_plan_invalid".into());
    }
    Ok(plan)
}

fn proofs(
    keys: &Keys,
    journal: &IdentityRotationJournal,
    action: &str,
    old: &str,
    new: &str,
) -> Result<Value, String> {
    let challenge = load_handoff_challenge(&journal.rotation_id)?;
    let challenge_hash = sha256_hex(challenge.as_bytes());
    build_rotation_proof(RotationProofRequest {
        keys,
        rotation_id: &journal.rotation_id,
        action,
        challenge_hash: &challenge_hash,
        community_id: &journal.community_id,
        old_public_key: old,
        new_public_key: new,
        proof_kind: journal.proof_kind,
        proof_content: &journal.proof_content,
    })
}

pub(super) async fn prepare_coordinator(
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
            let provider_config_sha256 =
                agent.provider_config_sha256.as_deref().ok_or_else(|| {
                    "identity_rotation_hosted_provider_config_hash_missing".to_string()
                })?;
            Some(
                prepare_identity_envelope(PrepareIdentityEnvelopeRequest {
                    provider,
                    rotation_id: &journal.rotation_id,
                    community_id: &journal.community_id,
                    relay_url: &journal.relay_url,
                    new_public_key: &agent.new.public_key().to_hex(),
                    private_key_nsec: &nsec,
                    auth_tag: &agent.new_auth_tag,
                    provider_config: config,
                    provider_config_sha256,
                })?
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
        endpoint(
            &provider.coordinator_origin,
            &provider.prepare_path,
            &journal.rotation_id,
        )?,
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

pub(super) struct AdvanceRequest<'a> {
    pub(super) state: &'a AppState,
    pub(super) provider: &'a RotationProvider,
    pub(super) journal: &'a IdentityRotationJournal,
    pub(super) status: &'a CoordinatorStatus,
    pub(super) action: &'a str,
    pub(super) owner: Option<&'a Keys>,
    pub(super) continuity: Option<Value>,
    pub(super) error_code: Option<&'a str>,
}

pub(super) async fn advance(input: AdvanceRequest<'_>) -> Result<CoordinatorStatus, String> {
    let resume = load_resume_token(&input.journal.rotation_id)?;
    let owner_proof = match input.owner {
        Some(owner) => Some(proofs(
            owner,
            input.journal,
            input.action,
            &input.journal.old_owner_public_key,
            input
                .journal
                .new_owner_public_key
                .as_deref()
                .ok_or_else(|| "identity_rotation_journal_corrupt".to_string())?,
        )?),
        None => None,
    };
    let value = post_json(
        input.state,
        endpoint(
            &input.provider.coordinator_origin,
            &input.provider.advance_path,
            &input.journal.rotation_id,
        )?,
        &json!({
            "contract_version": 1,
            "resume_token": resume.as_str(),
            "expected_state_version": input.status.state_version,
            "action": input.action,
            "owner_proof": owner_proof,
            "continuity": input.continuity,
            "error_code": input.error_code
        }),
    )
    .await?;
    serde_json::from_value(value)
        .map_err(|_| "identity_rotation_coordinator_response_invalid".to_string())
}

pub(super) async fn coordinator_status(
    state: &AppState,
    provider: &RotationProvider,
    journal: &IdentityRotationJournal,
    current: &CoordinatorStatus,
) -> Result<CoordinatorStatus, String> {
    advance(AdvanceRequest {
        state,
        provider,
        journal,
        status: current,
        action: "status",
        owner: None,
        continuity: None,
        error_code: None,
    })
    .await
}

pub(super) async fn report_recoverable(
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
        error_code: journal.error_code.clone(),
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
    advance(AdvanceRequest {
        state: &state,
        provider: &provider,
        journal,
        status: &status,
        action: "report_recoverable",
        owner: Some(&new_owner),
        continuity: None,
        error_code: Some(error_code),
    })
    .await?;
    Ok(())
}

pub(super) fn continuity_value(
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

    #[test]
    fn local_failures_are_mapped_to_actionable_public_codes() {
        assert_eq!(
            public_rotation_error_code("backup file already exists; choose another"),
            "identity_rotation_backup_file_exists"
        );
        assert_eq!(
            public_rotation_error_code(
                "relay rejected event: actor not authorized: must be admin or owner"
            ),
            "identity_rotation_relay_membership_admin_required"
        );
    }
}

use std::{path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::managed_agents::{
    discover_provider_candidates, invoke_provider, invoke_provider_sensitive,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct RotationProvider {
    pub provider_id: String,
    #[serde(skip)]
    pub binary: PathBuf,
    pub coordinator_origin: String,
    pub resolve_path: String,
    pub prepare_path: String,
    pub advance_path: String,
    pub proof_kind: u16,
    pub proof_content: String,
}

#[derive(Debug, Deserialize)]
struct CapabilityResponse {
    ok: bool,
    contract_version: u8,
    coordinator_origin: String,
    resolve_path: String,
    prepare_path: String,
    advance_path: String,
    proof_kind: u16,
    proof_content: String,
}

fn valid_relative_path(value: &str) -> bool {
    value.starts_with('/') && !value.starts_with("//") && !value.contains(['?', '#'])
}

fn parse_capability(
    provider_id: String,
    binary: PathBuf,
    requested_origin: &str,
    response: Value,
) -> Result<RotationProvider, String> {
    let value: CapabilityResponse = serde_json::from_value(response)
        .map_err(|_| "identity_rotation_provider_contract_invalid".to_string())?;
    if !value.ok
        || value.contract_version != 1
        || value.coordinator_origin.trim_end_matches('/') != requested_origin.trim_end_matches('/')
        || !valid_relative_path(&value.resolve_path)
        || !valid_relative_path(&value.prepare_path)
        || !valid_relative_path(&value.advance_path)
        || !value.advance_path.contains("{rotation_id}")
        || value.proof_kind != 27_236
        || value.proof_content != "buzz-identity-rotation-v1"
    {
        return Err("identity_rotation_provider_contract_invalid".into());
    }
    Ok(RotationProvider {
        provider_id,
        binary,
        coordinator_origin: requested_origin.trim_end_matches('/').to_string(),
        resolve_path: value.resolve_path,
        prepare_path: value.prepare_path,
        advance_path: value.advance_path,
        proof_kind: value.proof_kind,
        proof_content: value.proof_content,
    })
}

/// Find the single installed provider whose signed catalog authorizes this
/// coordinator. Ambiguity fails closed instead of picking a PATH winner.
pub(crate) fn discover_rotation_provider(origin: &str) -> Result<RotationProvider, String> {
    let mut accepted = Vec::new();
    for (provider_id, binary) in discover_provider_candidates() {
        let request = serde_json::json!({
            "op": "identity_rotation_capabilities",
            "coordinator_origin": origin
        });
        let Ok(response) = invoke_provider(&binary, &request, Duration::from_secs(15)) else {
            continue;
        };
        if let Ok(provider) = parse_capability(provider_id, binary, origin, response) {
            accepted.push(provider);
        }
    }
    match accepted.len() {
        1 => Ok(accepted.remove(0)),
        0 => Err("identity_rotation_provider_unavailable".into()),
        _ => Err("identity_rotation_provider_ambiguous".into()),
    }
}

#[derive(Serialize)]
struct RotationContext<'a> {
    rotation_id: &'a str,
    community_id: &'a str,
    new_public_key: &'a str,
}

#[derive(Serialize)]
struct SensitiveAgent<'a> {
    private_key_nsec: &'a str,
    auth_tag: &'a str,
    relay_url: &'a str,
}

#[derive(Serialize)]
struct SensitivePrepareRequest<'a> {
    op: &'static str,
    coordinator_origin: &'a str,
    provider_config: &'a Value,
    rotation: RotationContext<'a>,
    agent: SensitiveAgent<'a>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PreparedIdentityEnvelope {
    pub rotation_id: String,
    pub agent_public_key: String,
    pub provider_config_sha256: String,
    pub identity_envelope: Value,
}

pub(crate) struct PrepareIdentityEnvelopeRequest<'a> {
    pub(crate) provider: &'a RotationProvider,
    pub(crate) rotation_id: &'a str,
    pub(crate) community_id: &'a str,
    pub(crate) relay_url: &'a str,
    pub(crate) new_public_key: &'a str,
    pub(crate) private_key_nsec: &'a Zeroizing<String>,
    pub(crate) auth_tag: &'a Zeroizing<String>,
    pub(crate) provider_config: &'a Value,
}

pub(crate) fn prepare_identity_envelope(
    input: PrepareIdentityEnvelopeRequest<'_>,
) -> Result<PreparedIdentityEnvelope, String> {
    let request = SensitivePrepareRequest {
        op: "prepare_identity_rotation",
        coordinator_origin: &input.provider.coordinator_origin,
        provider_config: input.provider_config,
        rotation: RotationContext {
            rotation_id: input.rotation_id,
            community_id: input.community_id,
            new_public_key: input.new_public_key,
        },
        agent: SensitiveAgent {
            private_key_nsec: input.private_key_nsec,
            auth_tag: input.auth_tag,
            relay_url: input.relay_url,
        },
    };
    let serialized = Zeroizing::new(
        serde_json::to_string(&request)
            .map_err(|_| "identity_rotation_provider_request_failed".to_string())?
            + "\n",
    );
    let raw = invoke_provider_sensitive(
        &input.provider.binary,
        &serialized,
        &[input.private_key_nsec.as_str(), input.auth_tag.as_str()],
        Duration::from_secs(30),
    )?;
    let rendered = serde_json::to_string(&raw)
        .map_err(|_| "identity_rotation_provider_response_invalid".to_string())?;
    if rendered.contains("nsec1")
        || rendered.contains("private_key_nsec")
        || rendered.contains(input.auth_tag.as_str())
    {
        return Err("identity_rotation_provider_leaked_private_material".into());
    }
    let prepared: PreparedIdentityEnvelope = serde_json::from_value(raw)
        .map_err(|_| "identity_rotation_provider_response_invalid".to_string())?;
    if prepared.rotation_id != input.rotation_id
        || prepared.agent_public_key != input.new_public_key
        || prepared.provider_config_sha256.len() != 64
        || !prepared
            .provider_config_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || !prepared.identity_envelope.is_object()
    {
        return Err("identity_rotation_provider_response_invalid".into());
    }
    Ok(prepared)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(origin: &str) -> Value {
        serde_json::json!({
            "ok": true,
            "contract_version": 1,
            "coordinator_origin": origin,
            "resolve_path": "/identity-rotations/resolve",
            "prepare_path": "/identity-rotations/prepare",
            "advance_path": "/identity-rotations/{rotation_id}/advance",
            "proof_kind": 27236,
            "proof_content": "buzz-identity-rotation-v1"
        })
    }

    #[test]
    fn capability_is_exact_origin_and_contract_bound() {
        let provider = parse_capability(
            "example-provider".into(),
            PathBuf::from("provider"),
            "https://api.example.com/buzz",
            response("https://api.example.com/buzz"),
        )
        .unwrap();
        assert_eq!(provider.provider_id, "example-provider");
        assert!(parse_capability(
            "example-provider".into(),
            PathBuf::from("provider"),
            "https://evil.example.com",
            response("https://api.example.com/buzz"),
        )
        .is_err());
    }

    #[test]
    fn capability_rejects_cross_origin_paths() {
        let mut value = response("https://api.example.com/buzz");
        value["prepare_path"] = Value::String("//evil.example.com".into());
        assert!(parse_capability(
            "example-provider".into(),
            PathBuf::from("provider"),
            "https://api.example.com/buzz",
            value,
        )
        .is_err());
    }
}

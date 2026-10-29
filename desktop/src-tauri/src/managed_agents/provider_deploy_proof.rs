//! Owner-proven provider deploys (protocol v2 `deploy_prepare` /
//! `deploy_submit`).
//!
//! A hosted provision counts as the owner's only with a fresh, single-use
//! owner proof bound to the exact request body. The provider cannot sign for
//! the owner, so a deploy runs in two invocations of the same staged copy:
//!
//! 1. `deploy_prepare` builds the provision body without sending it and
//!    returns it with its SHA-256 (`payload_sha256`, over the canonical JSON:
//!    object keys sorted recursively, arrays in order, compact).
//! 2. The desktop checks the body is for this agent and says what the
//!    desktop asked for (provider config, instructions, who it answers),
//!    recomputes the hash itself, and signs that hash in a kind-27236
//!    `buzz-provider-owner-v1` proof with the owner's keys. The keys never
//!    leave the desktop: the provider sees only the signed event.
//! 3. `deploy_submit` sends that body, unchanged, with the proof. The proof is
//!    single-use, so a retry runs prepare and signs again.
//!
//! A provider that predates this answers `deploy_prepare` with
//! `{"ok":false,"error":"operation_unsupported"}`, and the desktop falls back
//! to the single `deploy`. Any other prepare failure is a deploy failure.

use std::{path::Path, time::Duration};

use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
use sha2::{Digest, Sha256};

use super::backend::{env_secrets_from_request, invoke_provider_allow_failure_redacting};

const PREPARE_TIMEOUT: Duration = Duration::from_secs(600);
const SUBMIT_TIMEOUT: Duration = Duration::from_secs(600);
const OWNER_PROOF_KIND: u16 = 27_236;
const OWNER_PROOF_CONTENT: &str = "buzz-provider-owner-v1";
const OWNER_PROOF_TTL_SECONDS: u64 = 5 * 60;
/// What a provider without `deploy_prepare` answers for an unknown op.
const OPERATION_UNSUPPORTED: &str = "operation_unsupported";
/// Largest integer JSON.stringify and serde_json render identically (and
/// that JavaScript parses exactly).
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// The owner who signs a deploy's proof, and the provider id the proof names
/// (the same id the preflight proof uses).
pub struct DeployOwner {
    pub keys: Keys,
    pub provider_id: String,
}

/// Run the owner-proven deploy on one staged provider copy.
///
/// Returns `Ok(None)` when the provider does not support `deploy_prepare`
/// (the caller then runs the single `deploy`). Otherwise returns the
/// provider's final response: the `deploy_submit` response, or the
/// `deploy_prepare` failure, both in the `deploy` response shape. Local
/// failures (a body for another agent, a hash mismatch, no owner keys) fail
/// closed before anything is submitted.
pub(super) fn deploy_with_owner_proof(
    staged: &Path,
    agent: &serde_json::Value,
    provider_config: &serde_json::Value,
    agent_pubkey: &str,
    owner: Result<&DeployOwner, &str>,
) -> Result<Option<serde_json::Value>, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let prepare_request = serde_json::json!({
        "op": "deploy_prepare",
        "request_id": request_id,
        "agent": agent,
        "provider_config": provider_config,
    });
    let secrets = env_secrets_from_request(&prepare_request);
    let prepared = invoke_provider_allow_failure_redacting(
        staged,
        &prepare_request,
        PREPARE_TIMEOUT,
        &secrets,
    )?;
    if prepared.get("ok").and_then(serde_json::Value::as_bool) == Some(false) {
        if prepared.get("error").and_then(serde_json::Value::as_str) == Some(OPERATION_UNSUPPORTED)
        {
            return Ok(None);
        }
        return Ok(Some(prepared));
    }
    let scope = validate_prepare_response(&prepared, &request_id, agent_pubkey)?;
    validate_prepared_intent(scope.prepared_body, agent, provider_config)?;
    let owner = owner.map_err(|reason| {
        format!("Buzz couldn't sign this change as you, so nothing was deployed: {reason}")
    })?;
    let owner_proof = build_deploy_owner_proof_at(
        &owner.keys,
        &owner.provider_id,
        &request_id,
        &scope,
        Timestamp::now(),
    )?;
    let submit_request = serde_json::json!({
        "op": "deploy_submit",
        "request_id": request_id,
        "prepared_body": scope.prepared_body,
        "owner_proof": owner_proof,
    });
    invoke_provider_allow_failure_redacting(staged, &submit_request, SUBMIT_TIMEOUT, &secrets)
        .map(Some)
}

/// What a successful `deploy_prepare` binds the owner proof to.
#[derive(Debug)]
struct PreparedDeploy<'a> {
    prepared_body: &'a serde_json::Value,
    agent_public_key: &'a str,
    community_id: &'a str,
    /// Recomputed by the desktop from `prepared_body`; the provider's own
    /// hash is only compared against it, never signed.
    payload_sha256: String,
}

fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn validate_prepare_response<'a>(
    response: &'a serde_json::Value,
    request_id: &str,
    agent_pubkey: &str,
) -> Result<PreparedDeploy<'a>, String> {
    let text = |field: &str| response.get(field).and_then(serde_json::Value::as_str);
    if response.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("provider deploy_prepare response must contain ok: true".to_string());
    }
    if text("request_id") != Some(request_id) {
        return Err("provider prepared a deploy for a different request".to_string());
    }
    let prepared_body = response
        .get("prepared_body")
        .filter(|body| body.is_object())
        .ok_or_else(|| {
            "provider deploy_prepare response missing object prepared_body".to_string()
        })?;
    let body_text = |field: &str| prepared_body.get(field).and_then(serde_json::Value::as_str);
    if body_text("request_id") != Some(request_id) {
        return Err("provider prepared a deploy body for a different request".to_string());
    }
    if prepared_body.get("owner_proof").is_some() {
        return Err("provider prepared a deploy body that already carries a proof".to_string());
    }
    let agent_public_key = text("agent_public_key")
        .filter(|key| is_lower_hex_64(key))
        .ok_or_else(|| "provider deploy_prepare response missing agent_public_key".to_string())?;
    if !is_lower_hex_64(agent_pubkey)
        || agent_public_key != agent_pubkey
        || body_text("agent_public_key") != Some(agent_pubkey)
    {
        return Err("provider prepared a deploy for a different agent".to_string());
    }
    let community_id = text("community_id")
        .filter(|community| !community.is_empty())
        .ok_or_else(|| "provider deploy_prepare response missing community_id".to_string())?;
    if body_text("community_id") != Some(community_id) {
        return Err("provider prepared a deploy body for a different community".to_string());
    }
    let provider_sha256 = text("payload_sha256")
        .filter(|hash| is_lower_hex_64(hash))
        .ok_or_else(|| "provider deploy_prepare response missing payload_sha256".to_string())?;
    let payload_sha256 = canonical_sha256_hex(prepared_body)?;
    if payload_sha256 != provider_sha256 {
        return Err("provider prepared a deploy body that does not match its hash".to_string());
    }
    Ok(PreparedDeploy {
        prepared_body,
        agent_public_key,
        community_id,
        payload_sha256,
    })
}

/// The shape of a value in a prepared provision body.
enum Shape {
    Text,
    Integer,
    TextOrNull,
    TextList,
    EmptyList,
    /// Compared whole against what the desktop sent ([`validate_prepared_intent`]).
    Sent,
    /// Exactly these keys: `(name, shape, required)`. Any other key refuses.
    Object(&'static [(&'static str, Shape, bool)]),
}

const MODE_AND_ID: &[(&str, Shape, bool)] =
    &[("mode", Shape::Text, true), ("id", Shape::Text, false)];
const EXECUTION: &[(&str, Shape, bool)] = &[
    ("version", Shape::Integer, true),
    (
        "harness",
        Shape::Object(&[("mode", Shape::Text, true), ("id", Shape::Text, true)]),
        true,
    ),
    ("model", Shape::Object(MODE_AND_ID), true),
    (
        "reasoning",
        Shape::Object(&[("mode", Shape::Text, true), ("effort", Shape::Text, false)]),
        true,
    ),
    ("service_tier", Shape::Object(MODE_AND_ID), true),
];
/// Every key a hosted provision body may carry, at every level. Nothing here
/// can name tools, skills, MCP servers, environment or credential routing:
/// the capability policy must be empty, and a new field is refused until the
/// desktop knows it, so the owner never signs a grant it was not shown.
const PREPARED_BODY: &[(&str, Shape, bool)] = &[
    ("contract_version", Shape::Integer, true),
    ("request_id", Shape::Text, true),
    ("idempotency_key", Shape::Text, true),
    ("community_id", Shape::Text, true),
    ("relay_url", Shape::Text, true),
    ("agent_public_key", Shape::Text, true),
    ("display_name", Shape::Text, true),
    ("provider_config", Shape::Sent, true),
    ("owner_attestation", Shape::Text, true),
    (
        "identity_envelope",
        Shape::Object(&[
            ("version", Shape::Integer, true),
            ("algorithm", Shape::Text, true),
            ("key_id", Shape::Text, true),
            ("ephemeral_public_key", Shape::Text, true),
            ("nonce", Shape::Text, true),
            ("ciphertext", Shape::Text, true),
            ("associated_data_sha256", Shape::Text, true),
        ]),
        true,
    ),
    (
        "execution_profile",
        Shape::Object(&[
            ("version", Shape::Integer, true),
            ("execution_location", Shape::Text, true),
            ("execution", Shape::Object(EXECUTION), true),
            ("capability_catalog_version", Shape::Text, true),
            ("profile_revision", Shape::Integer, true),
        ]),
        true,
    ),
    (
        "agent_instructions",
        Shape::Object(&[
            ("version", Shape::Integer, true),
            ("profile_revision", Shape::Integer, true),
            ("system_prompt", Shape::TextOrNull, true),
        ]),
        true,
    ),
    (
        "response_policy",
        Shape::Object(&[
            ("version", Shape::Integer, true),
            ("respond_to", Shape::Text, true),
            ("respond_to_allowlist", Shape::TextList, true),
        ]),
        true,
    ),
    (
        "capability_policy",
        Shape::Object(&[
            ("version", Shape::Integer, true),
            ("assigned_tools", Shape::EmptyList, true),
            ("assigned_skills", Shape::EmptyList, true),
            ("managed_compute_capabilities", Shape::EmptyList, true),
        ]),
        true,
    ),
    ("kiingo_agent_id", Shape::Text, false),
];
/// The provision contract [`PREPARED_BODY`] describes.
const PREPARED_BODY_CONTRACT_VERSION: u64 = 1;

/// Whether `value` has exactly `shape`, naming the first offending path.
fn check_shape(value: &serde_json::Value, shape: &Shape, path: &str) -> Result<(), String> {
    let matches = match shape {
        Shape::Text => value.is_string(),
        Shape::Integer => value.is_u64() || value.is_i64(),
        Shape::TextOrNull => value.is_string() || value.is_null(),
        Shape::TextList => value
            .as_array()
            .is_some_and(|items| items.iter().all(serde_json::Value::is_string)),
        Shape::EmptyList => value.as_array().is_some_and(Vec::is_empty),
        Shape::Sent => true,
        Shape::Object(fields) => {
            let object = value
                .as_object()
                .ok_or_else(|| format!("provider prepared a deploy with an unexpected {path}"))?;
            if let Some(unknown) = object
                .keys()
                .find(|key| !fields.iter().any(|(name, _, _)| *name == key.as_str()))
            {
                return Err(format!(
                    "provider prepared a deploy with an unexpected field {path}.{unknown}"
                ));
            }
            for (name, field, required) in fields.iter() {
                match object.get(*name) {
                    Some(child) => check_shape(child, field, &format!("{path}.{name}"))?,
                    None if *required => {
                        return Err(format!("provider prepared a deploy without {path}.{name}"))
                    }
                    None => {}
                }
            }
            true
        }
    };
    if matches {
        Ok(())
    } else {
        Err(format!(
            "provider prepared a deploy with an unexpected {path}"
        ))
    }
}

/// The owner signs only what the desktop asked for. The body the provider
/// prepared must have exactly the known provision shape (no key outside
/// [`PREPARED_BODY`] at any level, and no capability grants), and must carry,
/// unchanged, the provider configuration the desktop sent (from which the
/// provider derives `execution_profile`, so its harness must match), the
/// agent's instructions, who the agent answers, its name, the community and
/// relay of the desktop's own agent record, and the agent it attaches to.
fn validate_prepared_intent(
    prepared_body: &serde_json::Value,
    agent: &serde_json::Value,
    provider_config: &serde_json::Value,
) -> Result<(), String> {
    check_shape(prepared_body, &Shape::Object(PREPARED_BODY), "body")?;
    if prepared_body
        .get("contract_version")
        .and_then(serde_json::Value::as_u64)
        != Some(PREPARED_BODY_CONTRACT_VERSION)
    {
        return Err("provider prepared a deploy for an unknown contract version".to_string());
    }
    let refuse = |what: &str| Err(format!("provider prepared a deploy with different {what}"));
    if prepared_body.get("provider_config") != Some(provider_config) {
        return refuse("provider settings");
    }
    let harness = provider_config
        .get("harness")
        .and_then(serde_json::Value::as_str);
    if harness.is_none()
        || prepared_body
            .pointer("/execution_profile/execution/harness/id")
            .and_then(serde_json::Value::as_str)
            != harness
    {
        return refuse("execution settings");
    }
    let (community_id, relay_url) = expected_community(agent)?;
    if prepared_body
        .get("community_id")
        .and_then(serde_json::Value::as_str)
        != Some(community_id.as_str())
        || prepared_body
            .get("relay_url")
            .and_then(serde_json::Value::as_str)
            != Some(relay_url.as_str())
    {
        return refuse("community");
    }
    let kiingo_agent_id = match agent.get("kiingo_agent_id") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(id)) => Some(id.to_ascii_lowercase()),
        Some(_) => return refuse("agent to attach"),
    };
    if prepared_body
        .get("kiingo_agent_id")
        .and_then(serde_json::Value::as_str)
        != kiingo_agent_id.as_deref()
    {
        return refuse("agent to attach");
    }
    let prompt = agent
        .get("system_prompt")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
        .map_or(serde_json::Value::Null, |prompt| prompt.into());
    let Some(instructions) = prepared_body.get("agent_instructions") else {
        return refuse("instructions");
    };
    if instructions.get("system_prompt") != Some(&prompt) {
        return refuse("instructions");
    }
    let respond_to = agent
        .get("respond_to")
        .cloned()
        .unwrap_or_else(|| "owner-only".into());
    let allowlist = agent
        .get("respond_to_allowlist")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let policy = prepared_body.get("response_policy");
    if policy.and_then(|policy| policy.get("respond_to")) != Some(&respond_to)
        || policy.and_then(|policy| policy.get("respond_to_allowlist")) != Some(&allowlist)
    {
        return refuse("access settings");
    }
    if let Some(name) = agent.get("name").and_then(serde_json::Value::as_str) {
        if prepared_body
            .get("display_name")
            .and_then(serde_json::Value::as_str)
            != Some(name)
        {
            return refuse("name");
        }
    }
    Ok(())
}

/// The community and normalized relay the desktop's own agent payload names,
/// as the provision carries them: the relay host, and `wss://host[:port]`.
fn expected_community(agent: &serde_json::Value) -> Result<(String, String), String> {
    let invalid = || "the agent has no valid community relay to deploy to".to_string();
    let relay = agent
        .get("relay_url")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(invalid)?;
    let parsed = url::Url::parse(relay).map_err(|_| invalid())?;
    let host = parsed
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(invalid)?;
    if parsed.scheme() != "wss" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(invalid());
    }
    let relay_url = match parsed.port() {
        Some(port) => format!("wss://{host}:{port}"),
        None => format!("wss://{host}"),
    };
    Ok((host.to_string(), relay_url))
}

fn build_deploy_owner_proof_at(
    keys: &Keys,
    provider_id: &str,
    request_id: &str,
    scope: &PreparedDeploy<'_>,
    created_at: Timestamp,
) -> Result<serde_json::Value, String> {
    if provider_id.is_empty() || request_id.is_empty() {
        return Err("provider deploy proof scope is incomplete".to_string());
    }
    let expires = created_at
        .as_secs()
        .saturating_add(OWNER_PROOF_TTL_SECONDS)
        .to_string();
    let tags = [
        Tag::parse(["action", "provision"]),
        Tag::parse(["provider", provider_id]),
        Tag::parse(["request", request_id]),
        Tag::parse(["agent", scope.agent_public_key]),
        Tag::parse(["community", scope.community_id]),
        Tag::parse(["payload", scope.payload_sha256.as_str()]),
        Tag::parse(["expires", expires.as_str()]),
    ]
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    .map_err(|_| "provider deploy proof contains an invalid scope".to_string())?;
    let event = EventBuilder::new(Kind::Custom(OWNER_PROOF_KIND), OWNER_PROOF_CONTENT)
        .tags(tags)
        .custom_created_at(created_at)
        .sign_with_keys(keys)
        .map_err(|_| "failed to sign provider deploy proof".to_string())?;
    serde_json::to_value(event).map_err(|_| "failed to encode provider deploy proof".to_string())
}

/// SHA-256 hex of [`canonical_json`].
fn canonical_sha256_hex(value: &serde_json::Value) -> Result<String, String> {
    let mut text = String::new();
    canonical_json(value, &mut text)?;
    Ok(hex::encode(Sha256::digest(text.as_bytes())))
}

/// The server's canonical JSON: `JSON.stringify` of the value with object
/// keys sorted (by UTF-16 code units, like `Array.prototype.sort`),
/// recursively. Numbers other than safe integers are refused rather than
/// risk hashing differently from the server.
fn canonical_json(value: &serde_json::Value, out: &mut String) -> Result<(), String> {
    match value {
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::String(_) => {
            out.push_str(&serde_json::to_string(value).map_err(|error| error.to_string())?);
        }
        serde_json::Value::Number(number) => out.push_str(&canonical_number(number)?),
        serde_json::Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                canonical_json(item, out)?;
            }
            out.push(']');
        }
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).map_err(|error| error.to_string())?);
                out.push(':');
                canonical_json(&map[key], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn canonical_number(number: &serde_json::Number) -> Result<String, String> {
    // Only safe integers: a non-integer (even 1.0, which serde_json writes as
    // "1.0" and JavaScript as "1") or a larger integer could hash differently
    // here and on the server, so it is refused.
    let safe = number
        .as_u64()
        .map(|value| value <= MAX_SAFE_INTEGER)
        .or_else(|| {
            number
                .as_i64()
                .map(|value| value.unsigned_abs() <= MAX_SAFE_INTEGER)
        })
        .unwrap_or(false);
    if safe {
        Ok(number.to_string())
    } else {
        Err("provider deploy body contains a number Buzz cannot hash".to_string())
    }
}

#[cfg(test)]
#[path = "provider_deploy_proof_tests.rs"]
mod tests;

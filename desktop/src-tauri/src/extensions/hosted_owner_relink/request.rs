//! Pure request building and response checking for the owner-key re-link.
//!
//! Every owner proof is a kind-27236 event signed by the current key with
//! content `buzz-provider-owner-v1` and an exact ordered tag set. The re-link
//! proof binds the SHA-256 of the canonical body (sorted keys, compact JSON)
//! without the proof, so the API can tell the owner approved exactly these
//! agents. Each body carries a NIP-OA owner attestation for every selected
//! agent and for no other.

use nostr::{EventBuilder, JsonUtil, Keys, Kind, PublicKey, Tag, Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub(super) const OWNER_PROOF_KIND: u16 = 27_236;
pub(super) const OWNER_PROOF_CONTENT: &str = "buzz-provider-owner-v1";
/// The API accepts a proof that expires at most five minutes after signing.
pub(super) const OWNER_PROOF_TTL_SECONDS: u64 = 5 * 60;
/// Agents one re-link request may name.
pub(super) const MAX_REBIND_AGENTS: usize = 20;
const MAX_OWNER_ATTESTATION_BYTES: usize = 512;
const CODE_PREFIX: &str = "buzz_hosted_";

/// One agent the owner chose to re-link.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RebindSelection {
    pub(crate) provider_agent_id: String,
    pub(crate) agent_public_key: String,
}

/// One hosted agent as the list route reports it, reduced to what the
/// re-link view needs.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnerAgent {
    pub(crate) provider_agent_id: String,
    pub(crate) agent_public_key: String,
    pub(crate) display_name: String,
    /// Owner key the API holds, or `None` when it did not say.
    pub(crate) owner_public_key: Option<String>,
    pub(crate) deleted: bool,
}

/// One agent's re-link result.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RebindResult {
    pub(crate) provider_agent_id: String,
    /// `rebound`, `already_current` or `rejected`.
    pub(crate) outcome: String,
    /// Reject code without the `buzz_hosted_` prefix.
    pub(crate) code: Option<String>,
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn bounded_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// A code without the API's `buzz_hosted_` prefix.
pub(super) fn strip_code_prefix(code: &str) -> &str {
    code.strip_prefix(CODE_PREFIX).unwrap_or(code)
}

/// Compact JSON with recursively sorted object keys, byte-compatible with
/// the API's `stableBuzzHostedJSON` for the strings and integers this
/// contract carries.
pub(super) fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(items) => {
            let inner = items.iter().map(canonical_json).collect::<Vec<_>>();
            format!("[{}]", inner.join(","))
        }
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            let inner = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        Value::String(key.clone()),
                        canonical_json(&map[key])
                    )
                })
                .collect::<Vec<_>>();
            format!("{{{}}}", inner.join(","))
        }
        scalar => scalar.to_string(),
    }
}

/// Lowercase hex SHA-256 of [`canonical_json`].
pub(super) fn canonical_sha256(value: &Value) -> String {
    hex::encode(Sha256::digest(canonical_json(value).as_bytes()))
}

fn sign_owner_proof(owner: &Keys, tags: Vec<[String; 2]>, now: u64) -> Result<Value, String> {
    let mut parsed = Vec::with_capacity(tags.len() + 1);
    for tag in tags {
        parsed.push(Tag::parse(tag).map_err(|_| "owner_proof_invalid".to_string())?);
    }
    parsed.push(
        Tag::parse([
            "expires".to_string(),
            (now + OWNER_PROOF_TTL_SECONDS).to_string(),
        ])
        .map_err(|_| "owner_proof_invalid".to_string())?,
    );
    let event = EventBuilder::new(Kind::Custom(OWNER_PROOF_KIND), OWNER_PROOF_CONTENT)
        .tags(parsed)
        .custom_created_at(Timestamp::from(now))
        .sign_with_keys(owner)
        .map_err(|_| "owner_proof_invalid".to_string())?;
    serde_json::from_str(&event.as_json()).map_err(|_| "owner_proof_invalid".to_string())
}

/// A read-only owner request body whose proof has the list shape: exactly
/// `action`, `provider`, `request`, `community` and `expires`, plus any extra
/// body fields (which the list-shaped proof does not bind).
pub(crate) fn build_list_shaped_request(
    owner: &Keys,
    action: &str,
    provider_id: &str,
    community_id: &str,
    request_id: &str,
    extra: Map<String, Value>,
    now: u64,
) -> Result<Value, String> {
    let proof = sign_owner_proof(
        owner,
        vec![
            ["action".into(), action.into()],
            ["provider".into(), provider_id.into()],
            ["request".into(), request_id.into()],
            ["community".into(), community_id.into()],
        ],
        now,
    )?;
    let mut body = extra;
    body.insert("contract_version".into(), json!(1));
    body.insert("request_id".into(), json!(request_id));
    body.insert("owner_proof".into(), proof);
    Ok(Value::Object(body))
}

/// List body: `action=list`, `provider`, `request`, `community`, `expires`.
pub(super) fn build_list_request(
    owner: &Keys,
    provider_id: &str,
    community_id: &str,
    request_id: &str,
    now: u64,
) -> Result<Value, String> {
    let proof = sign_owner_proof(
        owner,
        vec![
            ["action".into(), "list".into()],
            ["provider".into(), provider_id.into()],
            ["request".into(), request_id.into()],
            ["community".into(), community_id.into()],
        ],
        now,
    )?;
    Ok(json!({
        "contract_version": 1,
        "request_id": request_id,
        "owner_proof": proof,
    }))
}

/// Re-link body: one attestation from `owner` per selected agent, then one
/// proof with `action=rebind_owner_key`, `provider`, `request`, an empty
/// `agent`, `community`, `payload` and `expires`.
pub(super) fn build_rebind_request(
    owner: &Keys,
    provider_id: &str,
    community_id: &str,
    request_id: &str,
    selected: &[RebindSelection],
    now: u64,
) -> Result<Value, String> {
    if selected.is_empty() || selected.len() > MAX_REBIND_AGENTS {
        return Err("rebind_selection_invalid".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut agents = Vec::with_capacity(selected.len());
    for agent in selected {
        let key = agent.agent_public_key.to_ascii_lowercase();
        let id = agent.provider_agent_id.trim();
        if id.is_empty() || id.len() > 256 || !is_hex64(&key) || !seen.insert(id.to_string()) {
            return Err("rebind_selection_invalid".into());
        }
        let agent_key =
            PublicKey::from_hex(&key).map_err(|_| "rebind_selection_invalid".to_string())?;
        let attestation = buzz_sdk_pkg::nip_oa::compute_auth_tag(owner, &agent_key, "")
            .map_err(|_| "owner_attestation_invalid".to_string())?;
        if attestation.len() > MAX_OWNER_ATTESTATION_BYTES {
            return Err("owner_attestation_invalid".into());
        }
        agents.push(json!({
            "provider_agent_id": id,
            "agent_public_key": key,
            "owner_attestation": attestation,
        }));
    }
    let mut body = Map::new();
    body.insert("contract_version".into(), json!(1));
    body.insert("request_id".into(), json!(request_id));
    body.insert("agents".into(), Value::Array(agents));
    let payload = canonical_sha256(&Value::Object(body.clone()));
    let proof = sign_owner_proof(
        owner,
        vec![
            ["action".into(), "rebind_owner_key".into()],
            ["provider".into(), provider_id.into()],
            ["request".into(), request_id.into()],
            ["agent".into(), String::new()],
            ["community".into(), community_id.into()],
            ["payload".into(), payload],
        ],
        now,
    )?;
    body.insert("owner_proof".into(), proof);
    Ok(Value::Object(body))
}

fn optional_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Parse a list answer to `request_id`. Malformed agents are skipped.
pub(super) fn parse_list_response(
    body: &Value,
    request_id: &str,
) -> Result<Vec<OwnerAgent>, String> {
    if body.get("contract_version") != Some(&json!(1))
        || optional_str(body, "correlation_id") != Some(request_id)
    {
        return Err("response_invalid".into());
    }
    let agents = body
        .get("agents")
        .and_then(Value::as_array)
        .ok_or_else(|| "response_invalid".to_string())?;
    Ok(agents
        .iter()
        .filter_map(|agent| {
            let id = optional_str(agent, "provider_agent_id")?.trim();
            let key = optional_str(agent, "agent_public_key")?.to_ascii_lowercase();
            let name = optional_str(agent, "display_name")?.trim();
            if id.is_empty() || id.len() > 256 || !is_hex64(&key) || name.chars().count() > 200 {
                return None;
            }
            let owner = optional_str(agent, "owner_public_key")
                .map(str::to_ascii_lowercase)
                .filter(|owner| is_hex64(owner));
            let deleted = optional_str(agent, "desired_state") == Some("deleted")
                || matches!(
                    optional_str(agent, "observed_state"),
                    Some("deleted" | "deletion_pending")
                );
            Some(OwnerAgent {
                provider_agent_id: id.to_string(),
                agent_public_key: key,
                display_name: name.to_string(),
                owner_public_key: owner,
                deleted,
            })
        })
        .collect())
}

/// Parse a re-link answer to `request_id` for `requested`, signed by
/// `owner_public_key`. Every requested agent gets exactly one result: one
/// the answer leaves out is a retryable `result_missing`; a result for an
/// agent that was not requested, or a second one, makes the answer invalid.
pub(super) fn parse_rebind_response(
    body: &Value,
    request_id: &str,
    owner_public_key: &str,
    requested: &[RebindSelection],
) -> Result<Vec<RebindResult>, String> {
    let owner_matches = optional_str(body, "owner_public_key")
        .is_some_and(|owner| owner.eq_ignore_ascii_case(owner_public_key));
    if body.get("contract_version") != Some(&json!(1))
        || optional_str(body, "correlation_id") != Some(request_id)
        || !owner_matches
    {
        return Err("response_invalid".into());
    }
    let results = body
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| "response_invalid".to_string())?;
    let mut by_id = std::collections::HashMap::new();
    for result in results {
        let id = optional_str(result, "provider_agent_id").ok_or("response_invalid")?;
        let key = optional_str(result, "agent_public_key").ok_or("response_invalid")?;
        let wanted = requested
            .iter()
            .find(|agent| agent.provider_agent_id.trim() == id)
            .ok_or("response_invalid")?;
        if !key.eq_ignore_ascii_case(&wanted.agent_public_key) || by_id.contains_key(id) {
            return Err("response_invalid".into());
        }
        let outcome = optional_str(result, "outcome").ok_or("response_invalid")?;
        let code = match outcome {
            "rebound" | "already_current" => None,
            "rejected" => Some(
                optional_str(result, "code")
                    .filter(|code| bounded_code(code))
                    .map(|code| strip_code_prefix(code).to_string())
                    .unwrap_or_else(|| "rebind_failed".into()),
            ),
            _ => return Err("response_invalid".into()),
        };
        by_id.insert(
            id.to_string(),
            RebindResult {
                provider_agent_id: id.to_string(),
                outcome: outcome.to_string(),
                code,
            },
        );
    }
    Ok(requested
        .iter()
        .map(|agent| {
            let id = agent.provider_agent_id.trim();
            by_id.remove(id).unwrap_or_else(|| RebindResult {
                provider_agent_id: id.to_string(),
                outcome: "rejected".into(),
                code: Some("result_missing".into()),
            })
        })
        .collect())
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod tests;

//! Pure request building and response checking for the owner-key re-link.
//!
//! Every owner proof is a kind-27236 event signed by the current key with
//! content `buzz-provider-owner-v1` and an exact ordered tag set. The re-link
//! proof binds the SHA-256 of the canonical body (sorted keys, compact JSON)
//! without the proof, so the API can tell the owner approved exactly these
//! agents. Each body carries a NIP-OA owner attestation for every selected
//! agent and for no other.
//!
//! Two routes take that same body: `rebind-owner-key` (move an agent from an
//! earlier owner key to the current one) and `attest-pending` (vouch for an
//! agent the provider minted and holds pending until its owner attests).
//! They differ only in the proof's `action` tag and in the outcomes.

use nostr::{EventBuilder, JsonUtil, Keys, Kind, PublicKey, Tag, Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub(super) const OWNER_PROOF_KIND: u16 = 27_236;
pub(super) const OWNER_PROOF_CONTENT: &str = "buzz-provider-owner-v1";
/// The API accepts a proof that expires at most five minutes after signing.
pub(super) const OWNER_PROOF_TTL_SECONDS: u64 = 5 * 60;
/// Agents one re-link or attest request may name.
pub(super) const MAX_REBIND_AGENTS: usize = 20;
/// The list's `status` for an agent the provider holds pending until its
/// owner attests it.
pub(crate) const STATUS_PENDING_ATTESTATION: &str = "pending_attestation";
/// The list's `status` for a live agent (and the value when an older
/// provider leaves `status` out).
pub(crate) const STATUS_ACTIVE: &str = "active";
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
    /// `active`, `pending_attestation`, or `unknown` for any other value.
    pub(crate) status: String,
    /// The provider's own id for the agent, when it reports a well-formed one.
    pub(crate) kiingo_agent_id: Option<String>,
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

/// One agent's attest-pending result.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttestResult {
    pub(crate) provider_agent_id: String,
    /// `activated`, `already_active` or `rejected`.
    pub(crate) outcome: String,
    /// Reject code without the `buzz_hosted_` prefix.
    pub(crate) code: Option<String>,
    /// Whether the provider opened the owner DM as the agent.
    pub(crate) dm_opened: bool,
    pub(crate) kiingo_agent_id: Option<String>,
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// A provider agent id as the provider wrote it. Ids are opaque and pass
/// back verbatim, never trimmed or re-cased; one that is blank, too long or
/// has surrounding whitespace or control characters is not usable.
fn is_provider_agent_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn bounded_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// A lowercase canonical UUID (8-4-4-4-12 hex), the only shape an agent id
/// is passed through in.
pub(crate) fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
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
    build_attestation_batch(
        owner,
        "rebind_owner_key",
        "rebind_selection_invalid",
        provider_id,
        community_id,
        request_id,
        selected,
        now,
    )
}

/// Attest-pending body: exactly the re-link body, with
/// `action=attest_pending` in the proof.
pub(super) fn build_attest_pending_request(
    owner: &Keys,
    provider_id: &str,
    community_id: &str,
    request_id: &str,
    selected: &[RebindSelection],
    now: u64,
) -> Result<Value, String> {
    build_attestation_batch(
        owner,
        "attest_pending",
        "attest_selection_invalid",
        provider_id,
        community_id,
        request_id,
        selected,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_attestation_batch(
    owner: &Keys,
    action: &str,
    invalid_code: &str,
    provider_id: &str,
    community_id: &str,
    request_id: &str,
    selected: &[RebindSelection],
    now: u64,
) -> Result<Value, String> {
    if selected.is_empty() || selected.len() > MAX_REBIND_AGENTS {
        return Err(invalid_code.into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut agents = Vec::with_capacity(selected.len());
    for agent in selected {
        let key = agent.agent_public_key.to_ascii_lowercase();
        let id = agent.provider_agent_id.as_str();
        if !is_provider_agent_id(id) || !is_hex64(&key) || !seen.insert(id.to_string()) {
            return Err(invalid_code.into());
        }
        let agent_key = PublicKey::from_hex(&key).map_err(|_| invalid_code.to_string())?;
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
            ["action".into(), action.into()],
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

/// A trimmed display name Buzz shows: 1 to 200 characters, none of them
/// control characters.
fn is_display_name(name: &str) -> bool {
    !name.is_empty() && name.chars().count() <= 200 && !name.chars().any(char::is_control)
}

/// A bidirectional override, embedding, isolate or mark: it can make a name
/// read as something else on screen.
fn is_bidi_control(ch: char) -> bool {
    matches!(ch, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// A provider-supplied name made safe to show: control characters become
/// spaces, bidirectional controls are removed, and the result is trimmed to
/// at most 200 characters. It may come out empty; the renderer then shows a
/// fallback with the agent's key fingerprint.
pub(super) fn printable_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|ch| !is_bidi_control(*ch))
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let trimmed: String = cleaned.trim().chars().take(200).collect();
    trimmed.trim_end().to_string()
}

/// Parse a list answer to `request_id`. Agents with a malformed id or key
/// are skipped; a bad name never drops an agent (so it can still be
/// linked), it is shown cleaned or as a fallback instead.
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
            let id = optional_str(agent, "provider_agent_id")?;
            let key = optional_str(agent, "agent_public_key")?.to_ascii_lowercase();
            let name = printable_name(optional_str(agent, "display_name").unwrap_or_default());
            if !is_provider_agent_id(id) || !is_hex64(&key) {
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
            // An older provider has no `status`; everything it lists is live.
            let status = match agent.get("status") {
                None | Some(Value::Null) => STATUS_ACTIVE,
                Some(Value::String(status)) if status == STATUS_ACTIVE => STATUS_ACTIVE,
                Some(Value::String(status)) if status == STATUS_PENDING_ATTESTATION => {
                    STATUS_PENDING_ATTESTATION
                }
                Some(_) => "unknown",
            };
            let kiingo_agent_id = optional_str(agent, "kiingo_agent_id")
                .map(str::to_ascii_lowercase)
                .filter(|id| is_uuid(id));
            Some(OwnerAgent {
                provider_agent_id: id.to_string(),
                agent_public_key: key,
                display_name: name,
                owner_public_key: owner,
                deleted,
                status: status.to_string(),
                kiingo_agent_id,
            })
        })
        .collect())
}

/// Most agents the unlinked list may return.
pub(super) const MAX_UNLINKED_AGENTS: usize = 200;

/// One of the owner's provider agents that has no Buzz identity yet, which a
/// new hosted agent may attach to.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UnlinkedAgent {
    /// Lowercase UUID, passed back as the attach id.
    pub(crate) kiingo_agent_id: String,
    pub(crate) display_name: String,
    /// `User` or `Organization`.
    pub(crate) owner_principal_type: String,
}

/// Parse an unlinked-agents answer to `request_id`. Malformed entries and
/// machine defaults (agents the provider keeps for a computer, not for a
/// person to pick) are left out, as is anything past the first
/// [`MAX_UNLINKED_AGENTS`]. Order is the provider's (newest first).
pub(super) fn parse_unlinked_response(
    body: &Value,
    request_id: &str,
) -> Result<Vec<UnlinkedAgent>, String> {
    if body.get("contract_version") != Some(&json!(1))
        || optional_str(body, "correlation_id") != Some(request_id)
    {
        return Err("response_invalid".into());
    }
    let agents = body
        .get("agents")
        .and_then(Value::as_array)
        .ok_or_else(|| "response_invalid".to_string())?;
    let mut seen = std::collections::HashSet::new();
    Ok(agents
        .iter()
        .take(MAX_UNLINKED_AGENTS)
        .filter_map(|agent| {
            if agent.get("machine_default").and_then(Value::as_bool) != Some(false) {
                return None;
            }
            let id = optional_str(agent, "kiingo_agent_id")?.to_ascii_lowercase();
            let name = optional_str(agent, "display_name")?.trim();
            let principal = optional_str(agent, "owner_principal_type")?;
            if !is_uuid(&id)
                || !is_display_name(name)
                || !matches!(principal, "User" | "Organization")
                || !seen.insert(id.clone())
            {
                return None;
            }
            Some(UnlinkedAgent {
                kiingo_agent_id: id,
                display_name: name.to_string(),
                owner_principal_type: principal.to_string(),
            })
        })
        .collect())
}

/// One checked result of a batch answer: the requested agent's id, its
/// outcome, the reject code (prefix stripped) and the raw result.
struct BatchResult<'a> {
    id: String,
    outcome: String,
    code: Option<String>,
    raw: Option<&'a Value>,
}

/// Check a batch answer (re-link or attest) to `request_id` for `requested`,
/// signed by `owner_public_key`. Every requested agent gets exactly one
/// result: one the answer leaves out is a retryable `result_missing`; a
/// result for an agent that was not requested, a second one, or an outcome
/// outside `successes` and `rejected` makes the answer invalid.
fn parse_batch_response<'a>(
    body: &'a Value,
    request_id: &str,
    owner_public_key: &str,
    requested: &[RebindSelection],
    successes: &[&str],
    default_reject_code: &str,
) -> Result<Vec<BatchResult<'a>>, String> {
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
            .find(|agent| agent.provider_agent_id == id)
            .ok_or("response_invalid")?;
        if !key.eq_ignore_ascii_case(&wanted.agent_public_key) || by_id.contains_key(id) {
            return Err("response_invalid".into());
        }
        let outcome = optional_str(result, "outcome").ok_or("response_invalid")?;
        let code = if successes.contains(&outcome) {
            // A success may still carry a note, such as `dm_open_failed` on an
            // activated agent whose owner DM the provider will retry.
            optional_str(result, "code")
                .filter(|code| bounded_code(code))
                .map(|code| strip_code_prefix(code).to_string())
        } else if outcome == "rejected" {
            Some(
                optional_str(result, "code")
                    .filter(|code| bounded_code(code))
                    .map(|code| strip_code_prefix(code).to_string())
                    .unwrap_or_else(|| default_reject_code.into()),
            )
        } else {
            return Err("response_invalid".into());
        };
        by_id.insert(
            id.to_string(),
            BatchResult {
                id: id.to_string(),
                outcome: outcome.to_string(),
                code,
                raw: Some(result),
            },
        );
    }
    Ok(requested
        .iter()
        .map(|agent| {
            let id = agent.provider_agent_id.as_str();
            by_id.remove(id).unwrap_or_else(|| BatchResult {
                id: id.to_string(),
                outcome: "rejected".into(),
                code: Some("result_missing".into()),
                raw: None,
            })
        })
        .collect())
}

/// Parse a re-link answer to `request_id` for `requested`, signed by
/// `owner_public_key`. See [`parse_batch_response`].
pub(super) fn parse_rebind_response(
    body: &Value,
    request_id: &str,
    owner_public_key: &str,
    requested: &[RebindSelection],
) -> Result<Vec<RebindResult>, String> {
    Ok(parse_batch_response(
        body,
        request_id,
        owner_public_key,
        requested,
        &["rebound", "already_current"],
        "rebind_failed",
    )?
    .into_iter()
    .map(|result| RebindResult {
        provider_agent_id: result.id,
        outcome: result.outcome,
        code: result.code,
    })
    .collect())
}

/// Parse an attest-pending answer to `request_id` for `requested`, signed by
/// `owner_public_key`. See [`parse_batch_response`]; `dm_opened` is true
/// only when the answer says so.
pub(super) fn parse_attest_pending_response(
    body: &Value,
    request_id: &str,
    owner_public_key: &str,
    requested: &[RebindSelection],
) -> Result<Vec<AttestResult>, String> {
    Ok(parse_batch_response(
        body,
        request_id,
        owner_public_key,
        requested,
        &["activated", "already_active"],
        "activate_failed",
    )?
    .into_iter()
    .map(|result| AttestResult {
        dm_opened: result
            .raw
            .and_then(|raw| raw.get("dm_opened"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        kiingo_agent_id: result
            .raw
            .and_then(|raw| optional_str(raw, "kiingo_agent_id"))
            .map(str::to_ascii_lowercase)
            .filter(|id| is_uuid(id)),
        provider_agent_id: result.id,
        outcome: result.outcome,
        code: result.code,
    })
    .collect())
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod tests;

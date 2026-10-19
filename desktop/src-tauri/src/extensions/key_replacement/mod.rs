//! "Confirm key replacement": a relay owner or admin whose earlier key was
//! revoked records, once, that their current key replaced it.
//!
//! The hosted provider knows which earlier key it verified for the same
//! person (`POST /owner/key-replacement`, a read-only owner lookup). The
//! relay accepts a NIP-IA kind 9035 archive of that key with `replaced-by`
//! set to the signer when the signer is a relay owner or admin. That signed
//! record is what lets the relay move agents from the earlier key to the
//! current one.
//!
//! The control is offered only when the signed-in key is a relay owner or
//! admin, the provider names a replaced key, and the relay does not already
//! list that key as archived. [`confirm_key_replacement`] is invoked only by
//! the owner's confirm tap; it re-checks all three conditions, requires the
//! replaced key to be the one the owner confirmed, signs exactly one archive
//! request (target = that key, `replaced-by` = the signer), publishes it, and
//! re-reads the relay's archive state.
//!
//! The provider API base and id are the same build configuration the hosted
//! agent re-link uses; a build without them hides the control.

mod logic;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::app_state::AppState;
use crate::commands::{
    acceptable_base_url, capture_relay_target, community_id_for_relay, fetch_relay_self_at,
    RelayTarget,
};
use crate::relay::{query_relay_at, submit_event_at_with_keys};

pub(crate) use logic::{ArchiveState, LookupAnswer, RemovalStep, Replacement};

const LOOKUP_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

fn configured(runtime: &str, build: &[Option<&'static str>]) -> Option<String> {
    std::env::var(runtime)
        .ok()
        .into_iter()
        .chain(build.iter().flatten().map(|value| (*value).to_string()))
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
}

struct Route {
    base_url: String,
    provider_id: String,
}

fn route() -> Option<Route> {
    let base_url = configured(
        "BUZZ_DESKTOP_HOSTED_AGENTS_URL",
        &[
            option_env!("BUZZ_BUILD_HOSTED_AGENTS_URL"),
            option_env!("BUZZ_HOSTED_API_BASE_URL"),
        ],
    )
    .filter(|url| acceptable_base_url(url))?;
    let provider_id = configured(
        "BUZZ_DESKTOP_HOSTED_PROVIDER_ID",
        &[
            option_env!("BUZZ_BUILD_HOSTED_PROVIDER_ID"),
            option_env!("BUZZ_PROVIDER_ID"),
        ],
    )
    .filter(|id| {
        id.len() <= 64
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    })?;
    Some(Route {
        base_url: base_url.trim_end_matches('/').to_string(),
        provider_id,
    })
}

fn error(code: &str) -> String {
    json!({ "error": code }).to_string()
}

fn now_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .map_err(|_| error("clock_invalid"))
}

fn bounded_code(value: Option<&str>) -> Option<String> {
    value
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 160
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
        .map(|value| {
            value
                .strip_prefix("buzz_hosted_")
                .unwrap_or(value)
                .to_string()
        })
}

/// Ask the provider which earlier key it verified for the signed-in owner.
async fn lookup_replacement(
    route: &Route,
    keys: &nostr::Keys,
    community_id: &str,
) -> Result<LookupAnswer, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let body = logic::build_lookup_request(
        keys,
        &route.provider_id,
        community_id,
        &request_id,
        now_seconds()?,
    )
    .map_err(|code| error(&code))?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(LOOKUP_TIMEOUT)
        .build()
        .map_err(|_| error("hosted_agents_unreachable"))?;
    let response = client
        .post(format!("{}/owner/key-replacement", route.base_url))
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            error(if e.is_timeout() {
                "hosted_agents_timeout"
            } else {
                "hosted_agents_unreachable"
            })
        })?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| error("response_invalid"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(error("response_too_large"));
    }
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(error(
            &bounded_code(value.get("error").and_then(Value::as_str))
                .unwrap_or_else(|| "request_failed".into()),
        ));
    }
    logic::parse_lookup_response(&value, &request_id, &keys.public_key().to_hex())
        .map_err(|code| error(&code))
}

async fn relay_self(state: &AppState, target: &RelayTarget) -> Result<String, String> {
    fetch_relay_self_at(state, &target.ws_url)
        .await
        .map_err(|_| error("relay_unreachable"))?
        .ok_or_else(|| error("relay_identity_unavailable"))
}

/// The relay's membership snapshot events, filtered to its own identity.
async fn relay_members(
    state: &AppState,
    target: &RelayTarget,
    relay_self: &str,
) -> Result<Vec<nostr::Event>, String> {
    query_relay_at(
        state,
        &target.api_base_url,
        &[json!({
            "authors": [relay_self],
            "kinds": [logic::KIND_RELAY_MEMBERS],
            "limit": 1,
        })],
    )
    .await
    .map_err(|_| error("relay_unreachable"))
}

async fn archive_state(
    state: &AppState,
    target: &RelayTarget,
    relay_self: &str,
    old: &str,
    replacement: &str,
) -> Result<ArchiveState, String> {
    let events = query_relay_at(
        state,
        &target.api_base_url,
        &[
            json!({
                "authors": [relay_self],
                "kinds": [logic::KIND_ARCHIVE_SNAPSHOT],
                "limit": 1,
            }),
            json!({
                "authors": [relay_self],
                "kinds": [logic::KIND_ARCHIVE_DELTA],
                "#p": [old],
                "limit": 20,
            }),
        ],
    )
    .await
    .map_err(|_| error("relay_unreachable"))?;
    Ok(logic::archive_state(&events, relay_self, old, replacement))
}

/// Whether to offer "Confirm key replacement", and for which keys.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyReplacementStatus {
    pub offer: bool,
    pub current_public_key: String,
    pub replacement: Option<Replacement>,
    /// The "Remove old owner key" step, when the provider names a retired
    /// relay owner key.
    pub removal: Option<RemovalStep>,
}

/// Check the three conditions. Read-only: the provider lookup signs a
/// non-burned owner proof, and only after the relay shows the signed-in key
/// is a relay owner or admin.
#[tauri::command]
pub async fn key_replacement_status(
    state: State<'_, AppState>,
) -> Result<KeyReplacementStatus, String> {
    let route = route().ok_or_else(|| error("key_replacement_unavailable"))?;
    let target = capture_relay_target(&state);
    let community_id = community_id_for_relay(&target.ws_url);
    if community_id.is_empty() {
        return Err(error("key_replacement_unavailable"));
    }
    let keys = state.signing_keys()?;
    let current = keys.public_key().to_hex();
    let relay_self = relay_self(&state, &target).await?;
    let members = relay_members(&state, &target, &relay_self).await?;
    if !logic::is_relay_admin(&members, &relay_self, &current) {
        return Ok(KeyReplacementStatus {
            offer: false,
            current_public_key: current,
            replacement: None,
            removal: None,
        });
    }
    let answer = lookup_replacement(&route, &keys, &community_id).await?;
    let removal = logic::removal_step(
        answer.retired_relay_owner.as_deref(),
        &current,
        logic::relay_members_snapshot(&members, &relay_self),
    );
    let replacement = answer.replacement;
    let archive = match &replacement {
        Some(found) => {
            archive_state(
                &state,
                &target,
                &relay_self,
                &found.old_public_key,
                &current,
            )
            .await?
        }
        None => ArchiveState::NotArchived,
    };
    Ok(KeyReplacementStatus {
        offer: logic::should_offer(true, replacement.as_ref(), archive),
        current_public_key: current,
        replacement,
        removal,
    })
}

/// Result of the one archive request.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyReplacementOutcome {
    pub accepted: bool,
    pub message: String,
    /// The relay now lists the old key as archived and replaced by the
    /// current key.
    pub confirmed: bool,
}

/// Sign and publish one NIP-IA archive of `expected_old_public_key` with
/// `replaced-by` = the signed-in key. Only the owner's confirm tap calls this.
/// Every condition is checked again, and the provider must still name exactly
/// the key the owner confirmed; otherwise nothing is signed.
#[tauri::command]
pub async fn confirm_key_replacement(
    expected_old_public_key: String,
    state: State<'_, AppState>,
) -> Result<KeyReplacementOutcome, String> {
    let route = route().ok_or_else(|| error("key_replacement_unavailable"))?;
    let target = capture_relay_target(&state);
    let community_id = community_id_for_relay(&target.ws_url);
    if community_id.is_empty() {
        return Err(error("key_replacement_unavailable"));
    }
    let keys = state.signing_keys()?;
    let current = keys.public_key().to_hex();
    let relay_self = relay_self(&state, &target).await?;
    let members = relay_members(&state, &target, &relay_self).await?;
    if !logic::is_relay_admin(&members, &relay_self, &current) {
        return Err(error("key_replacement_not_admin"));
    }
    let replacement = lookup_replacement(&route, &keys, &community_id)
        .await?
        .replacement
        .ok_or_else(|| error("key_replacement_none"))?;
    let old = replacement.old_public_key;
    if !old.eq_ignore_ascii_case(expected_old_public_key.trim()) {
        return Err(error("key_replacement_changed"));
    }
    match archive_state(&state, &target, &relay_self, &old, &current).await? {
        ArchiveState::NotArchived => {}
        ArchiveState::ArchivedReplacedBy => {
            return Ok(KeyReplacementOutcome {
                accepted: true,
                message: String::new(),
                confirmed: true,
            })
        }
        ArchiveState::ArchivedOther => return Err(error("key_replacement_already_archived")),
    }

    let builder = crate::events::build_archive_identity_request(
        &old,
        "",
        Some(logic::ARCHIVE_REASON),
        Some(&current),
        None,
    )
    .map_err(|_| error("archive_request_invalid"))?;
    let response = submit_event_at_with_keys(builder, &state, &target.api_base_url, &keys).await?;
    // The archive is already submitted; a failed re-read must not turn that
    // into an error. It reports "not confirmed yet" and the owner can check
    // again.
    let confirmed = response.accepted
        && archive_state(&state, &target, &relay_self, &old, &current)
            .await
            .is_ok_and(|archive| archive == ArchiveState::ArchivedReplacedBy);
    Ok(KeyReplacementOutcome {
        accepted: response.accepted,
        message: response.message,
        confirmed,
    })
}

/// Re-read whether the relay lists `old_public_key` as archived and replaced
/// by the signed-in key. Read-only; signs nothing.
#[tauri::command]
pub async fn key_replacement_confirmed(
    old_public_key: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let old = old_public_key.trim().to_ascii_lowercase();
    if old.len() != 64 || !old.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(error("key_replacement_changed"));
    }
    let target = capture_relay_target(&state);
    let current = state.signing_keys()?.public_key().to_hex();
    let relay_self = relay_self(&state, &target).await?;
    Ok(
        archive_state(&state, &target, &relay_self, &old, &current).await?
            == ArchiveState::ArchivedReplacedBy,
    )
}

/// Result of the one remove-member request.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalOutcome {
    pub accepted: bool,
    pub message: String,
    /// The relay's membership snapshot no longer lists the key.
    pub removed: bool,
}

/// Remove the retired relay owner key from the relay, as the relay owner.
/// Only the owner's confirm tap on the "Remove old owner key" step calls this.
/// Every check runs again: the provider must still name exactly
/// `expected_public_key`, it must not be the signed-in key, the signed-in key
/// must be the relay owner, and the relay must still list that key as a
/// non-owner member. Otherwise nothing is signed. Then exactly one kind 9031
/// naming that key is signed and published, and membership is re-read.
#[tauri::command]
pub async fn remove_old_owner_key(
    expected_public_key: String,
    state: State<'_, AppState>,
) -> Result<RemovalOutcome, String> {
    let route = route().ok_or_else(|| error("key_replacement_unavailable"))?;
    let target = capture_relay_target(&state);
    let community_id = community_id_for_relay(&target.ws_url);
    if community_id.is_empty() {
        return Err(error("key_replacement_unavailable"));
    }
    let keys = state.signing_keys()?;
    let current = keys.public_key().to_hex();
    let relay_self = relay_self(&state, &target).await?;
    let members = relay_members(&state, &target, &relay_self).await?;
    if !logic::is_relay_admin(&members, &relay_self, &current) {
        return Err(error("removal_not_owner"));
    }
    let answer = lookup_replacement(&route, &keys, &community_id).await?;
    let step = logic::removal_step(
        answer.retired_relay_owner.as_deref(),
        &current,
        logic::relay_members_snapshot(&members, &relay_self),
    )
    .ok_or_else(|| error("removal_none"))?;
    if !step
        .public_key
        .eq_ignore_ascii_case(expected_public_key.trim())
    {
        return Err(error("removal_changed"));
    }
    if let Some(reason) = step.reason {
        return Err(error(&format!("removal_{reason}")));
    }

    let builder = crate::events::build_relay_admin_remove(&step.public_key)
        .map_err(|_| error("removal_request_invalid"))?;
    let response = submit_event_at_with_keys(builder, &state, &target.api_base_url, &keys).await?;
    // The removal is already submitted; a failed re-read reports "not
    // confirmed yet" and the owner can check again.
    let removed = response.accepted
        && is_removed(&state, &target, &relay_self, &step.public_key)
            .await
            .unwrap_or(false);
    Ok(RemovalOutcome {
        accepted: response.accepted,
        message: response.message,
        removed,
    })
}

async fn is_removed(
    state: &AppState,
    target: &RelayTarget,
    relay_self: &str,
    public_key: &str,
) -> Result<bool, String> {
    let members = relay_members(state, target, relay_self).await?;
    let snapshot = logic::relay_members_snapshot(&members, relay_self)
        .ok_or_else(|| error("relay_unreachable"))?;
    Ok(logic::relay_role(snapshot, public_key).is_none())
}

/// Re-read whether the relay's membership snapshot still lists
/// `public_key`. Read-only; signs nothing.
#[tauri::command]
pub async fn old_owner_key_removed(
    public_key: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let key = public_key.trim().to_ascii_lowercase();
    if key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(error("removal_changed"));
    }
    let target = capture_relay_target(&state);
    let relay_self = relay_self(&state, &target).await?;
    is_removed(&state, &target, &relay_self, &key).await
}

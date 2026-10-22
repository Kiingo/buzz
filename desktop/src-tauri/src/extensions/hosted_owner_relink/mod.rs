//! Re-link hosted agents to the owner's current key.
//!
//! When an owner rotates their Buzz key, a hosted provider can still hold
//! their agents under the earlier key. These commands let the owner list
//! their hosted agents with the owner key the provider holds, and, only on
//! their explicit confirmation in the app, re-link the agents they chose.
//! Nothing here runs on its own: the list is read when the owner opens the
//! settings card, and the re-link is signed only inside the command the
//! confirm button invokes, once per invocation, with a fresh request id and a
//! fresh single-use proof.
//!
//! The provider API base and its provider id are build-time configuration:
//! `BUZZ_BUILD_HOSTED_AGENTS_URL` and `BUZZ_BUILD_HOSTED_PROVIDER_ID`, or the
//! release composition's `BUZZ_HOSTED_API_BASE_URL` and `BUZZ_PROVIDER_ID`
//! when those are unset, with runtime overrides for development. A build that
//! has no API base or no provider id hides the feature.
//!
//! The same commands attest agents the provider minted and holds pending
//! until their owner vouches for them (`attest-pending`). The renderer
//! decides when (a Link tap, or the owner's "auto-link my new agents"
//! setting); this side signs only agents the most recent authenticated list
//! for the signed-in key reported as pending, and the provider re-checks
//! ownership regardless.

mod attach;
mod request;

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::app_state::AppState;
use crate::commands::{acceptable_base_url, community_id_for_relay};
use crate::relay::relay_ws_url_with_override;

pub(crate) use attach::{apply_attach, normalized_attach_agent_id, remember_attach};
pub(crate) use request::{
    build_list_shaped_request, AttestResult, OwnerAgent, RebindResult, RebindSelection,
    UnlinkedAgent,
};

const LIST_TIMEOUT: Duration = Duration::from_secs(20);
const REBIND_TIMEOUT: Duration = Duration::from_secs(60);
const ATTEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Pending agents the most recent authenticated list reported, for the key
/// and community that listed them:
/// `("<owner key> <community>", {(provider agent id, agent key)})`.
type ListedPending = (String, HashSet<(String, String)>);
static LISTED_PENDING: Mutex<Option<ListedPending>> = Mutex::new(None);

fn listing_scope(owner: &str, community_id: &str) -> String {
    format!("{owner} {community_id}")
}

fn remember_listed_pending(scope: &str, agents: &[OwnerAgent]) {
    let pending = agents
        .iter()
        .filter(|agent| agent.status == request::STATUS_PENDING_ATTESTATION && !agent.deleted)
        .map(|agent| {
            (
                agent.provider_agent_id.clone(),
                agent.agent_public_key.clone(),
            )
        })
        .collect();
    if let Ok(mut listed) = LISTED_PENDING.lock() {
        *listed = Some((scope.to_string(), pending));
    }
}

/// Whether every selection was listed as pending in `scope`.
fn all_listed_pending(scope: &str, selected: &[RebindSelection]) -> bool {
    let Ok(listed) = LISTED_PENDING.lock() else {
        return false;
    };
    let Some((listed_scope, pending)) = listed.as_ref() else {
        return false;
    };
    listed_scope == scope
        && selected.iter().all(|agent| {
            pending.contains(&(
                agent.provider_agent_id.trim().to_string(),
                agent.agent_public_key.to_ascii_lowercase(),
            ))
        })
}
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// The first non-empty value: the runtime override, then each build-time
/// value in order.
fn configured(runtime: &str, build: &[Option<&'static str>]) -> Option<String> {
    std::env::var(runtime)
        .ok()
        .into_iter()
        .chain(build.iter().flatten().map(|value| (*value).to_string()))
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
}

/// The hosted provider's API base and provider id.
pub(crate) struct Route {
    pub(crate) base_url: String,
    pub(crate) provider_id: String,
}

/// The configured hosted provider route, or `None` when this build has none.
pub(crate) fn route() -> Option<Route> {
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

/// Error returned to the webview as a JSON string.
#[derive(Debug, Serialize)]
struct RelinkError {
    status: Option<u16>,
    error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    correlation_id: Option<String>,
}

fn error_string(status: Option<u16>, error: &str, correlation_id: Option<String>) -> String {
    serde_json::to_string(&RelinkError {
        status,
        error: error.to_string(),
        correlation_id,
    })
    .unwrap_or_else(|_| error.to_string())
}

pub(crate) fn now_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .map_err(|_| error_string(None, "clock_invalid", None))
}

fn bounded(value: Option<&str>) -> Option<String> {
    value
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 160
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
        .map(str::to_string)
}

/// POST a JSON body to the provider; errors are JSON strings with a code.
pub(crate) async fn post(
    route: &Route,
    path: &str,
    body: &Value,
    timeout: Duration,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|_| error_string(None, "hosted_agents_unreachable", None))?;
    let response = client
        .post(format!("{}{}", route.base_url, path))
        .header("Accept", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|error| {
            let code = if error.is_timeout() {
                "hosted_agents_timeout"
            } else {
                "hosted_agents_unreachable"
            };
            error_string(None, code, None)
        })?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| error_string(Some(status.as_u16()), "response_invalid", None))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(error_string(
            Some(status.as_u16()),
            "response_too_large",
            None,
        ));
    }
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(value);
    }
    let fallback = if status.as_u16() == 429 {
        "rate_limited"
    } else {
        "request_failed"
    };
    let code = bounded(value.get("error").and_then(Value::as_str))
        .map(|code| request::strip_code_prefix(&code).to_string())
        .unwrap_or_else(|| fallback.to_string());
    Err(error_string(
        Some(status.as_u16()),
        &code,
        bounded(value.get("correlation_id").and_then(Value::as_str)),
    ))
}

/// The owner's hosted agents, with the owner key the provider holds for each.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedOwnerAgents {
    /// The signed-in key the agents should be linked to.
    pub current_owner_public_key: String,
    pub agents: Vec<OwnerAgent>,
}

/// Whether this build and community can re-link hosted agents.
#[tauri::command]
pub fn hosted_owner_relink_available(state: State<'_, AppState>) -> bool {
    route().is_some() && !community_id_for_relay(&relay_ws_url_with_override(&state)).is_empty()
}

/// List the owner's hosted agents. Read-only; the owner opens the view.
#[tauri::command]
pub async fn hosted_owner_relink_list(
    state: State<'_, AppState>,
) -> Result<HostedOwnerAgents, String> {
    let route = route().ok_or_else(|| error_string(None, "hosted_relink_unavailable", None))?;
    let community_id = community_id_for_relay(&relay_ws_url_with_override(&state));
    if community_id.is_empty() {
        return Err(error_string(None, "hosted_relink_unavailable", None));
    }
    let keys = state.signing_keys()?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let body = request::build_list_request(
        &keys,
        &route.provider_id,
        &community_id,
        &request_id,
        now_seconds()?,
    )
    .map_err(|code| error_string(None, &code, None))?;
    let response = post(&route, "/owner/agents/list", &body, LIST_TIMEOUT).await?;
    let agents = request::parse_list_response(&response, &request_id)
        .map_err(|code| error_string(None, &code, None))?;
    let owner = keys.public_key().to_hex();
    remember_listed_pending(&listing_scope(&owner, &community_id), &agents);
    Ok(HostedOwnerAgents {
        current_owner_public_key: owner,
        agents,
    })
}

/// Re-link the agents the owner selected to the current key. The confirm
/// button is the only caller. One invocation is one request: a new request
/// id, one attestation per selected agent, one new proof, no retries.
#[tauri::command]
pub async fn hosted_owner_relink_rebind(
    agents: Vec<RebindSelection>,
    state: State<'_, AppState>,
) -> Result<Vec<RebindResult>, String> {
    let route = route().ok_or_else(|| error_string(None, "hosted_relink_unavailable", None))?;
    let community_id = community_id_for_relay(&relay_ws_url_with_override(&state));
    if community_id.is_empty() {
        return Err(error_string(None, "hosted_relink_unavailable", None));
    }
    let keys = state.signing_keys()?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let body = request::build_rebind_request(
        &keys,
        &route.provider_id,
        &community_id,
        &request_id,
        &agents,
        now_seconds()?,
    )
    .map_err(|code| error_string(None, &code, None))?;
    let response = post(
        &route,
        "/owner/agents/rebind-owner-key",
        &body,
        REBIND_TIMEOUT,
    )
    .await?;
    request::parse_rebind_response(&response, &request_id, &keys.public_key().to_hex(), &agents)
        .map_err(|code| error_string(None, &code, None))
}

/// Attest pending agents for the current key: a Link tap, or the owner's
/// auto-link setting. One invocation is one request: a new request id, one
/// attestation per agent, one new proof, no retries. Only agents the most
/// recent list for this key reported as pending are signed.
#[tauri::command]
pub async fn hosted_owner_relink_attest_pending(
    agents: Vec<RebindSelection>,
    state: State<'_, AppState>,
) -> Result<Vec<AttestResult>, String> {
    let route = route().ok_or_else(|| error_string(None, "hosted_relink_unavailable", None))?;
    let community_id = community_id_for_relay(&relay_ws_url_with_override(&state));
    if community_id.is_empty() {
        return Err(error_string(None, "hosted_relink_unavailable", None));
    }
    let keys = state.signing_keys()?;
    let owner = keys.public_key().to_hex();
    if !all_listed_pending(&listing_scope(&owner, &community_id), &agents) {
        return Err(error_string(None, "attest_selection_not_listed", None));
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let body = request::build_attest_pending_request(
        &keys,
        &route.provider_id,
        &community_id,
        &request_id,
        &agents,
        now_seconds()?,
    )
    .map_err(|code| error_string(None, &code, None))?;
    let response = post(
        &route,
        "/owner/agents/attest-pending",
        &body,
        ATTEST_TIMEOUT,
    )
    .await?;
    request::parse_attest_pending_response(&response, &request_id, &owner, &agents)
        .map_err(|code| error_string(None, &code, None))
}

/// The owner's provider agents that have no Buzz identity yet, for the
/// create form's "attach to an existing agent" choice. Read-only: a
/// list-shaped proof with `action=list_unlinked`, which the provider does
/// not burn. Machine defaults are left out.
#[tauri::command]
pub async fn hosted_owner_relink_list_unlinked(
    state: State<'_, AppState>,
) -> Result<Vec<UnlinkedAgent>, String> {
    let route = route().ok_or_else(|| error_string(None, "hosted_relink_unavailable", None))?;
    let community_id = community_id_for_relay(&relay_ws_url_with_override(&state));
    if community_id.is_empty() {
        return Err(error_string(None, "hosted_relink_unavailable", None));
    }
    let keys = state.signing_keys()?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let body = request::build_list_shaped_request(
        &keys,
        "list_unlinked",
        &route.provider_id,
        &community_id,
        &request_id,
        serde_json::Map::new(),
        now_seconds()?,
    )
    .map_err(|code| error_string(None, &code, None))?;
    let response = post(&route, "/owner/agents/unlinked", &body, LIST_TIMEOUT).await?;
    request::parse_unlinked_response(&response, &request_id)
        .map_err(|code| error_string(None, &code, None))
}

#[cfg(test)]
mod listed_pending_tests {
    use super::*;

    fn agent(id: &str, key: char, status: &str, deleted: bool) -> OwnerAgent {
        OwnerAgent {
            provider_agent_id: id.into(),
            agent_public_key: key.to_string().repeat(64),
            display_name: id.into(),
            owner_public_key: None,
            deleted,
            status: status.into(),
            kiingo_agent_id: None,
        }
    }

    fn pick(id: &str, key: char) -> RebindSelection {
        RebindSelection {
            provider_agent_id: id.into(),
            agent_public_key: key.to_string().repeat(64).to_ascii_uppercase(),
        }
    }

    // One test, because the remembered list is process-wide.
    #[test]
    fn only_agents_the_last_list_reported_pending_for_this_key_are_signed() {
        let owner = listing_scope(&"1".repeat(64), "chat.example.test");
        assert!(!all_listed_pending(&owner, &[pick("buzz:ada", 'a')]));
        remember_listed_pending(
            &owner,
            &[
                agent("buzz:ada", 'a', "pending_attestation", false),
                agent("buzz:mira", 'b', "active", false),
                agent("buzz:gone", 'c', "pending_attestation", true),
            ],
        );
        assert!(all_listed_pending(&owner, &[pick("buzz:ada", 'a')]));
        assert!(all_listed_pending(&owner, &[pick(" buzz:ada ", 'a')]));
        // Live, deleted, unknown, or a different key: refused.
        assert!(!all_listed_pending(&owner, &[pick("buzz:mira", 'b')]));
        assert!(!all_listed_pending(&owner, &[pick("buzz:gone", 'c')]));
        assert!(!all_listed_pending(&owner, &[pick("buzz:ada", 'd')]));
        assert!(!all_listed_pending(
            &owner,
            &[pick("buzz:ada", 'a'), pick("buzz:new", 'e')]
        ));
        // Another signed-in key never inherits the list.
        assert!(!all_listed_pending(
            &"2".repeat(64),
            &[pick("buzz:ada", 'a')]
        ));
        // A newer list replaces the old one.
        remember_listed_pending(&owner, &[]);
        assert!(!all_listed_pending(&owner, &[pick("buzz:ada", 'a')]));
    }
}

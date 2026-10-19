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
//! The provider API base and its provider id are build-time configuration
//! (`BUZZ_BUILD_HOSTED_AGENTS_URL`, `BUZZ_BUILD_HOSTED_PROVIDER_ID`), with
//! runtime overrides for development. Builds without them hide the feature.

mod request;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::app_state::AppState;
use crate::commands::{acceptable_base_url, community_id_for_relay};
use crate::relay::relay_ws_url_with_override;

pub(crate) use request::{OwnerAgent, RebindResult, RebindSelection};

const LIST_TIMEOUT: Duration = Duration::from_secs(20);
const REBIND_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

fn configured(runtime: &str, build: Option<&'static str>) -> Option<String> {
    std::env::var(runtime)
        .ok()
        .or_else(|| build.map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

struct Route {
    base_url: String,
    provider_id: String,
}

fn route() -> Option<Route> {
    let base_url = configured(
        "BUZZ_DESKTOP_HOSTED_AGENTS_URL",
        option_env!("BUZZ_BUILD_HOSTED_AGENTS_URL"),
    )
    .filter(|url| acceptable_base_url(url))?;
    let provider_id = configured(
        "BUZZ_DESKTOP_HOSTED_PROVIDER_ID",
        option_env!("BUZZ_BUILD_HOSTED_PROVIDER_ID"),
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

fn now_seconds() -> Result<u64, String> {
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

async fn post(route: &Route, path: &str, body: &Value, timeout: Duration) -> Result<Value, String> {
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
    Ok(HostedOwnerAgents {
        current_owner_public_key: keys.public_key().to_hex(),
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

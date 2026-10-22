//! Re-link hosted agents to the owner's current key.
//!
//! When an owner rotates their Buzz key, a hosted provider can still hold
//! their agents under the earlier key. These commands let the owner list
//! their hosted agents with the owner key the provider holds and re-link
//! them, and attest agents the provider minted and holds pending until their
//! owner vouches for them (`attest-pending`). The renderer decides when: a
//! Link tap, the batch review's confirm button, or the owner's "auto-link my
//! new agents" setting, which runs unattended while it is on.
//!
//! Because the setting runs unattended, every signing command is bound to
//! one authenticated list: the renderer passes back that list's id and the
//! owner key it was listed for, and the command refuses unless the
//! signed-in key is still that key and every agent it is asked to sign for
//! was in that list as pending (attest) or as linked to an earlier owner key
//! (re-link). Each invocation is one request with a fresh request id and a
//! fresh single-use proof, never retried here; the provider re-checks
//! ownership regardless.
//!
//! The provider API base and its provider id are build-time configuration:
//! `BUZZ_BUILD_HOSTED_AGENTS_URL` and `BUZZ_BUILD_HOSTED_PROVIDER_ID`, or the
//! release composition's `BUZZ_HOSTED_API_BASE_URL` and `BUZZ_PROVIDER_ID`
//! when those are unset, with runtime overrides for development. A build that
//! has no API base or no provider id hides the feature.

mod attach;
mod request;

use std::collections::{HashSet, VecDeque};
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

/// What one authenticated list reported, so a later signing command can be
/// held to it: the list's request id, the key and community that listed it,
/// the agents it reported pending, and the live agents it reported linked to
/// an earlier owner key, each as `(provider agent id, agent key)`.
struct Listing {
    list_id: String,
    scope: String,
    pending: HashSet<(String, String)>,
    stale: HashSet<(String, String)>,
}

/// Which list membership a signing command needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Listed {
    Pending,
    Stale,
}

/// Lists kept, newest last. Several, so that a settings card refreshing its
/// list does not invalidate a pass (or an open review) signing against an
/// earlier one.
const MAX_LISTINGS: usize = 8;
static LISTINGS: Mutex<VecDeque<Listing>> = Mutex::new(VecDeque::new());

fn listing_scope(owner: &str, community_id: &str) -> String {
    format!("{owner} {community_id}")
}

fn remember_listing(list_id: &str, scope: &str, owner: &str, agents: &[OwnerAgent]) {
    let entry = |agent: &OwnerAgent| {
        (
            agent.provider_agent_id.clone(),
            agent.agent_public_key.clone(),
        )
    };
    let live = agents.iter().filter(|agent| !agent.deleted);
    let pending = live
        .clone()
        .filter(|agent| agent.status == request::STATUS_PENDING_ATTESTATION)
        .map(entry)
        .collect();
    let stale = live
        .filter(|agent| {
            agent.status == request::STATUS_ACTIVE
                && agent
                    .owner_public_key
                    .as_deref()
                    .is_some_and(|holder| holder != owner)
        })
        .map(entry)
        .collect();
    if let Ok(mut listings) = LISTINGS.lock() {
        listings.retain(|listing| listing.list_id != list_id);
        listings.push_back(Listing {
            list_id: list_id.to_string(),
            scope: scope.to_string(),
            pending,
            stale,
        });
        while listings.len() > MAX_LISTINGS {
            listings.pop_front();
        }
    }
}

/// Whether the list `list_id`, listed in `scope`, reported every selection
/// as `kind`. Ids are compared verbatim; agent keys case-insensitively.
fn all_listed(list_id: &str, scope: &str, kind: Listed, selected: &[RebindSelection]) -> bool {
    let Ok(listings) = LISTINGS.lock() else {
        return false;
    };
    let Some(listing) = listings
        .iter()
        .find(|listing| listing.list_id == list_id && listing.scope == scope)
    else {
        return false;
    };
    let set = match kind {
        Listed::Pending => &listing.pending,
        Listed::Stale => &listing.stale,
    };
    !selected.is_empty()
        && selected.iter().all(|agent| {
            set.contains(&(
                agent.provider_agent_id.clone(),
                agent.agent_public_key.to_ascii_lowercase(),
            ))
        })
}

/// Refuse with `owner_key_changed` unless the signed-in key is still
/// `expected_owner`, the key the list being signed against was listed for.
fn bound_owner(signed_in: &str, expected_owner: &str) -> Result<(), String> {
    if signed_in.eq_ignore_ascii_case(expected_owner.trim()) {
        Ok(())
    } else {
        Err(error_string(None, "owner_key_changed", None))
    }
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
    /// This list's request id; signing commands name it to be held to it.
    pub list_id: String,
    pub agents: Vec<OwnerAgent>,
}

/// Whether this build and community can re-link hosted agents.
#[tauri::command]
pub fn hosted_owner_relink_available(state: State<'_, AppState>) -> bool {
    route().is_some() && !community_id_for_relay(&relay_ws_url_with_override(&state)).is_empty()
}

/// List the owner's hosted agents. Read-only: the settings card, a Link
/// tap's refresh, or an auto-link pass reads it.
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
    remember_listing(
        &request_id,
        &listing_scope(&owner, &community_id),
        &owner,
        &agents,
    );
    Ok(HostedOwnerAgents {
        current_owner_public_key: owner,
        list_id: request_id,
        agents,
    })
}

/// Re-link agents to the current key: a Link tap, the batch review's
/// confirm button, or the owner's auto-link setting. Signs only while the
/// signed-in key is still `expected_owner`, and only for agents the list
/// `list_id` reported as live and linked to an earlier owner key. One
/// invocation is one request: a new request id, one attestation per agent,
/// one new proof, no retries.
#[tauri::command]
pub async fn hosted_owner_relink_rebind(
    agents: Vec<RebindSelection>,
    expected_owner: String,
    list_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<RebindResult>, String> {
    let route = route().ok_or_else(|| error_string(None, "hosted_relink_unavailable", None))?;
    let community_id = community_id_for_relay(&relay_ws_url_with_override(&state));
    if community_id.is_empty() {
        return Err(error_string(None, "hosted_relink_unavailable", None));
    }
    let keys = state.signing_keys()?;
    let owner = keys.public_key().to_hex();
    bound_owner(&owner, &expected_owner)?;
    if !all_listed(
        &list_id,
        &listing_scope(&owner, &community_id),
        Listed::Stale,
        &agents,
    ) {
        return Err(error_string(None, "rebind_selection_not_listed", None));
    }
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
    request::parse_rebind_response(&response, &request_id, &owner, &agents)
        .map_err(|code| error_string(None, &code, None))
}

/// Attest pending agents for the current key: a Link tap, or the owner's
/// auto-link setting. Signs only while the signed-in key is still
/// `expected_owner`, and only for agents the list `list_id` reported as
/// pending. One invocation is one request: a new request id, one
/// attestation per agent, one new proof, no retries.
#[tauri::command]
pub async fn hosted_owner_relink_attest_pending(
    agents: Vec<RebindSelection>,
    expected_owner: String,
    list_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<AttestResult>, String> {
    let route = route().ok_or_else(|| error_string(None, "hosted_relink_unavailable", None))?;
    let community_id = community_id_for_relay(&relay_ws_url_with_override(&state));
    if community_id.is_empty() {
        return Err(error_string(None, "hosted_relink_unavailable", None));
    }
    let keys = state.signing_keys()?;
    let owner = keys.public_key().to_hex();
    bound_owner(&owner, &expected_owner)?;
    if !all_listed(
        &list_id,
        &listing_scope(&owner, &community_id),
        Listed::Pending,
        &agents,
    ) {
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
mod listed_tests {
    use super::*;

    const OWNER: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const OLD: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn agent(id: &str, key: char, status: &str, owner: Option<&str>, deleted: bool) -> OwnerAgent {
        OwnerAgent {
            provider_agent_id: id.into(),
            agent_public_key: key.to_string().repeat(64),
            display_name: id.into(),
            owner_public_key: owner.map(str::to_string),
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

    // One test, because the remembered lists are process-wide.
    #[test]
    fn signing_is_held_to_one_list_for_one_key() {
        let scope = listing_scope(OWNER, "chat.example.test");
        assert!(!all_listed(
            "list-1",
            &scope,
            Listed::Pending,
            &[pick("buzz:ada", 'a')]
        ));
        remember_listing(
            "list-1",
            &scope,
            OWNER,
            &[
                agent("buzz:ada", 'a', "pending_attestation", None, false),
                agent("buzz:mira", 'b', "active", Some(OWNER), false),
                agent("buzz:gone", 'c', "pending_attestation", None, true),
                agent("buzz:sage", 'd', "active", Some(OLD), false),
                agent("buzz:shed", 'e', "active", Some(OLD), true),
                agent("buzz:anon", 'f', "active", None, false),
            ],
        );
        let pending =
            |picks: &[RebindSelection]| all_listed("list-1", &scope, Listed::Pending, picks);
        let stale = |picks: &[RebindSelection]| all_listed("list-1", &scope, Listed::Stale, picks);
        assert!(pending(&[pick("buzz:ada", 'a')]));
        // Ids are verbatim; live, deleted, unknown or another key: refused.
        assert!(!pending(&[pick(" buzz:ada ", 'a')]));
        assert!(!pending(&[pick("buzz:mira", 'b')]));
        assert!(!pending(&[pick("buzz:gone", 'c')]));
        assert!(!pending(&[pick("buzz:ada", 'd')]));
        assert!(!pending(&[pick("buzz:ada", 'a'), pick("buzz:new", 'e')]));
        assert!(!pending(&[]));
        // Re-link: only live agents the list held under an earlier key.
        assert!(stale(&[pick("buzz:sage", 'd')]));
        assert!(!stale(&[pick("buzz:ada", 'a')]));
        assert!(!stale(&[pick("buzz:mira", 'b')]));
        assert!(!stale(&[pick("buzz:shed", 'e')]));
        assert!(!stale(&[pick("buzz:anon", 'f')]));
        assert!(!stale(&[pick("buzz:sage", 'd'), pick("buzz:mira", 'b')]));
        // Another signed-in key or community never inherits the list.
        let other = listing_scope(OLD, "chat.example.test");
        assert!(!all_listed(
            "list-1",
            &other,
            Listed::Pending,
            &[pick("buzz:ada", 'a')]
        ));
        // An unknown list id is refused.
        assert!(!all_listed(
            "list-9",
            &scope,
            Listed::Pending,
            &[pick("buzz:ada", 'a')]
        ));

        // A newer list (a settings card refresh) does not invalidate the
        // older one a pass is signing against...
        remember_listing("list-2", &scope, OWNER, &[]);
        assert!(pending(&[pick("buzz:ada", 'a')]));
        assert!(!all_listed(
            "list-2",
            &scope,
            Listed::Pending,
            &[pick("buzz:ada", 'a')]
        ));
        // ...but only the most recent few lists are kept.
        for index in 3..(3 + MAX_LISTINGS) {
            remember_listing(&format!("list-{index}"), &scope, OWNER, &[]);
        }
        assert!(!pending(&[pick("buzz:ada", 'a')]));
    }

    #[test]
    fn signing_needs_the_key_the_list_was_listed_for() {
        assert!(bound_owner(OWNER, OWNER).is_ok());
        assert!(bound_owner(OWNER, &OWNER.to_ascii_uppercase()).is_ok());
        let error = bound_owner(OWNER, OLD).unwrap_err();
        assert!(error.contains("owner_key_changed"));
        assert!(bound_owner(OWNER, "").is_err());
    }
}

//! An agent's details for the profile panel's "Agent" section.
//!
//! `GET <guest route>/agents/<agent pubkey>/summary` describes what the agent
//! runs on, where, for whom and with what. It is authenticated with NIP-98
//! signed by the signed-in user (read-only, no prompt) and scoped by
//! `X-Buzz-Community`, like the other guest-route calls. The webview
//! validates the body and caches it; any error simply hides the section.
//!
//! [`agent_prewarm`] asks the same route to warm the agent for the reader
//! when a 1:1 agent DM opens (`POST /agents/<agent>/prewarm`, empty body):
//! fire and forget, so the first reply starts sooner.

use std::time::Duration;

use serde_json::Value;
use tauri::State;

use crate::app_state::AppState;
use crate::commands::{acceptable_base_url, community_id_for_relay, nip98_header};
use crate::managed_agents::access_policy::guest_route_url;
use crate::relay::relay_ws_url_with_override;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const PREWARM_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 512 * 1024;

fn error(status: Option<u16>, code: &str) -> String {
    serde_json::json!({ "status": status, "error": code }).to_string()
}

fn normalize_agent_key(value: &str) -> Option<String> {
    let key = value.trim().to_ascii_lowercase();
    (key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(key)
}

fn summary_url(base: &str, agent: &str) -> String {
    format!("{}/agents/{agent}/summary", base.trim_end_matches('/'))
}

fn prewarm_url(base: &str, agent: &str) -> String {
    format!("{}/agents/{agent}/prewarm", base.trim_end_matches('/'))
}

/// Ask the guest route to warm the agent for the signed-in user. The server
/// always answers 200 and the renderer ignores the outcome; an error only
/// means the first reply starts cold. NIP-98 POST with an empty body, so the
/// proof carries no payload tag.
#[tauri::command]
pub async fn agent_prewarm(
    agent_public_key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let agent = normalize_agent_key(&agent_public_key)
        .ok_or_else(|| error(None, "agent_public_key_invalid"))?;
    let base = guest_route_url()
        .filter(|url| acceptable_base_url(url))
        .ok_or_else(|| error(None, "guest_route_unavailable"))?;
    let community_id = community_id_for_relay(&relay_ws_url_with_override(&state));
    if community_id.is_empty() {
        return Err(error(None, "community_invalid"));
    }
    let keys = state.signing_keys()?;
    let url = prewarm_url(&base, &agent);
    let authorization = nip98_header(&keys, "POST", &url, None)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(PREWARM_TIMEOUT)
        .build()
        .map_err(|_| error(None, "client_failed"))?;
    let response = client
        .post(&url)
        .header("Authorization", authorization)
        .header("X-Buzz-Community", community_id)
        .header("Content-Length", "0")
        .send()
        .await
        .map_err(|_| error(None, "guest_route_unreachable"))?;
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(error(Some(status.as_u16()), "request_failed"))
    }
}

/// Read the agent's summary as the signed-in user. Returns the JSON body of
/// a 200 answer; every other outcome is an error string.
#[tauri::command]
pub async fn agent_summary_fetch(
    agent_public_key: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let agent = normalize_agent_key(&agent_public_key)
        .ok_or_else(|| error(None, "agent_public_key_invalid"))?;
    let base = guest_route_url()
        .filter(|url| acceptable_base_url(url))
        .ok_or_else(|| error(None, "guest_route_unavailable"))?;
    let community_id = community_id_for_relay(&relay_ws_url_with_override(&state));
    if community_id.is_empty() {
        return Err(error(None, "community_invalid"));
    }
    let keys = state.signing_keys()?;
    let url = summary_url(&base, &agent);
    let authorization = nip98_header(&keys, "GET", &url, None)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| error(None, "client_failed"))?;
    let response = client
        .get(&url)
        .header("Accept", "application/json")
        .header("Authorization", authorization)
        .header("X-Buzz-Community", community_id)
        .send()
        .await
        .map_err(|e| {
            error(
                None,
                if e.is_timeout() {
                    "guest_route_timeout"
                } else {
                    "guest_route_unreachable"
                },
            )
        })?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| error(Some(status.as_u16()), "response_unreadable"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(error(Some(status.as_u16()), "response_too_large"));
    }
    if !status.is_success() {
        return Err(error(Some(status.as_u16()), "request_failed"));
    }
    serde_json::from_slice(&bytes).map_err(|_| error(Some(status.as_u16()), "response_invalid"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prewarm_posts_an_empty_body_without_a_payload_tag() {
        let url = prewarm_url("https://api.example.com/api/buzz-guest/v1", &"b".repeat(64));
        assert!(url.ends_with(&format!("/agents/{}/prewarm", "b".repeat(64))));
        let keys = nostr::Keys::parse(&"1".repeat(64)).expect("keys");
        let header = nip98_header(&keys, "POST", &url, None).expect("header");
        let encoded = header.strip_prefix("Nostr ").expect("scheme");
        let json = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
            .expect("base64");
        let event: Value = serde_json::from_slice(&json).expect("event");
        let tags = event["tags"].as_array().expect("tags");
        assert!(tags.contains(&serde_json::json!(["u", url])));
        assert!(tags.contains(&serde_json::json!(["method", "POST"])));
        assert!(!tags.iter().any(|tag| tag[0] == "payload"));
    }

    #[test]
    fn agent_keys_and_urls() {
        assert_eq!(
            normalize_agent_key(&"B".repeat(64)).as_deref(),
            Some("b".repeat(64).as_str())
        );
        assert_eq!(normalize_agent_key(&"z".repeat(64)), None);
        assert_eq!(
            summary_url(
                "https://api.example.com/api/buzz-guest/v1/",
                &"b".repeat(64)
            ),
            format!(
                "https://api.example.com/api/buzz-guest/v1/agents/{}/summary",
                "b".repeat(64)
            )
        );
    }
}

//! An agent's slash commands for the composer's "/" menu.
//!
//! `GET <guest route>/agents/<agent pubkey>/commands` lists the session
//! commands and skills the agent accepts, then the other registry skills the
//! signed-in user may use with it. `?audience=private` asks for the list of
//! a one-to-one DM and `?audience=group` for a channel or thread (the server
//! re-checks every pick against the actual conversation). `&q=` searches the
//! full list when an earlier answer said it was cut short (`truncated`). It is authenticated with NIP-98
//! signed by the signed-in user (read-only, no prompt) and scoped by
//! `X-Buzz-Community`, like the other guest-route calls. The renderer keeps
//! the ETag and sends it back as `If-None-Match`; a 304 means its cached list
//! is still current. The webview validates the body; any error hides the
//! menu.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::app_state::AppState;
use crate::commands::{acceptable_base_url, community_id_for_relay, nip98_header};
use crate::managed_agents::access_policy::guest_route_url;
use crate::relay::relay_ws_url_with_override;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
/// The server reads at most this many characters of `q`.
const MAX_QUERY_CHARS: usize = 64;
const MAX_ETAG_BYTES: usize = 256;

/// One commands lookup: either a fresh body with its ETag, or "unchanged".
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandsResponse {
    /// The server answered 304: the renderer's cached list is current.
    pub not_modified: bool,
    /// ETag to send back as `If-None-Match` next time.
    pub etag: Option<String>,
    /// The JSON body of a 200 answer; validated by the renderer.
    pub body: Option<Value>,
}

fn error(status: Option<u16>, code: &str) -> String {
    serde_json::json!({ "status": status, "error": code }).to_string()
}

fn normalize_agent_key(value: &str) -> Option<String> {
    let key = value.trim().to_ascii_lowercase();
    (key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(key)
}

/// An ETag safe to echo in a header (visible ASCII, bounded).
fn sanitize_etag(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|tag| {
            !tag.is_empty()
                && tag.len() <= MAX_ETAG_BYTES
                && tag.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
        })
        .map(str::to_string)
}

/// Which conversation the list is for: a 1:1 DM is private, a channel or
/// thread a group. Anything else sends no audience (the server's default).
fn audience_query(audience: Option<&str>) -> &'static str {
    match audience {
        Some("private") => "?audience=private",
        Some("group") => "?audience=group",
        _ => "",
    }
}

/// What follows "/" for a server-side search: trimmed, lowercased, bounded
/// and without control characters. None when nothing is left.
fn search_query(query: Option<&str>) -> Option<String> {
    let text: String = query?
        .trim()
        .to_lowercase()
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_QUERY_CHARS)
        .collect();
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn commands_url(base: &str, agent: &str, audience: Option<&str>, query: Option<&str>) -> String {
    let mut url = format!(
        "{}/agents/{agent}/commands{}",
        base.trim_end_matches('/'),
        audience_query(audience)
    );
    if let Some(query) = search_query(query) {
        url.push(if url.contains('?') { '&' } else { '?' });
        url.push_str("q=");
        url.extend(url::form_urlencoded::byte_serialize(query.as_bytes()));
    }
    url
}

/// List the agent's slash commands as the signed-in user.
#[tauri::command]
pub async fn agent_commands_fetch(
    agent_public_key: String,
    etag: Option<String>,
    audience: Option<String>,
    query: Option<String>,
    state: State<'_, AppState>,
) -> Result<AgentCommandsResponse, String> {
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
    let url = commands_url(&base, &agent, audience.as_deref(), query.as_deref());
    let authorization = nip98_header(&keys, "GET", &url, None)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| error(None, "client_failed"))?;
    let mut request = client
        .get(&url)
        .header("Accept", "application/json")
        .header("Authorization", authorization)
        .header("X-Buzz-Community", community_id);
    if let Some(tag) = sanitize_etag(etag.as_deref()) {
        request = request.header("If-None-Match", tag);
    }
    let response = request.send().await.map_err(|e| {
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
    if status == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(AgentCommandsResponse {
            not_modified: true,
            etag: sanitize_etag(etag.as_deref()),
            body: None,
        });
    }
    let response_etag = sanitize_etag(
        response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok()),
    );
    let bytes = response
        .bytes()
        .await
        .map_err(|_| error(Some(status.as_u16()), "response_unreadable"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(error(Some(status.as_u16()), "response_too_large"));
    }
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if !status.is_success() {
        let code = value
            .get("error")
            .and_then(Value::as_str)
            .filter(|code| {
                code.len() <= 64
                    && code
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            })
            .unwrap_or("http_error");
        return Err(error(Some(status.as_u16()), code));
    }
    Ok(AgentCommandsResponse {
        not_modified: false,
        etag: response_etag,
        body: Some(value),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_keys_and_urls() {
        let agent = "A".repeat(64);
        assert_eq!(
            normalize_agent_key(&agent).as_deref(),
            Some("a".repeat(64).as_str())
        );
        assert_eq!(normalize_agent_key("xyz"), None);
        assert_eq!(
            commands_url(
                "https://api.example.com/api/buzz-guest/v1/",
                &"a".repeat(64),
                None,
                None
            ),
            format!(
                "https://api.example.com/api/buzz-guest/v1/agents/{}/commands",
                "a".repeat(64)
            )
        );
        assert_eq!(
            commands_url(
                "https://api.example.com/api/buzz-guest/v1",
                &"a".repeat(64),
                Some("private"),
                None
            ),
            format!(
                "https://api.example.com/api/buzz-guest/v1/agents/{}/commands?audience=private",
                "a".repeat(64)
            )
        );
        assert_eq!(
            commands_url(
                "https://api.example.com/api/buzz-guest/v1",
                &"a".repeat(64),
                Some("group"),
                Some("  Kiingo FR&x=1 ")
            ),
            format!(
                "https://api.example.com/api/buzz-guest/v1/agents/{}/commands?audience=group&q=kiingo+fr%26x%3D1",
                "a".repeat(64)
            )
        );
        assert_eq!(search_query(Some("   ")), None);
        assert_eq!(search_query(Some("a\nb")).as_deref(), Some("ab"));
        assert_eq!(
            search_query(Some(&"x".repeat(100))).map(|q| q.len()),
            Some(64)
        );
        assert_eq!(audience_query(Some("group")), "?audience=group");
        assert_eq!(audience_query(Some("private&x=1")), "");
        assert_eq!(audience_query(None), "");
    }

    #[test]
    fn etags_are_bounded_visible_ascii() {
        assert_eq!(
            sanitize_etag(Some(" W/\"abc\" ")).as_deref(),
            Some("W/\"abc\"")
        );
        assert_eq!(sanitize_etag(Some("")), None);
        assert_eq!(sanitize_etag(Some("bad\nvalue")), None);
        assert_eq!(sanitize_etag(Some(&"x".repeat(257))), None);
        assert_eq!(sanitize_etag(None), None);
    }

    #[test]
    fn get_proof_names_the_exact_url_and_method() {
        let keys = nostr::Keys::parse(&"1".repeat(64)).expect("keys");
        let url = commands_url(
            "https://api.example.com/api/buzz-guest/v1",
            &"a".repeat(64),
            Some("private"),
            None,
        );
        let header = nip98_header(&keys, "GET", &url, None).expect("header");
        let encoded = header.strip_prefix("Nostr ").expect("scheme");
        let json = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
            .expect("base64");
        let event: Value = serde_json::from_slice(&json).expect("event");
        assert_eq!(event["kind"], serde_json::json!(27235));
        let tags = event["tags"].as_array().expect("tags");
        assert!(tags.contains(&serde_json::json!(["u", url])));
        assert!(tags.contains(&serde_json::json!(["method", "GET"])));
        assert!(!tags.iter().any(|tag| tag[0] == "payload"));
    }
}

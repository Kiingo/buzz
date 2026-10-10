//! Owner-side client for the hosted agent guest-access route.
//!
//! The route (`BUZZ_BUILD_GUEST_ROUTE_URL`, same value the harness receives)
//! authenticates every call with NIP-98 signed by the user's own key and does
//! not serve browser CORS, so the webview reaches it through these commands.
//! Only owner (`/owner/...`) and identity (`/identity/...`) routes are
//! reachable; agent routes stay with the harness, which holds the agent key.

use std::time::Duration;

use base64::Engine as _;
use nostr::{Event, EventBuilder, JsonUtil, Kind, Tag};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::app_state::AppState;
use crate::managed_agents::access_policy::guest_route_url;
use crate::relay::relay_ws_url_with_override;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GuestAccessConfig {
    /// Base URL of the hosted guest route, or `None` when this build has none.
    pub route_url: Option<String>,
    /// `X-Buzz-Community` value: the active relay's host, as buzz-acp derives it.
    pub community_id: String,
}

/// Error shape returned to the webview as a JSON string, mirroring the route's
/// `{ error, message?, retry_after_ms? }` contract plus the HTTP status.
#[derive(Debug, Serialize)]
struct GuestAccessError {
    status: Option<u16>,
    error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

fn error_string(status: Option<u16>, error: &str, message: Option<String>) -> String {
    serde_json::to_string(&GuestAccessError {
        status,
        error: error.to_string(),
        message,
    })
    .unwrap_or_else(|_| error.to_string())
}

/// Community id for the guest route: the lowercase host of the relay URL.
pub(crate) fn community_id_for_relay(relay_url: &str) -> String {
    url::Url::parse(relay_url.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default()
}

/// HTTPS, or HTTP on loopback for local development (same rule as buzz-acp).
fn acceptable_base_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    match parsed.scheme() {
        "https" => true,
        "http" => matches!(
            parsed.host_str(),
            Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1")
        ),
        _ => false,
    }
}

/// Only owner and identity routes, with a plain path and optional query.
pub(crate) fn validate_route_path(path: &str) -> Result<(), String> {
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    let allowed_prefix = route.starts_with("/owner/") || route.starts_with("/identity/");
    let plain = route
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_'));
    let query_ok = query
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '=' | '&' | '-' | '_' | '.' | ':' | '%'));
    if !allowed_prefix || !plain || route.contains("//") || !query_ok {
        return Err(error_string(None, "path_not_allowed", None));
    }
    Ok(())
}

fn parse_method(method: &str) -> Result<reqwest::Method, String> {
    match method.to_ascii_uppercase().as_str() {
        "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        "PATCH" => Ok(reqwest::Method::PATCH),
        "DELETE" => Ok(reqwest::Method::DELETE),
        _ => Err(error_string(None, "method_not_allowed", None)),
    }
}

/// NIP-98 header: `u`, `method`, `payload` (body sha256) and a nonce so two
/// identical requests in the same second still get distinct event ids.
pub(crate) fn nip98_header(
    keys: &nostr::Keys,
    method: &str,
    url: &str,
    body: Option<&[u8]>,
) -> Result<String, String> {
    let nonce = uuid::Uuid::new_v4().to_string();
    let mut tags = vec![
        Tag::parse(["u", url]).map_err(|e| e.to_string())?,
        Tag::parse(["method", method]).map_err(|e| e.to_string())?,
    ];
    if let Some(body) = body {
        let hash = hex::encode(Sha256::digest(body));
        tags.push(Tag::parse(["payload", hash.as_str()]).map_err(|e| e.to_string())?);
    }
    tags.push(Tag::parse(["nonce", nonce.as_str()]).map_err(|e| e.to_string())?);
    let event = EventBuilder::new(Kind::HttpAuth, "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|e| format!("sign failed: {e}"))?;
    Ok(format!(
        "Nostr {}",
        base64::engine::general_purpose::STANDARD.encode(event.as_json().as_bytes())
    ))
}

#[tauri::command]
pub fn guest_access_config(state: State<'_, AppState>) -> GuestAccessConfig {
    GuestAccessConfig {
        route_url: guest_route_url().filter(|url| acceptable_base_url(url)),
        community_id: community_id_for_relay(&relay_ws_url_with_override(&state)),
    }
}

/// Call an owner or identity route on the hosted guest route as this user.
/// Errors are JSON strings: `{ "status": 403, "error": "owner_not_linked" }`.
#[tauri::command]
pub async fn guest_access_request(
    method: String,
    path: String,
    body: Option<Value>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let Some(base) = guest_route_url().filter(|url| acceptable_base_url(url)) else {
        return Err(error_string(None, "guest_route_unavailable", None));
    };
    validate_route_path(&path)?;
    let method = parse_method(&method)?;
    let community_id = community_id_for_relay(&relay_ws_url_with_override(&state));
    if community_id.is_empty() {
        return Err(error_string(None, "community_invalid", None));
    }
    let keys = state.signing_keys()?;
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let bytes = match &body {
        Some(value) => Some(serde_json::to_vec(value).map_err(|e| e.to_string())?),
        None => None,
    };
    let authorization = nip98_header(&keys, method.as_str(), &url, bytes.as_deref())?;

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| error_string(None, "client_failed", Some(e.to_string())))?;
    let mut request = client
        .request(method, &url)
        .header("Authorization", authorization)
        .header("X-Buzz-Community", community_id);
    if let Some(bytes) = bytes {
        request = request
            .header("Content-Type", "application/json")
            .body(bytes);
    }
    let response = request.send().await.map_err(|e| {
        let code = if e.is_timeout() {
            "guest_route_timeout"
        } else {
            "guest_route_unreachable"
        };
        error_string(None, code, None)
    })?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| error_string(Some(status.as_u16()), "response_unreadable", None))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(error_string(
            Some(status.as_u16()),
            "response_too_large",
            None,
        ));
    }
    let value: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    if status.is_success() {
        return Ok(value);
    }
    Err(error_string(
        Some(status.as_u16()),
        value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("http_error"),
        value
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string),
    ))
}

/// Verify a signed kind:0 profile and return its NIP-OA owner, if any.
/// Used to trust owner notifications only from the owner's own agents.
#[tauri::command]
pub fn guest_access_profile_owner(profile_event_json: String) -> Option<String> {
    let event = Event::from_json(&profile_event_json).ok()?;
    if event.kind != Kind::Metadata || event.verify().is_err() {
        return None;
    }
    crate::nostr_convert::profile_valid_oa_owner_pubkey(&event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn community_id_is_the_lowercase_relay_host() {
        assert_eq!(
            community_id_for_relay("wss://Chat.Example.com/relay"),
            "chat.example.com"
        );
        assert_eq!(community_id_for_relay("ws://localhost:3000"), "localhost");
        assert_eq!(community_id_for_relay("not a url"), "");
    }

    #[test]
    fn only_owner_and_identity_routes_are_reachable() {
        for ok in [
            "/owner/approvals?state=pending",
            "/owner/approvals/0b6c9f3e-2d3b-4b8a-9d55-0f3c1d2e3f4a/decision",
            "/owner/access-log?limit=50&since=2026-10-09T00:00:00.000Z",
            "/identity/status",
            "/identity/link",
        ] {
            assert!(validate_route_path(ok).is_ok(), "{ok}");
        }
        for bad in [
            "/turns",
            "/outbox",
            "/agents/register",
            "/owner/../turns",
            "//evil.example/owner/x",
            "/owner/x?u=<script>",
            "https://evil.example/owner/x",
        ] {
            assert!(validate_route_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn base_urls_must_be_https_or_loopback_http() {
        assert!(acceptable_base_url(
            "https://api.example.com/api/buzz-guest/v1"
        ));
        assert!(acceptable_base_url("http://127.0.0.1:8080/v1"));
        assert!(!acceptable_base_url("http://api.example.com/v1"));
        assert!(!acceptable_base_url("ftp://api.example.com"));
    }

    #[test]
    fn nip98_header_signs_url_method_and_body_hash() {
        let keys = nostr::Keys::generate();
        let body = br#"{"code":"X"}"#;
        let header = nip98_header(
            &keys,
            "POST",
            "https://api.example.com/v1/identity/link",
            Some(body),
        )
        .unwrap();
        let encoded = header.strip_prefix("Nostr ").unwrap();
        let json = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let event = Event::from_json(std::str::from_utf8(&json).unwrap()).unwrap();
        assert!(event.verify().is_ok());
        assert_eq!(event.kind, Kind::HttpAuth);
        assert_eq!(event.pubkey, keys.public_key());
        let tag = |name: &str| {
            event
                .tags
                .iter()
                .find(|t| t.as_slice().first().map(String::as_str) == Some(name))
                .map(|t| t.as_slice()[1].clone())
        };
        assert_eq!(
            tag("u").as_deref(),
            Some("https://api.example.com/v1/identity/link")
        );
        assert_eq!(tag("method").as_deref(), Some("POST"));
        assert_eq!(tag("payload"), Some(hex::encode(Sha256::digest(body))));
        assert!(tag("nonce").is_some());
    }

    #[test]
    fn get_requests_carry_no_payload_tag() {
        let keys = nostr::Keys::generate();
        let header =
            nip98_header(&keys, "GET", "https://x.example/v1/identity/status", None).unwrap();
        let json = base64::engine::general_purpose::STANDARD
            .decode(header.strip_prefix("Nostr ").unwrap())
            .unwrap();
        let event = Event::from_json(std::str::from_utf8(&json).unwrap()).unwrap();
        assert!(!event
            .tags
            .iter()
            .any(|t| t.as_slice().first().map(String::as_str) == Some("payload")));
    }

    #[test]
    fn profile_owner_requires_a_valid_signed_nip_oa_tag() {
        let owner = nostr::Keys::generate();
        let agent = nostr::Keys::generate();
        let tag_json =
            buzz_sdk_pkg::nip_oa::compute_auth_tag(&owner, &agent.public_key(), "").unwrap();
        let tag: Vec<String> = serde_json::from_str(&tag_json).unwrap();
        let profile = EventBuilder::new(Kind::Metadata, r#"{"name":"Atlas"}"#)
            .tags([Tag::parse(tag).unwrap()])
            .sign_with_keys(&agent)
            .unwrap();
        assert_eq!(
            guest_access_profile_owner(profile.as_json()),
            Some(owner.public_key().to_hex())
        );

        // Same tag on someone else's profile does not verify.
        let other = nostr::Keys::generate();
        let tag: Vec<String> = serde_json::from_str(&tag_json).unwrap();
        let forged = EventBuilder::new(Kind::Metadata, "{}")
            .tags([Tag::parse(tag).unwrap()])
            .sign_with_keys(&other)
            .unwrap();
        assert_eq!(guest_access_profile_owner(forged.as_json()), None);
        assert_eq!(guest_access_profile_owner("{}".to_string()), None);
    }
}

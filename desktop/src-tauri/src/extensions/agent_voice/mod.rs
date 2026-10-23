//! Native transport for 1:1 agent calls from an agent DM.
//!
//! A call is the agent host's own voice call (the same voice core as its
//! phone apps), not a huddle: audio runs WebRTC between this webview and the
//! host's realtime voice provider, and the host answers the SDP offer. This
//! module carries the host's call routes (`<origin>/api/buzz-voice/desktop/…`,
//! the origin taken from the guest route URL, or in debug builds only
//! `BUZZ_DESKTOP_AGENT_VOICE_URL`):
//!
//! - every request is NIP-98 (kind 27235, exact URL with query, method and
//!   the SHA-256 of the exact body bytes) signed by the signed-in user, with
//!   `X-Buzz-Community`, so the key never reaches the webview;
//! - only the call routes are reachable (start, view, feed long-poll, end,
//!   stop, answers and the per-ask routes, preferences), nothing else; the
//!   request URL is parsed once, its normalised path checked, and that same
//!   URL is signed and sent;
//! - answers are capped at 2 MiB (declared length first, then while read);
//! - the answer is returned as `{ status, body }` for every HTTP status, so
//!   the webview can show the host's error codes; transport failures are
//!   errors.
//!
//! The host proves the caller is the verified requester of this private 1:1
//! DM with the agent before a call starts, and serves each call to its own
//! caller only.

use std::time::Duration;

use serde_json::Value;
use tauri::State;

use crate::app_state::AppState;
use crate::commands::{acceptable_base_url, community_id_for_relay, nip98_header};
use crate::managed_agents::access_policy::guest_route_url;
use crate::relay::relay_ws_url_with_override;

/// The feed long-poll waits up to 20 s on the host.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(35);
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_BODY_BYTES: usize = 60 * 1024;
const MOUNT: &str = "/api/buzz-voice/desktop";

fn error(status: Option<u16>, code: &str) -> String {
    serde_json::json!({ "status": status, "error": code }).to_string()
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.char_indices().all(|(index, c)| match index {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// A human-ask id path segment: `[A-Za-z0-9._:-]` and percent escapes of
/// printable characters other than `.`, `/` and `\` (so no escape can turn
/// into traversal once the host decodes it), never only dots.
fn is_ask_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 190 || value.bytes().all(|b| b == b'.') {
        return false;
    }
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' {
            let Some(hex) = value.get(index + 1..index + 3) else {
                return false;
            };
            if !hex.bytes().all(|h| h.is_ascii_hexdigit()) {
                return false;
            }
            let Ok(decoded) = u8::from_str_radix(hex, 16) else {
                return false;
            };
            if !decoded.is_ascii_graphic() || matches!(decoded, b'.' | b'/' | b'\\') {
                return false;
            }
            index += 3;
            continue;
        }
        if !(byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')) {
            return false;
        }
        index += 1;
    }
    true
}

/// The call route `path` (relative to the mount) if it is one this command
/// may reach, else `None`. The query string is allowed only on the feed.
fn allowed_path(method: &str, path: &str) -> Option<String> {
    let (route, query) = match path.split_once('?') {
        Some((route, query)) => (route, Some(query)),
        None => (path, None),
    };
    let parts: Vec<&str> = route.split('/').collect();
    let get = method == "GET";
    let post = method == "POST";
    let ok = match parts.as_slice() {
        ["calls"] => post,
        ["calls", "live"] => get,
        ["preferences"] => get || method == "PUT",
        ["calls", id] => get && is_uuid(id),
        ["calls", id, "feed"] => get && is_uuid(id),
        ["calls", id, "end" | "stop" | "focus" | "text" | "caption-corrections"] => {
            post && is_uuid(id)
        }
        ["calls", id, "asks", "state" | "cancel" | "tell-more" | "reply"] => post && is_uuid(id),
        ["calls", id, "human-asks", ask, "answer"] => post && is_uuid(id) && is_ask_id(ask),
        _ => false,
    };
    if !ok {
        return None;
    }
    match query {
        None => Some(route.to_string()),
        Some(query)
            if parts.last() == Some(&"feed")
                && query.len() <= 200
                && query.bytes().all(|b| {
                    b.is_ascii_alphanumeric()
                        || matches!(b, b'=' | b'&' | b'.' | b'_' | b'-' | b'%')
                }) =>
        {
            Some(format!("{route}?{query}"))
        }
        Some(_) => None,
    }
}

/// `https://host` of the call routes: the override, else the guest route's
/// origin. HTTPS only (HTTP on loopback for development).
fn voice_origin(override_url: Option<String>, guest_route: Option<String>) -> Option<String> {
    let raw = override_url
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
        .or(guest_route)?;
    if !acceptable_base_url(&raw) {
        return None;
    }
    let parsed = url::Url::parse(&raw).ok()?;
    let origin = parsed.origin().ascii_serialization();
    (origin != "null").then_some(origin)
}

/// The one URL that is both signed and sent: parsed once, and only if its
/// normalised path and query are exactly the allowed route under the mount.
fn request_url(origin: &str, path: &str) -> Option<url::Url> {
    let raw = format!("{}{MOUNT}/{path}", origin.trim_end_matches('/'));
    let url = url::Url::parse(&raw).ok()?;
    let (route, query) = match path.split_once('?') {
        Some((route, query)) => (route, Some(query)),
        None => (path, None),
    };
    (url.path() == format!("{MOUNT}/{route}") && url.query() == query && url.fragment().is_none())
        .then_some(url)
}

/// `BUZZ_DESKTOP_AGENT_VOICE_URL` points development builds at another host;
/// release builds always use the guest route's origin.
fn voice_url_override() -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var("BUZZ_DESKTOP_AGENT_VOICE_URL").ok()
    } else {
        None
    }
}

/// One signed request to the host's call routes as the signed-in user.
/// Returns `{ "status": <u16>, "body": <JSON or null> }`.
#[tauri::command]
pub async fn agent_voice_request(
    method: String,
    path: String,
    body: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let method = method.trim().to_ascii_uppercase();
    let path = allowed_path(&method, path.trim().trim_start_matches('/'))
        .ok_or_else(|| error(None, "path_not_allowed"))?;
    let body = body.filter(|body| !body.is_empty());
    if body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_BODY_BYTES)
    {
        return Err(error(None, "body_too_large"));
    }
    if method == "GET" && body.is_some() {
        return Err(error(None, "body_not_allowed"));
    }
    let origin = voice_origin(voice_url_override(), guest_route_url())
        .ok_or_else(|| error(None, "voice_route_unavailable"))?;
    let community_id = community_id_for_relay(&relay_ws_url_with_override(&state));
    if community_id.is_empty() {
        return Err(error(None, "community_invalid"));
    }
    let keys = state.signing_keys()?;
    let url = request_url(&origin, &path).ok_or_else(|| error(None, "path_not_allowed"))?;
    let authorization = nip98_header(
        &keys,
        &method,
        url.as_str(),
        body.as_deref().map(str::as_bytes),
    )?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| error(None, "client_failed"))?;
    let http_method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| error(None, "method_invalid"))?;
    let mut request = client
        .request(http_method, url)
        .header("Accept", "application/json")
        .header("Authorization", authorization)
        .header("X-Buzz-Community", community_id);
    request = match body {
        Some(body) => request
            .header("Content-Type", "application/json")
            .body(body),
        None if method == "GET" => request,
        None => request.header("Content-Length", "0"),
    };
    let response = request.send().await.map_err(|e| {
        error(
            None,
            if e.is_timeout() {
                "voice_route_timeout"
            } else {
                "voice_route_unreachable"
            },
        )
    })?;
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(error(Some(status), "response_too_large"));
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| error(Some(status), "response_unreadable"))?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(error(Some(status), "response_too_large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    Ok(serde_json::json!({ "status": status, "body": body }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CALL: &str = "0192a6b0-0000-7000-8000-0000000000ac";

    #[test]
    fn only_call_routes_are_reachable() {
        assert_eq!(allowed_path("POST", "calls").as_deref(), Some("calls"));
        assert!(allowed_path("GET", &format!("calls/{CALL}")).is_some());
        assert_eq!(
            allowed_path("GET", &format!("calls/{CALL}/feed?rev=l4.live.1&wait=20")),
            Some(format!("calls/{CALL}/feed?rev=l4.live.1&wait=20"))
        );
        assert!(allowed_path("POST", &format!("calls/{CALL}/end")).is_some());
        assert!(allowed_path("POST", &format!("calls/{CALL}/asks/cancel")).is_some());
        assert!(allowed_path("POST", &format!("calls/{CALL}/human-asks/q:1-a/answer")).is_some());
        assert!(allowed_path("POST", &format!("calls/{CALL}/human-asks/q%3A1/answer")).is_some());
        assert!(allowed_path("POST", &format!("calls/{CALL}/human-asks/../answer")).is_none());
        // Escapes that decode to traversal or a separator, and bad escapes.
        for ask in [
            "%2e%2e", "%2E%2e", "a%2fb", "a%2Fb", "a%5cb", "a%5C", "%2e", "a%", "a%4", "a%+1",
            "a%00",
        ] {
            assert!(
                allowed_path("POST", &format!("calls/{CALL}/human-asks/{ask}/answer")).is_none(),
                "{ask}"
            );
        }
        assert!(allowed_path("PUT", "preferences").is_some());
        // Anything else, another method, a query off the feed, or traversal.
        assert!(allowed_path("GET", "calls").is_none());
        assert!(allowed_path("DELETE", &format!("calls/{CALL}")).is_none());
        assert!(allowed_path("POST", &format!("calls/{CALL}/end?x=1")).is_none());
        assert!(allowed_path("GET", &format!("calls/{CALL}/../../identity")).is_none());
        assert!(allowed_path("GET", "calls/not-a-call/feed").is_none());
        assert!(allowed_path("GET", &format!("calls/{CALL}/feed?rev=a b")).is_none());
        assert!(allowed_path("POST", "owner/agents/list").is_none());
    }

    #[test]
    fn the_origin_comes_from_the_guest_route_and_is_https() {
        assert_eq!(
            voice_origin(
                None,
                Some("https://api.example.com/api/buzz-guest/v1".into())
            )
            .as_deref(),
            Some("https://api.example.com")
        );
        assert_eq!(
            voice_origin(
                Some("https://voice.example.com/x".into()),
                Some("https://api.example.com/api/buzz-guest/v1".into())
            )
            .as_deref(),
            Some("https://voice.example.com")
        );
        assert_eq!(
            voice_origin(None, Some("http://api.example.com".into())),
            None
        );
        assert_eq!(voice_origin(None, None), None);
        assert_eq!(
            request_url(
                "https://api.example.com",
                &format!("calls/{CALL}/feed?rev=a")
            )
            .map(String::from),
            Some(format!(
                "https://api.example.com/api/buzz-voice/desktop/calls/{CALL}/feed?rev=a"
            ))
        );
    }

    #[test]
    fn the_signed_url_is_the_sent_url_or_nothing() {
        let origin = "https://api.example.com";
        // A dot-segment the URL parser would normalise never gets signed.
        assert!(request_url(origin, &format!("calls/{CALL}/human-asks/%2e%2e/answer")).is_none());
        assert!(request_url(origin, &format!("calls/{CALL}/human-asks/./answer")).is_none());
        assert!(request_url(origin, &format!("calls/{CALL}/end#x")).is_none());
        let url =
            request_url(origin, &format!("calls/{CALL}/human-asks/q%3A1/answer")).expect("allowed");
        assert_eq!(
            url.as_str(),
            format!("{origin}/api/buzz-voice/desktop/calls/{CALL}/human-asks/q%3A1/answer")
        );
    }

    #[test]
    fn a_body_is_bound_by_its_payload_hash() {
        let keys = nostr::Keys::parse(&"1".repeat(64)).expect("keys");
        let url = String::from(request_url("https://api.example.com", "calls").expect("url"));
        let header =
            nip98_header(&keys, "POST", &url, Some(br#"{"sdpOffer":"v=0"}"#)).expect("header");
        let encoded = header.strip_prefix("Nostr ").expect("scheme");
        let json = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
            .expect("base64");
        let event: Value = serde_json::from_slice(&json).expect("event");
        let tags = event["tags"].as_array().expect("tags");
        assert!(tags.contains(&serde_json::json!(["u", url])));
        assert!(tags.iter().any(|tag| tag[0] == "payload"));
        assert_eq!(event["content"], "");
    }
}

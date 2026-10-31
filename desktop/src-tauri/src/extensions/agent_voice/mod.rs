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
//!   stop, answers and the per-ask routes, preferences, the voice provider
//!   settings and a Gemini call's stream-token) and the owner's delegation
//!   board (cards and their long-poll, one delegation, a worker ask's
//!   answer, stop one, stop all), nothing else; the
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

pub(super) fn is_uuid(value: &str) -> bool {
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

/// `agentPubkey=<64 hex>`: the only query the settings read takes. The
/// desktop names the agent by its Buzz key only; the server maps it to the
/// agent (a raw `agentId` is not relayed).
fn is_settings_query(query: &str) -> bool {
    match query.split_once('=') {
        Some(("agentPubkey", key)) => key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit()),
        _ => false,
    }
}

/// `GET agents/<uuid | ->/delegations`, the one delegation route with a
/// query. `-` names the agent by `agentPubkey` instead (the host resolves
/// the Buzz key as its settings read does).
fn is_delegation_list(parts: &[&str], get: bool) -> bool {
    get && matches!(parts, ["agents", agent, "delegations"] if is_uuid(agent) || *agent == "-")
}

/// The cards long-poll query: only `agentPubkey` (64 hex; required on the
/// `-` path), `rev` (a percent-encoded opaque token), `wait` (seconds) and
/// `includeFinished`, each at most once.
fn is_delegation_list_query(query: &str, by_key: bool) -> bool {
    let mut seen: Vec<&str> = Vec::new();
    let ok = query.len() <= 300
        && query.split('&').all(|pair| {
            let Some((key, value)) = pair.split_once('=') else {
                return false;
            };
            if seen.contains(&key) {
                return false;
            }
            seen.push(key);
            match key {
                "rev" => {
                    !value.is_empty()
                        && value.bytes().all(|b| {
                            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'%')
                        })
                }
                "wait" => {
                    (1..=3).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_digit())
                }
                "includeFinished" => value == "true" || value == "false",
                "agentPubkey" => value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()),
                _ => false,
            }
        });
    ok && (!by_key || seen.contains(&"agentPubkey"))
}

/// "Since you last looked" for one thread: `threadId=<uuid>` alone.
fn is_since_query(query: &str) -> bool {
    matches!(query.split_once('='), Some(("threadId", id)) if is_uuid(id))
}

/// The owner chat head the pending ack rides on: `limit=<n>` alone.
fn is_chat_head_query(query: &str) -> bool {
    match query.split_once('=') {
        Some(("limit", n)) => (1..=2).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()),
        _ => false,
    }
}

/// The call route `path` (relative to the mount) if it is one this command
/// may reach, else `None`. A query string is allowed only on the feed, the
/// delegation cards long-poll, the owner chat head and the settings read.
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
        // Voice provider settings (voice-provider-neutral §9.1).
        ["settings"] => get || method == "PUT",
        ["settings", "agents", id] => method == "PUT" && (is_uuid(id) || *id == "default"),
        // A fresh Gemini stream offer for a reconnect (§9.4).
        ["calls", id, "stream-token"] => post && is_uuid(id),
        ["calls", id] => get && is_uuid(id),
        ["calls", id, "feed"] => get && is_uuid(id),
        ["calls", id, "end" | "stop" | "focus" | "text" | "caption-corrections"] => {
            post && is_uuid(id)
        }
        ["calls", id, "asks", "state" | "cancel" | "tell-more" | "reply"] => post && is_uuid(id),
        ["calls", id, "human-asks", ask, "answer"] => post && is_uuid(id) && is_ask_id(ask),
        // The owner's delegation board (delegation-driven agents §10.1):
        // cards and their long-poll, one delegation, a worker's ask answer,
        // stop one and stop all. The host answers only the agent's owner.
        ["agents", _, "delegations"] => is_delegation_list(&parts, get),
        // The newest owner chat page, for the pending ack (§10.1).
        ["agents", agent, "chat"] => get && is_uuid(agent),
        ["agents", agent, "delegations", "cancel-all"] => post && is_uuid(agent),
        // "Since you last looked" and the owner's own seen marker.
        ["agents", agent, "delegations", "since"] => get && is_uuid(agent),
        ["agents", agent, "delegations", "seen"] => post && is_uuid(agent),
        ["agents", agent, "delegations", "asks", ask, "answer"] => {
            post && is_uuid(agent) && is_uuid(ask)
        }
        ["agents", agent, "delegations", id] => get && is_uuid(agent) && is_uuid(id),
        ["agents", agent, "delegations", id, "cancel" | "undo-stop"] => {
            post && is_uuid(agent) && is_uuid(id)
        }
        _ => false,
    };
    if !ok {
        return None;
    }
    let by_key = parts.get(1) == Some(&"-");
    match query {
        None if by_key => None,
        None => Some(route.to_string()),
        Some(query)
            if is_delegation_list(&parts, get) && is_delegation_list_query(query, by_key) =>
        {
            Some(format!("{route}?{query}"))
        }
        Some(query)
            if matches!(parts.as_slice(), ["agents", _, "delegations", "since"])
                && is_since_query(query) =>
        {
            Some(format!("{route}?{query}"))
        }
        Some(query)
            if matches!(parts.as_slice(), ["agents", _, "chat"]) && is_chat_head_query(query) =>
        {
            Some(format!("{route}?{query}"))
        }
        Some(query)
            if get
                && parts.last() == Some(&"feed")
                && query.len() <= 200
                && query.bytes().all(|b| {
                    b.is_ascii_alphanumeric()
                        || matches!(b, b'=' | b'&' | b'.' | b'_' | b'-' | b'%')
                }) =>
        {
            Some(format!("{route}?{query}"))
        }
        Some(query) if get && parts.as_slice() == ["settings"] && is_settings_query(query) => {
            Some(format!("{route}?{query}"))
        }
        Some(_) => None,
    }
}

/// `host[:port]` of the call routes' origin: the only host a Gemini stream
/// offer may send the webview's socket to (the socket itself carries only
/// its one-use capability subprotocol, never a signature).
pub(super) fn stream_host(origin: &str) -> Option<String> {
    let url = url::Url::parse(origin).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

/// The API host a Gemini call's stream may go to (see [`stream_host`]).
#[tauri::command]
pub fn agent_voice_stream_host() -> Result<String, String> {
    voice_origin(voice_url_override(), guest_route_url())
        .as_deref()
        .and_then(stream_host)
        .ok_or_else(|| error(None, "voice_route_unavailable"))
}

/// `https://host` of the call routes: the override, else the guest route's
/// origin. HTTPS only (HTTP on loopback for development).
pub(super) fn voice_origin(
    override_url: Option<String>,
    guest_route: Option<String>,
) -> Option<String> {
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
pub(super) fn voice_url_override() -> Option<String> {
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
        // Voice provider settings and a Gemini stream token.
        assert!(allowed_path("GET", "settings").is_some());
        assert!(allowed_path("PUT", "settings").is_some());
        let key = "a".repeat(64);
        assert_eq!(
            allowed_path("GET", &format!("settings?agentPubkey={key}")),
            Some(format!("settings?agentPubkey={key}"))
        );
        assert!(allowed_path("GET", &format!("settings?agentId={CALL}")).is_none());
        assert!(allowed_path("GET", "settings?agentId=default").is_none());
        assert!(allowed_path("GET", "settings?agentPubkey=abc").is_none());
        assert!(allowed_path("GET", &format!("settings?agentId={CALL}&x=1")).is_none());
        assert!(allowed_path("PUT", &format!("settings?agentId={CALL}")).is_none());
        assert!(allowed_path("PUT", &format!("settings/agents/{CALL}")).is_some());
        assert!(allowed_path("PUT", "settings/agents/default").is_some());
        assert!(allowed_path("PUT", "settings/agents/..").is_none());
        assert!(allowed_path("GET", &format!("settings/agents/{CALL}")).is_none());
        assert!(allowed_path("POST", &format!("calls/{CALL}/stream-token")).is_some());
        assert!(allowed_path("GET", &format!("calls/{CALL}/stream-token")).is_none());
        assert!(allowed_path("GET", &format!("calls/{CALL}/stream")).is_none());
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
    fn only_the_owner_delegation_routes_are_reachable() {
        let agent = CALL;
        let id = "0192a6b0-0000-7000-8000-0000000000de";
        let list = format!("agents/{agent}/delegations");
        assert_eq!(allowed_path("GET", &list), Some(list.clone()));
        let poll = format!("{list}?includeFinished=true&rev=r%3A1&wait=20");
        assert_eq!(allowed_path("GET", &poll), Some(poll.clone()));
        assert!(allowed_path("POST", &format!("{list}/cancel-all")).is_some());
        assert!(allowed_path("GET", &format!("{list}/{id}")).is_some());
        assert!(allowed_path("POST", &format!("{list}/{id}/cancel")).is_some());
        assert!(allowed_path("POST", &format!("{list}/asks/{id}/answer")).is_some());
        // Other methods, routes, queries, ids and traversal stay closed.
        assert!(allowed_path("POST", &list).is_none());
        assert!(allowed_path("GET", &format!("{list}/cancel-all")).is_none());
        assert!(allowed_path("GET", &format!("{list}/{id}?x=1")).is_none());
        assert!(allowed_path("POST", &format!("{list}/{id}/message")).is_none());
        assert!(allowed_path("POST", &format!("{list}/{id}/detach")).is_none());
        assert!(allowed_path("GET", &format!("{list}/journal")).is_none());
        assert!(allowed_path("GET", &format!("{list}/not-an-id")).is_none());
        assert!(allowed_path("POST", &format!("{list}/asks/q1/answer")).is_none());
        assert!(allowed_path("GET", "agents/default/delegations").is_none());
        assert!(allowed_path("GET", &format!("{list}?rev=a b")).is_none());
        // The long-poll query is rev, wait and includeFinished, once each.
        assert!(allowed_path("GET", &format!("{list}?rev=a%21%27%28%29%2A%7E&wait=20")).is_some());
        assert!(allowed_path("GET", &format!("{list}?rev=a!b")).is_none());
        assert!(allowed_path("GET", &format!("{list}?rev=r1&x=1")).is_none());
        assert!(allowed_path("GET", &format!("{list}?rev=r1&rev=r2")).is_none());
        assert!(allowed_path("GET", &format!("{list}?rev=")).is_none());
        assert!(allowed_path("GET", &format!("{list}?wait=2x")).is_none());
        assert!(allowed_path("GET", &format!("{list}?includeFinished=1")).is_none());
        assert!(allowed_path("GET", &format!("{list}?agentPubkey=ab")).is_none());
        // By the Buzz key: `-` needs agentPubkey, and only on the list.
        let key = "ab".repeat(32);
        let by_key = format!("agents/-/delegations?agentPubkey={key}");
        assert_eq!(allowed_path("GET", &by_key), Some(by_key.clone()));
        let by_key_poll = format!("{by_key}&rev=r%7E1&wait=20");
        assert!(allowed_path("GET", &by_key_poll).is_some());
        assert!(allowed_path("GET", "agents/-/delegations").is_none());
        assert!(allowed_path("GET", "agents/-/delegations?rev=r1").is_none());
        assert!(allowed_path("GET", &format!("{by_key}&agentPubkey={key}")).is_none());
        assert!(allowed_path(
            "POST",
            &format!("agents/-/delegations/cancel-all?agentPubkey={key}")
        )
        .is_none());
        assert!(allowed_path(
            "GET",
            &format!("agents/-/delegations/{id}?agentPubkey={key}")
        )
        .is_none());
        // Since you last looked, seen and Undo Stop.
        let since = format!("{list}/since");
        assert_eq!(allowed_path("GET", &since), Some(since.clone()));
        let since_thread = format!("{since}?threadId={id}");
        assert_eq!(
            allowed_path("GET", &since_thread),
            Some(since_thread.clone())
        );
        assert!(allowed_path("GET", &format!("{since}?threadId=x")).is_none());
        assert!(allowed_path("GET", &format!("{since}?threadId={id}&x=1")).is_none());
        assert!(allowed_path("GET", &format!("{since}?agentPubkey={key}")).is_none());
        assert!(allowed_path("POST", &since).is_none());
        assert!(allowed_path("POST", &format!("{list}/seen")).is_some());
        assert!(allowed_path("GET", &format!("{list}/seen")).is_none());
        assert!(allowed_path("POST", &format!("{list}/seen?threadId={id}")).is_none());
        assert!(allowed_path("POST", &format!("{list}/{id}/undo-stop")).is_some());
        assert!(allowed_path("GET", &format!("{list}/{id}/undo-stop")).is_none());
        assert!(allowed_path("POST", &format!("{list}/not-an-id/undo-stop")).is_none());
        assert!(allowed_path("POST", "agents/-/delegations/seen").is_none());
        // The owner chat head, for the pending ack.
        let chat = format!("agents/{agent}/chat?limit=1");
        assert_eq!(allowed_path("GET", &chat), Some(chat.clone()));
        assert!(allowed_path("POST", &chat).is_none());
        assert!(allowed_path("GET", &format!("agents/{agent}/chat?after=x")).is_none());
        assert!(allowed_path("GET", &format!("agents/{agent}/chat?limit=1&x=1")).is_none());
        assert!(allowed_path("GET", "agents/-/chat?limit=1").is_none());
        assert!(allowed_path("POST", &format!("agents/{agent}/chat/messages")).is_none());
        assert!(allowed_path("GET", &format!("agents/{agent}/ledger")).is_none());
        assert!(allowed_path("GET", &format!("{list}/../../calls")).is_none());
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
    fn the_stream_host_is_the_call_routes_host() {
        assert_eq!(
            stream_host("https://API.example.com").as_deref(),
            Some("api.example.com")
        );
        assert_eq!(
            stream_host("http://127.0.0.1:3000").as_deref(),
            Some("127.0.0.1:3000")
        );
        assert_eq!(stream_host("not a url"), None);
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

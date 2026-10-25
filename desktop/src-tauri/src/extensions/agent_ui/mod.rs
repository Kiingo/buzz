//! Native transport for agent surfaces (interactive cards an agent shows in
//! its private DM, docs/agent-dm-markers.md §7).
//!
//! A surface lives on the agent host. This module reads it from the host's
//! surface routes (`<origin>/api/buzz-ui/desktop/…`, the origin taken from
//! the guest route URL as for agent calls, or in debug builds only
//! `BUZZ_DESKTOP_AGENT_VOICE_URL`):
//!
//! - every request is NIP-98 (kind 27235, exact URL, method) signed by the
//!   signed-in user, with `X-Buzz-Community`, so the key never reaches the
//!   webview;
//! - only `GET surfaces/<uuid>` is reachable for now: the desktop shows
//!   surfaces view only, and changes happen in the host's own apps;
//! - answers are capped at 2 MiB (declared length first, then while read);
//! - the answer is returned as `{ status, body, origin }` for every HTTP
//!   status (`origin` is the host the surface's images load from); transport
//!   failures are errors.
//!
//! The host serves a surface only to the verified person it belongs to.

use std::time::Duration;

use serde_json::Value;
use tauri::State;

use super::agent_voice::{is_uuid, voice_origin, voice_url_override};
use crate::app_state::AppState;
use crate::commands::{community_id_for_relay, nip98_header};
use crate::managed_agents::access_policy::guest_route_url;
use crate::relay::relay_ws_url_with_override;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MOUNT: &str = "/api/buzz-ui/desktop";

fn error(status: Option<u16>, code: &str) -> String {
    serde_json::json!({ "status": status, "error": code }).to_string()
}

/// The surface route `path` (relative to the mount) if this command may
/// reach it, else `None`. No query strings.
fn allowed_path(method: &str, path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('/').collect();
    let ok = match parts.as_slice() {
        ["surfaces", id] => method == "GET" && is_uuid(id),
        _ => false,
    };
    ok.then(|| path.to_ascii_lowercase())
}

/// The one URL that is both signed and sent, only if its normalised path is
/// exactly the allowed route under the mount.
fn request_url(origin: &str, path: &str) -> Option<url::Url> {
    let raw = format!("{}{MOUNT}/{path}", origin.trim_end_matches('/'));
    let url = url::Url::parse(&raw).ok()?;
    (url.path() == format!("{MOUNT}/{path}") && url.query().is_none() && url.fragment().is_none())
        .then_some(url)
}

/// One signed read of the host's surface routes as the signed-in user.
/// Returns `{ "status": <u16>, "body": <JSON or null>, "origin": <host origin> }`.
#[tauri::command]
pub async fn agent_ui_request(
    method: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let method = method.trim().to_ascii_uppercase();
    let path = allowed_path(&method, path.trim().trim_start_matches('/'))
        .ok_or_else(|| error(None, "path_not_allowed"))?;
    let origin = voice_origin(voice_url_override(), guest_route_url())
        .ok_or_else(|| error(None, "surface_route_unavailable"))?;
    let community_id = community_id_for_relay(&relay_ws_url_with_override(&state));
    if community_id.is_empty() {
        return Err(error(None, "community_invalid"));
    }
    let keys = state.signing_keys()?;
    let url = request_url(&origin, &path).ok_or_else(|| error(None, "path_not_allowed"))?;
    let origin = url.origin().ascii_serialization();
    let authorization = nip98_header(&keys, &method, url.as_str(), None)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| error(None, "client_failed"))?;
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .header("Authorization", authorization)
        .header("X-Buzz-Community", community_id)
        .send()
        .await
        .map_err(|e| {
            error(
                None,
                if e.is_timeout() {
                    "surface_route_timeout"
                } else {
                    "surface_route_unreachable"
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
    Ok(serde_json::json!({ "status": status, "body": body, "origin": origin }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SURFACE: &str = "0192a6b0-0000-7000-8000-0000000000ac";

    #[test]
    fn only_a_surface_read_is_reachable() {
        assert_eq!(
            allowed_path("GET", &format!("surfaces/{SURFACE}")),
            Some(format!("surfaces/{SURFACE}"))
        );
        // Upper-case hex is the same surface.
        assert_eq!(
            allowed_path("GET", &format!("surfaces/{}", SURFACE.to_uppercase())),
            Some(format!("surfaces/{SURFACE}"))
        );
        // No writes, other routes, queries or traversal.
        assert!(allowed_path("PATCH", &format!("surfaces/{SURFACE}")).is_none());
        assert!(allowed_path("POST", &format!("surfaces/{SURFACE}/actions/a")).is_none());
        assert!(allowed_path("GET", &format!("surfaces/{SURFACE}/actions/a")).is_none());
        assert!(allowed_path("GET", "surfaces").is_none());
        assert!(allowed_path("GET", &format!("surfaces/{SURFACE}?x=1")).is_none());
        assert!(allowed_path("GET", "surfaces/../calls").is_none());
        assert!(allowed_path("GET", "surfaces/not-a-surface").is_none());
    }

    #[test]
    fn the_signed_url_is_the_sent_url_or_nothing() {
        let origin = "https://api.example.com";
        let url = request_url(origin, &format!("surfaces/{SURFACE}")).expect("allowed");
        assert_eq!(
            url.as_str(),
            format!("{origin}/api/buzz-ui/desktop/surfaces/{SURFACE}")
        );
        assert!(request_url(origin, "surfaces/./x").is_none());
        assert!(request_url(origin, "surfaces/%2e%2e").is_none());
    }
}

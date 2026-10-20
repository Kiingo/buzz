//! Whether an agent's session controls (`/sessions`, `/new`,
//! `/sessions load`) are available, from the hosted provider.
//!
//! `POST /session-controls` is a read-only lookup any linked Buzz user may
//! make: a list-shaped kind-27236 `buzz-provider-owner-v1` proof
//! (`action=session_controls`, `provider`, `request`, `community`,
//! `expires`) signed by the signed-in key, plus the agent's public key. The
//! desktop offers the DM sessions picker only when the answer says `true`.
//! The provider route and id are the hosted re-link's build configuration; a
//! build without them never offers the picker.

mod logic;

use std::time::Duration;

use tauri::State;

use crate::app_state::AppState;
use crate::commands::community_id_for_relay;
use crate::extensions::hosted_owner_relink::{build_list_shaped_request, now_seconds, post, route};
use crate::relay::relay_ws_url_with_override;

const LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);

fn error(code: &str) -> String {
    serde_json::json!({ "error": code }).to_string()
}

/// Whether the provider says session controls are available for the agent.
/// Read-only and signed without a prompt; any failure is an error the
/// renderer treats as "not available".
#[tauri::command]
pub async fn agent_session_controls_available(
    agent_public_key: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let agent = logic::normalize_agent_key(&agent_public_key)
        .ok_or_else(|| error("agent_public_key_invalid"))?;
    let route = route().ok_or_else(|| error("session_controls_unavailable"))?;
    let community_id = community_id_for_relay(&relay_ws_url_with_override(&state));
    if community_id.is_empty() {
        return Err(error("session_controls_unavailable"));
    }
    let keys = state.signing_keys()?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let body = build_list_shaped_request(
        &keys,
        logic::ACTION,
        &route.provider_id,
        &community_id,
        &request_id,
        logic::extra_fields(&agent),
        now_seconds()?,
    )
    .map_err(|code| error(&code))?;
    let response = post(&route, logic::PATH, &body, LOOKUP_TIMEOUT).await?;
    logic::parse_response(&response, &agent).map_err(|code| error(&code))
}

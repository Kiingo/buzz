//! Remote signer: a broker (configured next to the hosted guest route) can
//! ask this device to sign a relay request as the user. NIP-46 semantics
//! carried over HTTPS instead of the relay.
//!
//! - Off by default, per community and identity, stored on this device. The
//!   poller runs only while the app runs and the switch is on, with one
//!   request in flight.
//! - Every request is validated before anything is shown (`validate`), then
//!   approved by a device-local scope or by the user in a prompt.
//! - The key never leaves the backend: the renderer receives display data and
//!   sends back a decision; signing happens here (`sign`).
//! - Every call to the broker is NIP-98 signed by the user's key, with the
//!   same `X-Buzz-Community` the guest route uses.

mod broker;
mod sign;
mod store;
mod validate;
mod view;

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::app_state::AppState;
use crate::commands::guest_access::{acceptable_base_url, community_id_for_relay};
use crate::managed_agents::access_policy::guest_route_url;
use crate::relay::relay_ws_url_with_override;

use self::broker::{poll_requests, post_response, HttpFailure};
use self::sign::{decline_body, sign_response};
use self::store::{LogEntry, ProfileState, Scope, ScopeChoice};
use self::validate::{
    relay_bridge_url, validate_request, Operation, Rejection, ValidatedRequest, ValidationContext,
};
use self::view::{prompt_view, PromptView};

/// Tauri event telling the renderer to re-read the snapshot.
const CHANGED_EVENT: &str = "remote-signer-changed";
/// Explicit broker base URL; otherwise derived from the guest route.
const SIGNER_URL_ENV: &str = "BUZZ_DESKTOP_REMOTE_SIGNER_URL";
const POLL_WAIT_MS: u64 = 25_000;
const POLL_TIMEOUT: Duration = Duration::from_secs(40);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(20);
const MIN_POLL_INTERVAL: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(120);
const UNLINKED_BACKOFF: Duration = Duration::from_secs(300);
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TARGET_PREVIEW_CHARS: usize = 4_000;
/// Message kinds an edit or delete may target.
const MESSAGE_KINDS: [u16; 5] = [9, 40002, 40008, 45001, 45003];

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ── Configuration ───────────────────────────────────────────────────────────

/// Broker base URL: the explicit override, or the guest route's sibling
/// (`…/buzz-guest/v1` → `…/buzz-signer/v1`) on the same host.
fn signer_base_url() -> Option<String> {
    std::env::var(SIGNER_URL_ENV)
        .ok()
        .map(|url| url.trim().trim_end_matches('/').to_string())
        .filter(|url| !url.is_empty())
        .or_else(|| guest_route_url().and_then(|route| derive_signer_url(&route)))
        .filter(|url| acceptable_base_url(url))
}

fn derive_signer_url(guest_route: &str) -> Option<String> {
    guest_route
        .trim()
        .trim_end_matches('/')
        .strip_suffix("/buzz-guest/v1")
        .map(|prefix| format!("{prefix}/buzz-signer/v1"))
}

/// Everything one poller is bound to. A change to any of it stops the poller.
#[derive(Debug, Clone)]
struct Connection {
    base_url: String,
    community_id: String,
    pubkey: String,
    profile_key: String,
    events_url: String,
    query_url: String,
}

fn current_connection(state: &AppState) -> Result<Connection, &'static str> {
    let base_url = signer_base_url().ok_or("signer_unavailable")?;
    let relay = relay_ws_url_with_override(state);
    let community_id = community_id_for_relay(&relay);
    if community_id.is_empty() {
        return Err("community_invalid");
    }
    let events_url = relay_bridge_url(&relay, "/events").ok_or("relay_url_invalid")?;
    let query_url = relay_bridge_url(&relay, "/query").ok_or("relay_url_invalid")?;
    let pubkey = state
        .signing_keys()
        .map_err(|_| "identity_unavailable")?
        .public_key()
        .to_hex();
    Ok(Connection {
        profile_key: store::profile_key(&community_id, &pubkey),
        base_url,
        community_id,
        pubkey,
        events_url,
        query_url,
    })
}

// ── Runtime state ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Status {
    #[default]
    Off,
    Unavailable,
    Connecting,
    Listening,
    Error,
}

/// The user's answer, delivered from the prompt to the waiting poller.
#[derive(Debug)]
enum Resolution {
    Allow { decision_source: String },
    Deny,
}

struct ActivePrompt {
    profile_key: String,
    view: PromptView,
    request: ValidatedRequest,
    responder: Option<oneshot::Sender<Resolution>>,
}

struct Poller {
    profile_key: String,
    cancel: CancellationToken,
    generation: u64,
}

#[derive(Default)]
struct Runtime {
    poller: Option<Poller>,
    generation: u64,
    status: Status,
    last_error: Option<String>,
    prompt: Option<ActivePrompt>,
}

static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();
/// Serializes store file reads and writes. Lock order: runtime, then store.
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn runtime() -> MutexGuard<'static, Runtime> {
    RUNTIME
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn emit_changed(app: &AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
}

fn store_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir unavailable: {e}"))?;
    Ok(store::store_path(&dir))
}

fn read_profile(app: &AppHandle, profile_key: &str) -> ProfileState {
    let _guard = STORE_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    store_file(app)
        .map(|path| store::load(&path))
        .ok()
        .and_then(|mut file| file.profiles.remove(profile_key))
        .unwrap_or_default()
}

fn update_profile<R>(
    app: &AppHandle,
    profile_key: &str,
    update: impl FnOnce(&mut ProfileState) -> R,
) -> Result<R, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let path = store_file(app)?;
    let mut file = store::load(&path);
    let result = update(file.profiles.entry(profile_key.to_string()).or_default());
    store::save(&path, &mut file, now_ms())?;
    Ok(result)
}

fn append_log(app: &AppHandle, profile_key: &str, entry: LogEntry) {
    if let Err(error) = update_profile(app, profile_key, |profile| profile.push_log(entry)) {
        eprintln!("buzz-desktop: remote signer log write failed: {error}");
    }
    emit_changed(app);
}

// ── Poller lifecycle ────────────────────────────────────────────────────────

fn stop_poller(rt: &mut Runtime) {
    if let Some(poller) = rt.poller.take() {
        poller.cancel.cancel();
    }
    // Dropping the responder wakes the waiting poller, which then declines.
    rt.prompt = None;
}

/// Start, keep or stop the poller so it matches the switch for the current
/// community and identity.
fn reconcile(app: &AppHandle, state: &AppState) {
    let connection = current_connection(state);
    let mut rt = runtime();
    let connection = match connection {
        Ok(connection) => connection,
        Err(code) => {
            stop_poller(&mut rt);
            rt.status = if code == "signer_unavailable" {
                Status::Unavailable
            } else {
                Status::Off
            };
            return;
        }
    };
    if !read_profile(app, &connection.profile_key).enabled {
        stop_poller(&mut rt);
        rt.status = Status::Off;
        rt.last_error = None;
        return;
    }
    if rt
        .poller
        .as_ref()
        .is_some_and(|poller| poller.profile_key == connection.profile_key)
    {
        return;
    }
    stop_poller(&mut rt);
    rt.generation = rt.generation.wrapping_add(1);
    let cancel = CancellationToken::new();
    rt.poller = Some(Poller {
        profile_key: connection.profile_key.clone(),
        cancel: cancel.clone(),
        generation: rt.generation,
    });
    rt.status = Status::Connecting;
    rt.last_error = None;
    tauri::async_runtime::spawn(run_poller(app.clone(), connection, cancel, rt.generation));
}

fn set_status(app: &AppHandle, generation: u64, status: Status, error: Option<String>) {
    let changed = {
        let mut rt = runtime();
        let current = rt.poller.as_ref().map(|p| p.generation) == Some(generation);
        let changed = current && (rt.status != status || rt.last_error != error);
        if changed {
            rt.status = status;
            rt.last_error = error;
        }
        changed
    };
    if changed {
        emit_changed(app);
    }
}

async fn sleep_or_cancel(delay: Duration, cancel: &CancellationToken) -> bool {
    tokio::select! {
        _ = cancel.cancelled() => false,
        _ = tokio::time::sleep(delay) => true,
    }
}

fn backoff(failures: u32, error: &HttpFailure) -> Duration {
    if error.code == "signer_not_linked" {
        return UNLINKED_BACKOFF;
    }
    let exponent = failures.clamp(1, 7) - 1;
    Duration::from_secs(2u64 << exponent).min(MAX_BACKOFF)
}

async fn run_poller(
    app: AppHandle,
    connection: Connection,
    cancel: CancellationToken,
    generation: u64,
) {
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            set_status(
                &app,
                generation,
                Status::Error,
                Some("client_failed".into()),
            );
            return;
        }
    };
    let mut failures: u32 = 0;
    let mut handled: HashMap<String, i64> = HashMap::new();
    loop {
        if cancel.is_cancelled() {
            break;
        }
        let still_bound = current_connection(&app.state::<AppState>())
            .is_ok_and(|current| current.profile_key == connection.profile_key);
        if !still_bound {
            break;
        }
        let started = Instant::now();
        let polled = tokio::select! {
            _ = cancel.cancelled() => break,
            result = poll_requests(&client, &app, &connection) => result,
        };
        match polled {
            Ok(requests) => {
                failures = 0;
                set_status(&app, generation, Status::Listening, None);
                let now = now_ms();
                handled.retain(|_, until| *until > now);
                let empty = requests.is_empty();
                for raw in requests {
                    if cancel.is_cancelled() {
                        break;
                    }
                    handle_request(&app, &client, &connection, &cancel, &mut handled, raw).await;
                }
                if empty
                    && started.elapsed() < MIN_POLL_INTERVAL
                    && !sleep_or_cancel(MIN_POLL_INTERVAL, &cancel).await
                {
                    break;
                }
            }
            Err(error) => {
                failures = failures.saturating_add(1);
                let delay = backoff(failures, &error);
                set_status(&app, generation, Status::Error, Some(error.code));
                if !sleep_or_cancel(delay, &cancel).await {
                    break;
                }
            }
        }
    }
    let changed = {
        let mut rt = runtime();
        if rt.poller.as_ref().map(|p| p.generation) == Some(generation) {
            rt.poller = None;
            rt.prompt = None;
            rt.status = Status::Off;
            true
        } else {
            false
        }
    };
    if changed {
        emit_changed(&app);
    }
}

// ── Request handling ────────────────────────────────────────────────────────

fn operation_channel(request: &ValidatedRequest) -> Option<String> {
    match &request.operation {
        Operation::Publish { channel_id, .. } | Operation::Query { channel_id, .. } => {
            channel_id.clone()
        }
    }
    .or_else(|| request.reported_channel_id.clone())
}

fn log_entry(
    request_id: Option<String>,
    action: &str,
    channel_id: Option<String>,
    decision: &str,
    outcome: &str,
) -> LogEntry {
    LogEntry {
        at: now_ms(),
        request_id,
        action: action.chars().take(64).collect(),
        channel_id,
        decision: decision.to_string(),
        outcome: outcome.to_string(),
        event_id: None,
        detail: None,
    }
}

async fn handle_request(
    app: &AppHandle,
    client: &reqwest::Client,
    connection: &Connection,
    cancel: &CancellationToken,
    handled: &mut HashMap<String, i64>,
    raw: Value,
) {
    let ctx = ValidationContext {
        own_pubkey: connection.pubkey.clone(),
        events_url: connection.events_url.clone(),
        query_url: connection.query_url.clone(),
        now_ms: now_ms(),
    };
    let request = match validate_request(&raw, &ctx) {
        Ok(request) => request,
        Err(Rejection::Expired { request_id }) => {
            handled.insert(request_id, ctx.now_ms + 120_000);
            return;
        }
        Err(Rejection::Refused { request_id, reason }) => {
            if let Some(id) = &request_id {
                if handled.contains_key(id) {
                    return;
                }
                handled.insert(id.clone(), ctx.now_ms + 120_000);
                let _ = post_response(client, app, connection, id, &decline_body("prompt")).await;
            }
            let action = raw.get("action").and_then(Value::as_str).unwrap_or("");
            let mut entry = log_entry(request_id, action, None, "automatic", "refused");
            entry.detail = Some(reason.to_string());
            append_log(app, &connection.profile_key, entry);
            return;
        }
    };
    if handled.contains_key(&request.request_id) {
        return;
    }
    handled.insert(request.request_id.clone(), request.deadline_ms + 120_000);

    let target_content = match verify_target(app, &request, &connection.pubkey).await {
        Ok(content) => content,
        Err(reason) => {
            let _ = post_response(
                client,
                app,
                connection,
                &request.request_id,
                &decline_body("prompt"),
            )
            .await;
            let mut entry = log_entry(
                Some(request.request_id.clone()),
                &request.action,
                operation_channel(&request),
                "automatic",
                "refused",
            );
            entry.detail = Some(reason.to_string());
            append_log(app, &connection.profile_key, entry);
            return;
        }
    };

    let scope = read_profile(app, &connection.profile_key).matching_scope(&request, now_ms());
    let resolution = match scope {
        Some(scope) => Resolution::Allow {
            decision_source: format!("scope:{}", scope.id),
        },
        None => match prompt_user(app, connection, cancel, &request, target_content).await {
            Some(resolution) => resolution,
            None => return,
        },
    };
    finish_request(app, client, connection, &request, resolution).await;
}

/// Edits and deletes must target the user's own message in the same channel.
/// Returns the target's text for the prompt.
async fn verify_target(
    app: &AppHandle,
    request: &ValidatedRequest,
    own_pubkey: &str,
) -> Result<Option<String>, &'static str> {
    let Operation::Publish {
        event,
        target_event_id: Some(target),
        channel_id,
        ..
    } = &request.operation
    else {
        return Ok(None);
    };
    if !matches!(event.kind.as_u16(), 40003 | 9005) {
        return Ok(None);
    }
    let filter = json!({ "ids": [target], "kinds": MESSAGE_KINDS, "limit": 1 });
    let events = crate::relay::query_relay(&app.state::<AppState>(), &[filter])
        .await
        .map_err(|_| "target_unverifiable")?;
    let found = events
        .into_iter()
        .find(|candidate| &candidate.id.to_hex() == target)
        .ok_or("target_not_found")?;
    if found.pubkey.to_hex() != own_pubkey {
        return Err("target_not_own");
    }
    let target_channel = found
        .tags
        .iter()
        .find(|tag| tag.as_slice().first().map(String::as_str) == Some("h"))
        .and_then(|tag| tag.as_slice().get(1).cloned());
    if target_channel.as_deref() != channel_id.as_deref() {
        return Err("target_channel_mismatch");
    }
    Ok(Some(
        found
            .content
            .chars()
            .take(MAX_TARGET_PREVIEW_CHARS)
            .collect(),
    ))
}

/// Show the prompt and wait for the user, the deadline or the switch.
async fn prompt_user(
    app: &AppHandle,
    connection: &Connection,
    cancel: &CancellationToken,
    request: &ValidatedRequest,
    target_content: Option<String>,
) -> Option<Resolution> {
    let (sender, receiver) = oneshot::channel();
    {
        let mut rt = runtime();
        rt.prompt = Some(ActivePrompt {
            profile_key: connection.profile_key.clone(),
            view: prompt_view(request, target_content),
            request: request.clone(),
            responder: Some(sender),
        });
    }
    emit_changed(app);
    let wait = u64::try_from(request.deadline_ms - now_ms()).unwrap_or(0);
    let outcome = tokio::select! {
        _ = cancel.cancelled() => Err("switched_off"),
        _ = tokio::time::sleep(Duration::from_millis(wait)) => Err("expired"),
        decided = receiver => decided.map_err(|_| "switched_off"),
    };
    {
        let mut rt = runtime();
        if rt
            .prompt
            .as_ref()
            .is_some_and(|prompt| prompt.view.request_id == request.request_id)
        {
            rt.prompt = None;
        }
    }
    emit_changed(app);
    match outcome {
        Ok(resolution) => Some(resolution),
        Err(reason) => {
            // Nothing is sent back: the request fails closed at the broker.
            let outcome = if reason == "expired" {
                "expired"
            } else {
                "cancelled"
            };
            let mut entry = log_entry(
                Some(request.request_id.clone()),
                &request.action,
                operation_channel(request),
                "automatic",
                outcome,
            );
            entry.detail = Some(reason.to_string());
            append_log(app, &connection.profile_key, entry);
            None
        }
    }
}

async fn finish_request(
    app: &AppHandle,
    client: &reqwest::Client,
    connection: &Connection,
    request: &ValidatedRequest,
    resolution: Resolution,
) {
    let (decision, body, event_id) = match resolution {
        Resolution::Deny => ("prompt".to_string(), decline_body("prompt"), None),
        Resolution::Allow { decision_source } => {
            let keys = match app.state::<AppState>().signing_keys() {
                Ok(keys) if keys.public_key().to_hex() == connection.pubkey => keys,
                _ => {
                    let mut entry = log_entry(
                        Some(request.request_id.clone()),
                        &request.action,
                        operation_channel(request),
                        &decision_source,
                        "failed",
                    );
                    entry.detail = Some("identity_changed".to_string());
                    append_log(app, &connection.profile_key, entry);
                    return;
                }
            };
            let signed = sign_response(&keys, &request.operation, &decision_source);
            match signed {
                Ok(signed) => (decision_source, signed.body, signed.event_id),
                Err(error) => {
                    let mut entry = log_entry(
                        Some(request.request_id.clone()),
                        &request.action,
                        operation_channel(request),
                        &decision_source,
                        "failed",
                    );
                    entry.detail = Some(error.chars().take(64).collect());
                    append_log(app, &connection.profile_key, entry);
                    return;
                }
            }
        }
    };
    let declined = body.get("declined").is_some();
    let posted = post_response(client, app, connection, &request.request_id, &body).await;
    let outcome = match (&posted, declined) {
        (Ok(()), true) => "declined",
        (Ok(()), false) => "signed",
        (Err(_), _) => "failed",
    };
    let mut entry = log_entry(
        Some(request.request_id.clone()),
        &request.action,
        operation_channel(request),
        &decision,
        outcome,
    );
    if posted.is_ok() {
        entry.event_id = event_id;
    }
    entry.detail = posted.err().map(|error| error.code);
    append_log(app, &connection.profile_key, entry);
}

/// Everything the renderer shows: switch, status, scopes, log and prompt.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSignerSnapshot {
    available: bool,
    enabled: bool,
    status: Status,
    last_error: Option<String>,
    community_id: Option<String>,
    signer_pubkey: Option<String>,
    scopes: Vec<Scope>,
    log: Vec<LogEntry>,
    prompt: Option<PromptView>,
}

fn snapshot(app: &AppHandle, state: &AppState) -> RemoteSignerSnapshot {
    let connection = current_connection(state).ok();
    let profile = connection
        .as_ref()
        .map(|c| read_profile(app, &c.profile_key))
        .unwrap_or_default();
    let rt = runtime();
    let prompt = rt
        .prompt
        .as_ref()
        .filter(|prompt| {
            connection
                .as_ref()
                .is_some_and(|c| c.profile_key == prompt.profile_key)
        })
        .map(|prompt| prompt.view.clone());
    RemoteSignerSnapshot {
        available: signer_base_url().is_some(),
        enabled: profile.enabled,
        status: rt.status,
        last_error: rt.last_error.clone(),
        community_id: connection.as_ref().map(|c| c.community_id.clone()),
        signer_pubkey: connection.as_ref().map(|c| c.pubkey.clone()),
        scopes: profile.active_scopes(now_ms()),
        log: profile.log,
        prompt,
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// The user's answer to a prompt.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSignerDecision {
    request_id: String,
    choice: DecisionChoice,
    scope: Option<ScopeChoice>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum DecisionChoice {
    AllowOnce,
    Deny,
    AllowScope,
}

/// Current state; also starts or stops the poller to match the switch.
#[tauri::command]
pub async fn remote_signer_snapshot(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RemoteSignerSnapshot, String> {
    reconcile(&app, &state);
    Ok(snapshot(&app, &state))
}

/// Turn "Allow … to request signatures" on or off for this community and
/// identity on this device. Turning it off also revokes every scope.
#[tauri::command]
pub async fn remote_signer_set_enabled(
    enabled: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RemoteSignerSnapshot, String> {
    let connection = current_connection(&state).map_err(str::to_string)?;
    update_profile(&app, &connection.profile_key, |profile| {
        profile.enabled = enabled;
        if !enabled {
            profile.scopes.clear();
        }
    })?;
    reconcile(&app, &state);
    emit_changed(&app);
    Ok(snapshot(&app, &state))
}

/// Answer the open prompt: allow once, deny, or allow with a new scope.
#[tauri::command]
pub async fn remote_signer_decide(
    decision: RemoteSignerDecision,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RemoteSignerSnapshot, String> {
    let connection = current_connection(&state).map_err(str::to_string)?;
    {
        let mut rt = runtime();
        let Some(prompt) = rt.prompt.as_mut().filter(|prompt| {
            prompt.view.request_id == decision.request_id
                && prompt.profile_key == connection.profile_key
        }) else {
            return Err("prompt_not_open".to_string());
        };
        let resolution = match decision.choice {
            DecisionChoice::Deny => Resolution::Deny,
            DecisionChoice::AllowOnce => Resolution::Allow {
                decision_source: "prompt".to_string(),
            },
            DecisionChoice::AllowScope => {
                let choice = decision.scope.as_ref().ok_or("scope_missing")?;
                let scope = store::scope_for(&prompt.request, choice, now_ms())?;
                update_profile(&app, &connection.profile_key, |profile| {
                    profile.scopes.push(scope);
                })?;
                Resolution::Allow {
                    decision_source: "prompt".to_string(),
                }
            }
        };
        if let Some(responder) = prompt.responder.take() {
            let _ = responder.send(resolution);
        }
        rt.prompt = None;
    }
    emit_changed(&app);
    Ok(snapshot(&app, &state))
}

/// Revoke one scope, or every scope when `scope_id` is absent.
#[tauri::command]
pub async fn remote_signer_revoke_scopes(
    scope_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RemoteSignerSnapshot, String> {
    let connection = current_connection(&state).map_err(str::to_string)?;
    update_profile(&app, &connection.profile_key, |profile| match &scope_id {
        Some(id) => profile.scopes.retain(|scope| &scope.id != id),
        None => profile.scopes.clear(),
    })?;
    emit_changed(&app);
    Ok(snapshot(&app, &state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_broker_url_is_the_guest_routes_sibling() {
        assert_eq!(
            derive_signer_url("https://api.example.com/api/buzz-guest/v1/").as_deref(),
            Some("https://api.example.com/api/buzz-signer/v1")
        );
        assert_eq!(derive_signer_url("https://api.example.com/other/v1"), None);
    }

    #[test]
    fn backoff_grows_and_caps() {
        let other = HttpFailure::new("signer_unreachable");
        assert_eq!(backoff(1, &other), Duration::from_secs(2));
        assert_eq!(backoff(3, &other), Duration::from_secs(8));
        assert_eq!(backoff(50, &other), MAX_BACKOFF);
        assert_eq!(
            backoff(1, &HttpFailure::new("signer_not_linked")),
            UNLINKED_BACKOFF
        );
    }
}

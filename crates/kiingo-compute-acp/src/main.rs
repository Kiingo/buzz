//! ACP v2 adapter that turns a Buzz event envelope into an exact-user,
//! subscription-backed Kiingo Compute conversation turn.
//!
//! The process intentionally owns no provider credential and no Buzz private
//! key. It authenticates only to the narrowly scoped Kiingo bridge API. Buzz
//! publication is requested through a custom ACP update and signed by the
//! parent `buzz-acp` process.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use reqwest::StatusCode;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const JSON_RPC_VERSION: &str = "2.0";
const POLL_LIMIT: u64 = 100;
// Each cycle performs both an event replay and, while non-terminal, an action
// poll. Keep the default sub-second without creating enough sustained traffic
// for a long-running provider turn to trip the shared API edge rate limit.
const DEFAULT_POLL_INTERVAL_MS: u64 = 500;
const DEFAULT_TURN_TIMEOUT_SECS: u64 = 1_800;
const MAX_PROMPT_BYTES: usize = 2 * 1024 * 1024;
const LOCAL_ACTION_TIMEOUT_SECS: u64 = 75;
const MAX_LOCAL_ACTION_OUTPUT_BYTES: usize = 128 * 1024;

type SharedWriter = Arc<Mutex<tokio::io::Stdout>>;

#[derive(Clone)]
struct Config {
    api_base_url: String,
    internal_token: String,
    community_id: String,
    agent_public_key: String,
    poll_interval: Duration,
    turn_timeout: Duration,
}

impl Config {
    fn from_env() -> Result<Self, String> {
        let api_base_url = required_env("KIINGO_API_BASE_URL")?
            .trim_end_matches('/')
            .to_string();
        if !(api_base_url.starts_with("https://")
            || api_base_url.starts_with("http://127.0.0.1")
            || api_base_url.starts_with("http://localhost"))
        {
            return Err(
                "KIINGO_API_BASE_URL must use HTTPS (loopback HTTP is allowed for tests)"
                    .to_string(),
            );
        }
        let agent_public_key = required_env("BUZZ_AGENT_PUBLIC_KEY")?.to_ascii_lowercase();
        if !is_hex_id(&agent_public_key) {
            return Err("BUZZ_AGENT_PUBLIC_KEY must be a 64-character hex key".to_string());
        }
        Ok(Self {
            api_base_url,
            internal_token: required_env("BUZZ_BRIDGE_INTERNAL_TOKEN")?,
            community_id: required_env("BUZZ_COMMUNITY_ID")?,
            agent_public_key,
            poll_interval: Duration::from_millis(read_u64_env(
                "KIINGO_ACP_POLL_INTERVAL_MS",
                DEFAULT_POLL_INTERVAL_MS,
                50,
                5_000,
            )?),
            turn_timeout: Duration::from_secs(read_u64_env(
                "KIINGO_ACP_TURN_TIMEOUT_SECS",
                DEFAULT_TURN_TIMEOUT_SECS,
                30,
                7_200,
            )?),
        })
    }
}

fn required_env(name: &str) -> Result<String, String> {
    let value = std::env::var(name).map_err(|_| format!("{name} is required"))?;
    let value = value.trim().to_string();
    if value.is_empty() {
        Err(format!("{name} is required"))
    } else {
        Ok(value)
    }
}

fn read_u64_env(name: &str, default: u64, min: u64, max: u64) -> Result<u64, String> {
    let Some(raw) = std::env::var(name).ok() else {
        return Ok(default);
    };
    let value = raw
        .parse::<u64>()
        .map_err(|_| format!("{name} must be an integer"))?;
    if !(min..=max).contains(&value) {
        return Err(format!("{name} must be between {min} and {max}"));
    }
    Ok(value)
}

fn read_local_buzz_runtime(params: &Value) -> Option<LocalBuzzRuntime> {
    let servers = params.get("mcpServers")?.as_array()?;
    for server in servers {
        let Some(command) = server.get("command").and_then(Value::as_str) else {
            continue;
        };
        let command = command.trim();
        let Some(env_values) = server.get("env").and_then(Value::as_array) else {
            continue;
        };
        let mut relay_url = None;
        let mut canonical_relay_url = None;
        let mut private_key = None;
        let mut auth_tag = None;
        for entry in env_values {
            let name = entry.get("name").and_then(Value::as_str).unwrap_or("");
            let value = entry.get("value").and_then(Value::as_str).unwrap_or("");
            match name {
                "BUZZ_RELAY_URL" if !value.trim().is_empty() => {
                    relay_url = Some(value.trim().to_string())
                }
                "BUZZ_CANONICAL_RELAY_URL" if !value.trim().is_empty() => {
                    canonical_relay_url = Some(value.trim().to_string())
                }
                "BUZZ_PRIVATE_KEY" if !value.trim().is_empty() => {
                    private_key = Some(value.trim().to_string())
                }
                "BUZZ_AUTH_TAG" if !value.trim().is_empty() => {
                    auth_tag = Some(value.trim().to_string())
                }
                _ => {}
            }
        }
        let (Some(relay_url), Some(private_key)) = (relay_url, private_key) else {
            continue;
        };
        let configured = Path::new(command);
        let buzz_command = configured
            .parent()
            .map(|parent| parent.join("buzz"))
            .unwrap_or_else(|| PathBuf::from("buzz"));
        return Some(LocalBuzzRuntime {
            command: buzz_command,
            relay_url,
            canonical_relay_url,
            private_key,
            auth_tag,
        });
    }
    None
}

#[derive(Debug, Clone)]
struct BuzzEnvelope {
    event_id: String,
    channel_id: String,
    channel_name: Option<String>,
    author_public_key: String,
    authored_at: String,
    thread_root_event_id: Option<String>,
    text: String,
}

#[derive(Debug, Clone)]
struct AcceptedTurn {
    receipt_id: String,
}

#[derive(Debug, Clone)]
enum TurnAdmission {
    Execution(AcceptedTurn),
    ControlCompleted(String),
}

#[derive(Clone)]
struct LocalBuzzRuntime {
    command: PathBuf,
    relay_url: String,
    canonical_relay_url: Option<String>,
    private_key: String,
    auth_tag: Option<String>,
}

#[derive(Clone, Default)]
struct SessionState {
    local_buzz: Option<LocalBuzzRuntime>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalState {
    Completed,
    Failed,
    Blocked,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TurnOutcome {
    stop_reason: &'static str,
    terminal_reason: String,
}

#[derive(Debug, Clone)]
struct ActivePrompt {
    cancellation: CancellationToken,
}

struct App {
    config: Config,
    http: reqwest::Client,
    writer: SharedWriter,
    sessions: HashMap<String, SessionState>,
    active: HashMap<String, ActivePrompt>,
    completed_tx: mpsc::UnboundedSender<String>,
}

#[tokio::main]
async fn main() {
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("kiingo-compute-acp configuration error: {error}");
            std::process::exit(2);
        }
    };
    let http = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(90))
        .build()
    {
        Ok(http) => http,
        Err(error) => {
            eprintln!("kiingo-compute-acp HTTP client initialization failed: {error}");
            std::process::exit(2);
        }
    };
    let writer = Arc::new(Mutex::new(tokio::io::stdout()));
    let (completed_tx, mut completed_rx) = mpsc::unbounded_channel();
    let mut app = App {
        config,
        http,
        writer,
        sessions: HashMap::new(),
        active: HashMap::new(),
        completed_tx,
    };
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(line)) => handle_line(&mut app, &line).await,
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!("kiingo-compute-acp stdin failed: {error}");
                        break;
                    }
                }
            }
            Some(session_id) = completed_rx.recv() => {
                app.active.remove(&session_id);
            }
        }
    }
    for prompt in app.active.values() {
        prompt.cancellation.cancel();
    }
}

async fn handle_line(app: &mut App, line: &str) {
    if line.len() > MAX_PROMPT_BYTES {
        send_error(
            &app.writer,
            Value::Null,
            -32600,
            "request exceeds the adapter limit",
        )
        .await;
        return;
    }
    let request: Value = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(_) => {
            send_error(&app.writer, Value::Null, -32700, "invalid JSON").await;
            return;
        }
    };
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let id = request.get("id").cloned();
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "initialize" => {
            if let Some(id) = id {
                send_result(
                    &app.writer,
                    id,
                    json!({
                        "protocolVersion": 2,
                        "agentCapabilities": {
                            "loadSession": false,
                            "promptCapabilities": {"image": false, "audio": false, "embeddedContext": false},
                            "mcpCapabilities": {"http": false, "sse": false}
                        },
                        "agentInfo": {"name": "kiingo-compute-acp", "version": env!("CARGO_PKG_VERSION")}
                    }),
                )
                .await;
            }
        }
        "session/new" => {
            let Some(id) = id else { return };
            let session_id = format!("kiingo_{}", Uuid::new_v4());
            app.sessions.insert(
                session_id.clone(),
                SessionState {
                    local_buzz: read_local_buzz_runtime(&params),
                },
            );
            send_result(&app.writer, id, json!({"sessionId": session_id})).await;
        }
        "session/prompt" => {
            let Some(id) = id else { return };
            let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
                send_error(&app.writer, id, -32602, "sessionId is required").await;
                return;
            };
            let Some(session) = app.sessions.get(session_id).cloned() else {
                send_error(&app.writer, id, -32602, "unknown sessionId").await;
                return;
            };
            if app.active.contains_key(session_id) {
                send_error(
                    &app.writer,
                    id,
                    -32000,
                    "session already has an active prompt",
                )
                .await;
                return;
            }
            let envelope = match parse_prompt_envelope(&params) {
                Ok(envelope) => envelope,
                Err(error) => {
                    send_error(&app.writer, id, -32602, &error).await;
                    return;
                }
            };
            let session_id = session_id.to_string();
            let cancellation = CancellationToken::new();
            let receipt_id = Arc::new(Mutex::new(None));
            app.active.insert(
                session_id.clone(),
                ActivePrompt {
                    cancellation: cancellation.clone(),
                },
            );
            let context = PromptContext {
                config: app.config.clone(),
                http: app.http.clone(),
                writer: Arc::clone(&app.writer),
                session_id: session_id.clone(),
                request_id: id,
                envelope,
                local_buzz: session.local_buzz,
                cancellation,
                receipt_id,
            };
            let completed_tx = app.completed_tx.clone();
            tokio::spawn(async move {
                run_prompt(context).await;
                let _ = completed_tx.send(session_id);
            });
        }
        "session/cancel" => {
            if let Some(session_id) = params.get("sessionId").and_then(Value::as_str) {
                if let Some(prompt) = app.active.get(session_id) {
                    prompt.cancellation.cancel();
                }
            }
            if let Some(id) = id {
                send_result(&app.writer, id, Value::Null).await;
            }
        }
        _ => {
            if let Some(id) = id {
                send_error(&app.writer, id, -32601, "method not found").await;
            }
        }
    }
}

struct PromptContext {
    config: Config,
    http: reqwest::Client,
    writer: SharedWriter,
    session_id: String,
    request_id: Value,
    envelope: BuzzEnvelope,
    local_buzz: Option<LocalBuzzRuntime>,
    cancellation: CancellationToken,
    receipt_id: Arc<Mutex<Option<String>>>,
}

async fn run_prompt(context: PromptContext) {
    let outcome = tokio::time::timeout(context.config.turn_timeout, execute_turn(&context)).await;
    match outcome {
        Ok(Ok(outcome)) => {
            send_result(
                &context.writer,
                context.request_id,
                json!({
                    "stopReason": outcome.stop_reason,
                    "_meta": {"kiingo": {"terminal_reason": outcome.terminal_reason}}
                }),
            )
            .await;
        }
        Ok(Err(error)) => {
            emit_message_chunk(
                &context.writer,
                &context.session_id,
                "Kiingo could not complete this request. The failure was recorded without exposing credentials.",
            )
            .await;
            send_error(&context.writer, context.request_id, -32000, &error).await;
        }
        Err(_) => {
            if let Some(receipt_id) = context.receipt_id.lock().await.clone() {
                let _ = cancel_turn(&context, &receipt_id).await;
                let _ = publish_status(
                    &context,
                    &receipt_id,
                    "cancelled",
                    "timeout",
                    "This Codex turn reached its time limit and was stopped.",
                )
                .await;
            }
            send_result(
                &context.writer,
                context.request_id,
                json!({
                    "stopReason": "cancelled",
                    "_meta": {"kiingo": {"terminal_reason": "turn_timeout"}}
                }),
            )
            .await;
        }
    }
}

async fn execute_turn(context: &PromptContext) -> Result<TurnOutcome, String> {
    let accepted = match accept_turn(context).await? {
        TurnAdmission::Execution(accepted) => accepted,
        TurnAdmission::ControlCompleted(message) => {
            emit_message_chunk(&context.writer, &context.session_id, &message).await;
            return Ok(TurnOutcome {
                stop_reason: "end_turn",
                terminal_reason: "control_completed".to_string(),
            });
        }
    };
    *context.receipt_id.lock().await = Some(accepted.receipt_id.clone());
    publish_status(
        context,
        &accepted.receipt_id,
        "receipt",
        "accepted",
        "Received — starting your Codex session now.",
    )
    .await?;
    emit_message_chunk(
        &context.writer,
        &context.session_id,
        "Kiingo durably accepted the request.",
    )
    .await;

    let mut after_sequence = 0_u64;
    let mut last_status: Option<String> = None;
    let mut final_text: Option<String> = None;
    let mut output_observed = false;
    let mut terminal: Option<TerminalState> = None;
    let mut terminal_reason: Option<String> = None;
    loop {
        tokio::select! {
            _ = context.cancellation.cancelled() => {
                cancel_turn(context, &accepted.receipt_id).await?;
                publish_status(
                    context,
                    &accepted.receipt_id,
                    "cancelled",
                    "cancelled",
                    "Stopped this Codex turn.",
                ).await?;
                return Ok(TurnOutcome {
                    stop_reason: "cancelled",
                    terminal_reason: "user_cancelled_turn".to_string(),
                });
            }
            _ = tokio::time::sleep(context.config.poll_interval) => {}
        }

        let replay = fetch_events(context, &accepted.receipt_id, after_sequence).await?;
        after_sequence = replay
            .get("next_sequence")
            .and_then(Value::as_u64)
            .unwrap_or(after_sequence);
        if let Some(events) = replay.get("events").and_then(Value::as_array) {
            for event in events {
                if let Some(text) = assistant_text(event) {
                    final_text = Some(text.to_string());
                    if !output_observed {
                        emit_message_chunk(
                            &context.writer,
                            &context.session_id,
                            "Codex produced an answer; Buzz is publishing it with the local agent identity.",
                        )
                        .await;
                        output_observed = true;
                    }
                }
                let projected_activity = activity_status(event);
                if let Some((status, label)) = projected_activity {
                    if last_status.as_deref() != Some(status) && is_visible_progress(status) {
                        publish_status(
                            context,
                            &accepted.receipt_id,
                            publication_kind_for_status(status),
                            &format!("event:{}", event_sequence(event)),
                            label,
                        )
                        .await?;
                        last_status = Some(status.to_string());
                    }
                }
                if terminal.is_none() {
                    if let Some(state) =
                        terminal_state(event, projected_activity.map(|(status, _)| status))
                    {
                        terminal_reason = Some(event_terminal_reason(event, state));
                        terminal = Some(state);
                    }
                }
                if event.get("eventType").and_then(Value::as_str)
                    == Some("executor.dispatch.blocked")
                {
                    if let Some(text) = message_text(event) {
                        publish_status(
                            context,
                            &accepted.receipt_id,
                            "capacity",
                            &format!("event:{}", event_sequence(event)),
                            text,
                        )
                        .await?;
                    }
                    if terminal.is_none() {
                        terminal_reason =
                            Some(event_terminal_reason(event, TerminalState::Blocked));
                        terminal = Some(TerminalState::Blocked);
                    }
                }
            }
        }
        if let Some(state) = terminal {
            match state {
                TerminalState::Completed => {
                    let text = final_text
                        .as_deref()
                        .unwrap_or("Codex completed the turn without returning a text response.");
                    publish_status(context, &accepted.receipt_id, "final", "final", text).await?;
                    return Ok(TurnOutcome {
                        stop_reason: "end_turn",
                        terminal_reason: terminal_reason.unwrap_or_else(|| "completed".to_string()),
                    });
                }
                TerminalState::Cancelled => {
                    return Ok(TurnOutcome {
                        stop_reason: "cancelled",
                        terminal_reason: terminal_reason
                            .unwrap_or_else(|| "user_cancelled_turn".to_string()),
                    })
                }
                TerminalState::Blocked | TerminalState::Failed => {
                    let text = latest_terminal_text(&replay).unwrap_or_else(|| {
                        if state == TerminalState::Blocked {
                            "Codex could not start because ready interactive capacity is unavailable. No cold container was launched.".to_string()
                        } else {
                            "The Codex turn failed. Kiingo recorded the failure for recovery.".to_string()
                        }
                    });
                    publish_status(
                        context,
                        &accepted.receipt_id,
                        if state == TerminalState::Blocked {
                            "capacity"
                        } else {
                            "error"
                        },
                        "terminal",
                        &text,
                    )
                    .await?;
                    return Ok(TurnOutcome {
                        stop_reason: "end_turn",
                        terminal_reason: terminal_reason.unwrap_or_else(|| {
                            if state == TerminalState::Blocked {
                                "capacity_blocked".to_string()
                            } else {
                                "provider_failed".to_string()
                            }
                        }),
                    });
                }
            }
        }
        // Terminal replay is authoritative and must be observed before polling
        // the optional action queue. Terminalization revokes action grants, so
        // an action poll can legitimately be rejected after the model finishes;
        // letting that rejection run first would strand the receipt in
        // `running` and suppress the final Buzz publication.
        process_next_action(context, &accepted.receipt_id).await?;
    }
}

async fn accept_turn(context: &PromptContext) -> Result<TurnAdmission, String> {
    let url = format!("{}/api/buzz-bridge/events", context.config.api_base_url);
    let response = context
        .http
        .post(url)
        .header("x-kiingo-internal-token", &context.config.internal_token)
        .json(&json!({
            "community_id": context.config.community_id,
            "agent_public_key": context.config.agent_public_key,
            "author_public_key": context.envelope.author_public_key,
            "event_id": context.envelope.event_id,
            "channel_id": context.envelope.channel_id,
            "channel_name": context.envelope.channel_name,
            "thread_root_event_id": context.envelope.thread_root_event_id,
            "text": context.envelope.text,
            "authored_at": context.envelope.authored_at,
            "event_metadata": {"source": "buzz_acp_format_event_block", "contract_version": 1}
        }))
        .send()
        .await
        .map_err(|error| format!("Kiingo ingress request failed: {error}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Kiingo ingress response was invalid: {error}"))?;
    if !status.is_success() {
        let code = body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Err(actionable_ingress_error(status, code));
    }
    if body.get("enrollment_completed").and_then(Value::as_bool) == Some(true) {
        let message = body
            .get("enrollment_message")
            .and_then(Value::as_str)
            .unwrap_or("Your Buzz identity is linked to Kiingo.")
            .to_string();
        let enrollment_url = body.get("enrollment_url").and_then(Value::as_str);
        return Ok(TurnAdmission::ControlCompleted(match enrollment_url {
            Some(url)
                if !body
                    .get("codex_connected")
                    .and_then(Value::as_bool)
                    .unwrap_or(false) =>
            {
                format!("{message} {url}")
            }
            _ => message,
        }));
    }
    if body.get("control_completed").and_then(Value::as_bool) == Some(true) {
        let message = body
            .get("control_message")
            .and_then(Value::as_str)
            .unwrap_or("The Buzz control request was applied.")
            .to_string();
        return Ok(TurnAdmission::ControlCompleted(message));
    }
    let receipt_id = required_json_string(&body, "receipt_id")?;
    required_json_string(&body, "conversation_id")?;
    if body.get("selected_harness").and_then(Value::as_str) != Some("codex")
        || body.get("cold_fallback").and_then(Value::as_bool) != Some(false)
    {
        return Err("Kiingo ingress violated the Codex no-cold-start contract".to_string());
    }
    Ok(TurnAdmission::Execution(AcceptedTurn { receipt_id }))
}

fn actionable_ingress_error(status: StatusCode, code: &str) -> String {
    match code {
        "buzz_identity_not_verified"
        | "buzz_identity_ambiguous"
        | "buzz_identity_endpoint_not_eligible"
        | "buzz_identity_enrollment_invalid"
        | "buzz_identity_enrollment_conflict"
        | "buzz_codex_subscription_not_connected"
        | "buzz_codex_subscription_routing_ambiguous" => format!(
            "Buzz identity or Codex access is not active. Link the Buzz public key and connect this user's ChatGPT account at https://app.kiingo.com/team/harness-connections?provider=codex&buzz=connect ({code})."
        ),
        _ => format!("Kiingo rejected the Buzz event with HTTP {} ({code})", status.as_u16()),
    }
}

async fn fetch_events(
    context: &PromptContext,
    receipt_id: &str,
    after_sequence: u64,
) -> Result<Value, String> {
    let url = format!(
        "{}/api/buzz-bridge/receipts/{}/events",
        context.config.api_base_url, receipt_id
    );
    let response = context
        .http
        .get(url)
        .header("x-kiingo-internal-token", &context.config.internal_token)
        .query(&[
            ("community_id", context.config.community_id.as_str()),
            ("agent_public_key", context.config.agent_public_key.as_str()),
            ("after_sequence", &after_sequence.to_string()),
            ("limit", &POLL_LIMIT.to_string()),
        ])
        .send()
        .await
        .map_err(|error| format!("Kiingo event replay failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Kiingo event replay returned HTTP {}",
            status.as_u16()
        ));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Kiingo event replay response was invalid: {error}"))?;
    Ok(body)
}

async fn fetch_next_action(
    context: &PromptContext,
    receipt_id: &str,
    worker_id: &str,
) -> Result<Option<Value>, String> {
    let url = format!(
        "{}/api/buzz-bridge/receipts/{}/actions/next",
        context.config.api_base_url, receipt_id
    );
    let response = context
        .http
        .get(url)
        .header("x-kiingo-internal-token", &context.config.internal_token)
        .query(&[
            ("community_id", context.config.community_id.as_str()),
            ("agent_public_key", context.config.agent_public_key.as_str()),
            ("worker_id", worker_id),
        ])
        .send()
        .await
        .map_err(|error| format!("Buzz action poll failed: {error}"))?;
    if response.status() == StatusCode::NO_CONTENT {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "Buzz action poll returned HTTP {}",
            response.status().as_u16()
        ));
    }
    response
        .json()
        .await
        .map(Some)
        .map_err(|error| format!("Buzz action poll response was invalid: {error}"))
}

async fn complete_action(
    context: &PromptContext,
    receipt_id: &str,
    action_id: &str,
    worker_id: &str,
    ok: bool,
    result: Value,
    error_code: Option<&str>,
) -> Result<(), String> {
    let url = format!(
        "{}/api/buzz-bridge/receipts/{}/actions/{}/complete",
        context.config.api_base_url, receipt_id, action_id
    );
    let response = context
        .http
        .post(url)
        .header("x-kiingo-internal-token", &context.config.internal_token)
        .json(&json!({
            "community_id": context.config.community_id,
            "agent_public_key": context.config.agent_public_key,
            "worker_id": worker_id,
            "ok": ok,
            "result": result,
            "error_code": error_code
        }))
        .send()
        .await
        .map_err(|error| format!("Buzz action completion failed: {error}"))?;
    if response.status().is_success() || response.status() == StatusCode::CONFLICT {
        Ok(())
    } else {
        Err(format!(
            "Buzz action completion returned HTTP {}",
            response.status().as_u16()
        ))
    }
}

fn action_arguments(action: &Value) -> Value {
    action
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}))
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn render_checkpoint(arguments: &Value) -> String {
    let summary = arguments
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("Task checkpoint recorded.");
    let partial = string_list(arguments.get("partial_results"));
    let remaining = string_list(arguments.get("remaining_work"));
    let mut lines = vec![format!("**Task checkpoint**\n\n{summary}")];
    if !partial.is_empty() {
        lines.push(format!(
            "**Partial results**\n{}",
            partial
                .iter()
                .map(|item| format!("- {item}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if !remaining.is_empty() {
        lines.push(format!(
            "**Remaining work**\n{}",
            remaining
                .iter()
                .map(|item| format!("- {item}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    lines.join("\n\n")
}

fn render_approval(action_id: &str, operation: &str, arguments: &Value) -> String {
    let reason = arguments
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("The agent requested a high-impact Buzz action.");
    let argv = arguments.get("argv").cloned().unwrap_or_else(|| json!([]));
    format!(
        "**Approval required**\n\nOperation: `{operation}`\n\nReason: {reason}\n\nExact arguments: `{}`\n\nApprove: `/kiingo approve {action_id}`\n\nReject: `/kiingo reject {action_id}`",
        argv
    )
}

fn truncate_action_output(bytes: &[u8], runtime: &LocalBuzzRuntime) -> String {
    let end = bytes.len().min(MAX_LOCAL_ACTION_OUTPUT_BYTES);
    let mut output = String::from_utf8_lossy(&bytes[..end]).to_string();
    output = output.replace(&runtime.private_key, "[REDACTED_BUZZ_PRIVATE_KEY]");
    if let Some(auth_tag) = &runtime.auth_tag {
        output = output.replace(auth_tag, "[REDACTED_BUZZ_AUTH_TAG]");
    }
    if bytes.len() > end {
        output.push_str("\n[output truncated by Kiingo Buzz action bridge]");
    }
    output
}

fn build_local_buzz_command(runtime: &LocalBuzzRuntime, argv: &[&str]) -> Command {
    let mut command = Command::new(&runtime.command);
    // Buzz HTTP actions bind their community from the request Host header.
    // The long-lived ACP connection may dial an internal Kubernetes service,
    // but a one-shot CLI action must dial the canonical community authority or
    // the relay correctly rejects that internal service host as unmapped.
    let action_relay_url = runtime
        .canonical_relay_url
        .as_deref()
        .unwrap_or(&runtime.relay_url);
    command
        .args(argv)
        .env_clear()
        .env("BUZZ_RELAY_URL", action_relay_url)
        .env("BUZZ_PRIVATE_KEY", &runtime.private_key)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(canonical_relay_url) = &runtime.canonical_relay_url {
        command.env("BUZZ_CANONICAL_RELAY_URL", canonical_relay_url);
    } else {
        command.env_remove("BUZZ_CANONICAL_RELAY_URL");
    }
    if let Some(auth_tag) = &runtime.auth_tag {
        command.env("BUZZ_AUTH_TAG", auth_tag);
    } else {
        command.env_remove("BUZZ_AUTH_TAG");
    }
    command
}

async fn execute_local_buzz_action(
    runtime: Option<&LocalBuzzRuntime>,
    arguments: &Value,
) -> (bool, Value, Option<&'static str>) {
    let Some(runtime) = runtime else {
        return (
            false,
            json!({"error": "local_buzz_runtime_unavailable"}),
            Some("buzz_action_local_runtime_unavailable"),
        );
    };
    let Some(argv_values) = arguments.get("argv").and_then(Value::as_array) else {
        return (
            false,
            json!({"error": "invalid_action_argv"}),
            Some("buzz_action_argv_invalid"),
        );
    };
    let mut argv = Vec::with_capacity(argv_values.len());
    for value in argv_values {
        let Some(argument) = value.as_str() else {
            return (
                false,
                json!({"error": "invalid_action_argv"}),
                Some("buzz_action_argv_invalid"),
            );
        };
        argv.push(argument);
    }
    let mut command = build_local_buzz_command(runtime, &argv);
    match tokio::time::timeout(
        Duration::from_secs(LOCAL_ACTION_TIMEOUT_SECS),
        command.output(),
    )
    .await
    {
        Ok(Ok(output)) => {
            let ok = output.status.success();
            let result = json!({
                "exit_code": output.status.code(),
                "stdout": truncate_action_output(&output.stdout, runtime),
                "stderr": truncate_action_output(&output.stderr, runtime)
            });
            (
                ok,
                result,
                if ok {
                    None
                } else {
                    Some("buzz_action_command_failed")
                },
            )
        }
        Ok(Err(_)) => (
            false,
            json!({"error": "local_buzz_command_failed_to_start"}),
            Some("buzz_action_command_start_failed"),
        ),
        Err(_) => (
            false,
            json!({"error": "local_buzz_command_timed_out"}),
            Some("buzz_action_command_timeout"),
        ),
    }
}

async fn process_next_action(context: &PromptContext, receipt_id: &str) -> Result<(), String> {
    let worker_id = format!("kiingo-compute-acp:{}", context.session_id);
    let Some(action) = fetch_next_action(context, receipt_id, &worker_id).await? else {
        return Ok(());
    };
    let action_id = required_json_string(&action, "action_id")?;
    let action_kind = required_json_string(&action, "action_kind")?;
    let operation = required_json_string(&action, "operation")?;
    let arguments = action_arguments(&action);
    let outcome = match action_kind.as_str() {
        "progress" => {
            let message = arguments
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Codex reported progress.");
            match publish_status(
                context,
                receipt_id,
                "action",
                &format!("progress:{action_id}"),
                message,
            )
            .await
            {
                Ok(()) => (true, json!({"published": true}), None),
                Err(error) => (
                    false,
                    json!({"error": error}),
                    Some("buzz_action_progress_publish_failed"),
                ),
            }
        }
        "complete" => {
            let content = render_checkpoint(&arguments);
            match publish_status(
                context,
                receipt_id,
                "action",
                &format!("completion:{action_id}"),
                &content,
            )
            .await
            {
                Ok(()) => (true, json!({"published": true}), None),
                Err(error) => (
                    false,
                    json!({"error": error}),
                    Some("buzz_action_completion_publish_failed"),
                ),
            }
        }
        "approval_proposal" => {
            let content = render_approval(&action_id, &operation, &arguments);
            match publish_status(
                context,
                receipt_id,
                "action",
                &format!("approval:{action_id}"),
                &content,
            )
            .await
            {
                Ok(()) => (
                    true,
                    json!({
                        "proposal_id": action_id,
                        "approval_command": format!("/kiingo approve {action_id}"),
                        "rejection_command": format!("/kiingo reject {action_id}"),
                        "published": true
                    }),
                    None,
                ),
                Err(error) => (
                    false,
                    json!({"error": error}),
                    Some("buzz_action_approval_publish_failed"),
                ),
            }
        }
        "execute" => execute_local_buzz_action(context.local_buzz.as_ref(), &arguments).await,
        _ => (
            false,
            json!({"error": "unsupported_action_kind"}),
            Some("buzz_action_kind_unsupported"),
        ),
    };
    complete_action(
        context, receipt_id, &action_id, &worker_id, outcome.0, outcome.1, outcome.2,
    )
    .await
}

async fn cancel_turn(context: &PromptContext, receipt_id: &str) -> Result<(), String> {
    let url = format!(
        "{}/api/buzz-bridge/receipts/{}/cancel",
        context.config.api_base_url, receipt_id
    );
    let response = context
        .http
        .post(url)
        .header("x-kiingo-internal-token", &context.config.internal_token)
        .json(&json!({
            "community_id": context.config.community_id,
            "agent_public_key": context.config.agent_public_key,
            "idempotency_key": format!("buzz-cancel:{receipt_id}")
        }))
        .send()
        .await
        .map_err(|error| format!("Kiingo cancellation request failed: {error}"))?;
    if response.status().is_success() || response.status() == StatusCode::CONFLICT {
        Ok(())
    } else {
        Err(format!(
            "Kiingo cancellation returned HTTP {}",
            response.status().as_u16()
        ))
    }
}

async fn publish_status(
    context: &PromptContext,
    receipt_id: &str,
    publication_kind: &str,
    suffix: &str,
    content: &str,
) -> Result<(), String> {
    let idempotency_key = format!("buzz-publication:{receipt_id}:{publication_kind}:{suffix}");
    let payload = json!({
        "channel_id": context.envelope.channel_id,
        "thread_root_event_id": context.envelope.thread_root_event_id,
        "reply_to_event_id": context.envelope.event_id,
        "content": content
    });
    let url = format!(
        "{}/api/buzz-bridge/receipts/{}/publications/claim",
        context.config.api_base_url, receipt_id
    );
    let response = context
        .http
        .post(url)
        .header("x-kiingo-internal-token", &context.config.internal_token)
        .json(&json!({
            "community_id": context.config.community_id,
            "agent_public_key": context.config.agent_public_key,
            "idempotency_key": idempotency_key,
            "publication_kind": publication_kind,
            "payload": payload
        }))
        .send()
        .await
        .map_err(|error| format!("publication fence request failed: {error}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("publication fence response was invalid: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "publication fence returned HTTP {}",
            status.as_u16()
        ));
    }
    let fence_status = body.get("status").and_then(Value::as_str).unwrap_or("");
    let should_publish = body
        .get("should_publish")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    // A `publishing` fence is also emitted for local reconciliation. The
    // parent first queries the relay by the fence's durable d-tag; it will not
    // publish a second event if the previous process died after submission.
    if !should_publish && fence_status != "publishing" {
        return Ok(());
    }
    let fence_id = required_json_string(&body, "fence_id")?;
    emit_publication_intent(
        &context.writer,
        &context.session_id,
        json!({
            "sessionUpdate": "kiingo_buzz_publication",
            "community_id": context.config.community_id,
            "agent_public_key": context.config.agent_public_key,
            "receipt_id": receipt_id,
            "fence_id": fence_id,
            "channel_id": context.envelope.channel_id,
            "thread_root_event_id": context.envelope.thread_root_event_id,
            "reply_to_event_id": context.envelope.event_id,
            "publication_kind": publication_kind,
            "content": content
        }),
    )
    .await;
    Ok(())
}

fn parse_prompt_envelope(params: &Value) -> Result<BuzzEnvelope, String> {
    if let Some(metadata) = params.pointer("/_meta/buzz") {
        return parse_structured_buzz_metadata(metadata);
    }
    let prompt = params
        .get("prompt")
        .and_then(Value::as_array)
        .ok_or_else(|| "prompt content blocks are required".to_string())?;
    let event_block = prompt
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .filter_map(last_event_segment)
        .next_back()
        .ok_or_else(|| "prompt does not contain an upstream Buzz event block".to_string())?;
    parse_event_block(event_block)
}

fn parse_structured_buzz_metadata(metadata: &Value) -> Result<BuzzEnvelope, String> {
    if metadata.get("contractVersion").and_then(Value::as_u64) != Some(1) {
        return Err("unsupported structured Buzz metadata contract".to_string());
    }
    let event_id = required_json_string(metadata, "eventId")?;
    let channel_id = required_json_string(metadata, "channelId")?;
    let author_public_key = required_json_string(metadata, "authorPublicKey")?.to_ascii_lowercase();
    let authored_at = required_json_string(metadata, "authoredAt")?;
    let text = required_json_string(metadata, "text")?;
    if !is_hex_id(&event_id)
        || !is_hex_id(&author_public_key)
        || Uuid::parse_str(&channel_id).is_err()
        || chrono::DateTime::parse_from_rfc3339(&authored_at).is_err()
    {
        return Err("structured Buzz metadata failed validation".to_string());
    }
    let thread_root_event_id = metadata
        .get("threadRootEventId")
        .and_then(Value::as_str)
        .map(str::to_string);
    if thread_root_event_id
        .as_deref()
        .is_some_and(|root| !is_hex_id(root))
    {
        return Err("structured Buzz thread root is invalid".to_string());
    }
    if metadata.get("replyToEventId").and_then(Value::as_str) != Some(event_id.as_str()) {
        return Err("structured Buzz reply target does not match the event".to_string());
    }
    Ok(BuzzEnvelope {
        event_id,
        channel_id: Uuid::parse_str(&channel_id)
            .map_err(|_| "structured Buzz channel is invalid".to_string())?
            .to_string(),
        channel_name: metadata
            .get("channelName")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string),
        author_public_key,
        authored_at,
        thread_root_event_id,
        text,
    })
}

fn last_event_segment(text: &str) -> Option<&str> {
    text.rfind("Event ID: ").map(|index| &text[index..])
}

fn parse_event_block(block: &str) -> Result<BuzzEnvelope, String> {
    let event_id = field_line(block, "Event ID: ")?;
    if !is_hex_id(&event_id) {
        return Err("event ID is not a 64-character hex value".to_string());
    }
    let channel_line = field_line(block, "Channel: ")?;
    let channel_id = extract_uuid(&channel_line)
        .ok_or_else(|| "channel field does not contain a UUID".to_string())?;
    let channel_name = channel_line
        .split_once(" (#")
        .map(|(name, _)| name.trim().to_string())
        .filter(|name| !name.is_empty());
    let from = field_line(block, "From: ")?;
    let author_public_key = extract_author_hex(&from)
        .ok_or_else(|| "sender field does not contain a 64-character hex key".to_string())?;
    let authored_at = field_line(block, "Time: ")?;
    chrono::DateTime::parse_from_rfc3339(&authored_at)
        .map_err(|_| "event time is not RFC3339".to_string())?;
    let content_start = block
        .find("\nContent: ")
        .map(|index| index + "\nContent: ".len())
        .ok_or_else(|| "event content field is missing".to_string())?;
    let after_content = &block[content_start..];
    let content_end = after_content
        .rfind("\nTags: ")
        .ok_or_else(|| "event tags boundary is missing".to_string())?;
    let text = after_content[..content_end].to_string();
    if text.trim().is_empty() {
        return Err("event content is empty".to_string());
    }
    let thread_root_event_id = block
        .lines()
        .find_map(|line| line.strip_prefix("Parsed: "))
        .and_then(|parsed| {
            parsed.split(',').find_map(|part| {
                part.trim()
                    .strip_prefix("root=")
                    .filter(|value| is_hex_id(value))
                    .map(str::to_string)
            })
        });
    Ok(BuzzEnvelope {
        event_id,
        channel_id,
        channel_name,
        author_public_key,
        authored_at,
        thread_root_event_id,
        text,
    })
}

fn field_line(block: &str, prefix: &str) -> Result<String, String> {
    block
        .lines()
        .find_map(|line| line.strip_prefix(prefix))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("event field {prefix:?} is missing"))
}

fn extract_uuid(value: &str) -> Option<String> {
    value
        .split(|character: char| !(character.is_ascii_hexdigit() || character == '-'))
        .find_map(|candidate| Uuid::parse_str(candidate).ok().map(|id| id.to_string()))
}

fn extract_author_hex(value: &str) -> Option<String> {
    let marker = "hex: ";
    let start = value.rfind(marker)? + marker.len();
    let candidate: String = value[start..]
        .chars()
        .take_while(|character| character.is_ascii_hexdigit())
        .take(64)
        .collect();
    is_hex_id(&candidate).then(|| candidate.to_ascii_lowercase())
}

fn is_hex_id(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn assistant_text(event: &Value) -> Option<&str> {
    (event.get("kind").and_then(Value::as_str) == Some("message")
        && event.pointer("/payload/role").and_then(Value::as_str) == Some("assistant"))
    .then(|| event.pointer("/payload/text").and_then(Value::as_str))
    .flatten()
    .filter(|text| !text.trim().is_empty())
}

fn message_text(event: &Value) -> Option<&str> {
    (event.get("kind").and_then(Value::as_str) == Some("message"))
        .then(|| event.pointer("/payload/text").and_then(Value::as_str))
        .flatten()
        .filter(|text| !text.trim().is_empty())
}

fn activity_status(event: &Value) -> Option<(&str, &str)> {
    if event.get("kind").and_then(Value::as_str) != Some("activity") {
        return None;
    }
    Some((
        event.pointer("/payload/status")?.as_str()?,
        event.pointer("/payload/label")?.as_str()?,
    ))
}

fn terminal_state(event: &Value, status: Option<&str>) -> Option<TerminalState> {
    match (event.get("eventType").and_then(Value::as_str), status) {
        (Some("agent_completion"), _) => Some(TerminalState::Completed),
        (Some("agent_failure" | "platform_unavailable"), _) => Some(TerminalState::Failed),
        (Some("agent_blocked"), _) => Some(TerminalState::Blocked),
        (Some("platform_canceled"), _) => Some(TerminalState::Cancelled),
        (Some("executor.dispatch.completed"), Some("completed")) => Some(TerminalState::Completed),
        (Some("executor.dispatch.failed" | "turn.execution.dead_lettered"), _) => {
            Some(TerminalState::Failed)
        }
        (Some("executor.dispatch.blocked"), _) => Some(TerminalState::Blocked),
        (Some("executor.dispatch.cancelled"), _) => Some(TerminalState::Cancelled),
        _ => None,
    }
}

fn event_terminal_reason(event: &Value, state: TerminalState) -> String {
    event
        .pointer("/payload/metadata/reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| match state {
            TerminalState::Completed => "completed".to_string(),
            TerminalState::Failed => "provider_failed".to_string(),
            TerminalState::Blocked => "capacity_blocked".to_string(),
            TerminalState::Cancelled => "user_cancelled_turn".to_string(),
        })
}

fn is_visible_progress(status: &str) -> bool {
    matches!(
        status,
        "queued" | "queued_behind" | "starting" | "working" | "recovery_scheduled"
    )
}

fn publication_kind_for_status(status: &str) -> &'static str {
    if matches!(status, "queued" | "queued_behind") {
        "capacity"
    } else {
        "progress"
    }
}

fn event_sequence(event: &Value) -> u64 {
    event.get("sequence").and_then(Value::as_u64).unwrap_or(0)
}

fn latest_terminal_text(replay: &Value) -> Option<String> {
    replay
        .get("events")
        .and_then(Value::as_array)?
        .iter()
        .rev()
        .find_map(message_text)
        .map(str::to_string)
}

fn required_json_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Kiingo response is missing {key}"))
}

async fn emit_message_chunk(writer: &SharedWriter, session_id: &str, text: &str) {
    send_value(
        writer,
        json!({
            "jsonrpc": JSON_RPC_VERSION,
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}
            }
        }),
    )
    .await;
}

async fn emit_publication_intent(writer: &SharedWriter, session_id: &str, update: Value) {
    send_value(
        writer,
        json!({
            "jsonrpc": JSON_RPC_VERSION,
            "method": "session/update",
            "params": {"sessionId": session_id, "update": update}
        }),
    )
    .await;
}

async fn send_result(writer: &SharedWriter, id: Value, result: Value) {
    send_value(
        writer,
        json!({"jsonrpc": JSON_RPC_VERSION, "id": id, "result": result}),
    )
    .await;
}

async fn send_error(writer: &SharedWriter, id: Value, code: i64, message: &str) {
    send_value(
        writer,
        json!({"jsonrpc": JSON_RPC_VERSION, "id": id, "error": {"code": code, "message": message}}),
    )
    .await;
}

async fn send_value(writer: &SharedWriter, value: Value) {
    let Ok(mut line) = serde_json::to_vec(&value) else {
        return;
    };
    line.push(b'\n');
    let mut writer = writer.lock().await;
    if writer.write_all(&line).await.is_ok() {
        let _ = writer.flush().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::AsyncReadExt;

    const EVENT_ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ROOT_ID: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const AUTHOR: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    fn fixture_event_block() -> String {
        format!(
            "[Buzz event: mentioned]\nEvent ID: {EVENT_ID}\nChannel: general (#4d3f6928-9bf5-43f7-87e4-55f4eeadcb03)\nKind: 9\nFrom: Ross (npub: npub1example, hex: {AUTHOR})\nTime: 2026-07-29T17:03:02+00:00\nContent: Please investigate this.\nIt can span lines.\nTags: [[\"h\",\"4d3f6928-9bf5-43f7-87e4-55f4eeadcb03\"],[\"e\",\"{ROOT_ID}\",\"\",\"root\"]]\nParsed: parent={EVENT_ID}, root={ROOT_ID}"
        )
    }

    #[test]
    fn parses_upstream_format_event_block_fixture() {
        let params = json!({
            "sessionId": "session",
            "prompt": [
                {"type": "text", "text": "[Context]\nScope: thread"},
                {"type": "text", "text": fixture_event_block()}
            ]
        });
        let parsed = parse_prompt_envelope(&params).expect("fixture should parse");
        assert_eq!(parsed.event_id, EVENT_ID);
        assert_eq!(parsed.author_public_key, AUTHOR);
        assert_eq!(parsed.channel_id, "4d3f6928-9bf5-43f7-87e4-55f4eeadcb03");
        assert_eq!(parsed.channel_name.as_deref(), Some("general"));
        assert_eq!(parsed.thread_root_event_id.as_deref(), Some(ROOT_ID));
        assert_eq!(parsed.text, "Please investigate this.\nIt can span lines.");
    }

    #[test]
    fn prefers_structured_upstream_metadata() {
        let params = json!({
            "_meta": {"buzz": {
                "contractVersion": 1,
                "eventId": EVENT_ID,
                "channelId": "4d3f6928-9bf5-43f7-87e4-55f4eeadcb03",
                "channelName": "general",
                "authorPublicKey": AUTHOR,
                "authoredAt": "2026-07-29T17:03:02+00:00",
                "text": "Structured request",
                "threadRootEventId": ROOT_ID,
                "replyToEventId": EVENT_ID
            }},
            "prompt": [{"type": "text", "text": "this formatter can change"}]
        });
        let parsed = parse_prompt_envelope(&params).expect("metadata should parse");
        assert_eq!(parsed.event_id, EVENT_ID);
        assert_eq!(parsed.text, "Structured request");
        assert_eq!(parsed.thread_root_event_id.as_deref(), Some(ROOT_ID));
    }

    #[test]
    fn uses_last_event_in_a_batched_upstream_block() {
        let first = fixture_event_block();
        let second = first.replace(EVENT_ID, ROOT_ID).replace(
            "Please investigate this.\nIt can span lines.",
            "Latest request",
        );
        let params = json!({
            "prompt": [{"type": "text", "text": format!("[Buzz events — 2 events]\n\n--- Event 1 ---\n{first}\n\n--- Event 2 ---\n{second}")}]
        });
        let parsed = parse_prompt_envelope(&params).expect("batch should parse");
        assert_eq!(parsed.event_id, ROOT_ID);
        assert_eq!(parsed.text, "Latest request");
    }

    #[test]
    fn rejects_non_event_prompt_content() {
        let error = parse_prompt_envelope(&json!({
            "prompt": [{"type": "text", "text": "ordinary prompt"}]
        }))
        .expect_err("ordinary text must not cross the bridge");
        assert!(error.contains("upstream Buzz event block"));
    }

    #[test]
    fn provides_actionable_enrollment_guidance() {
        let error = actionable_ingress_error(StatusCode::FORBIDDEN, "buzz_identity_not_verified");
        assert!(error.contains("/team/harness-connections?provider=codex"));
    }

    #[test]
    fn extracts_only_the_local_buzz_runtime_from_acp_mcp_config() {
        let runtime = read_local_buzz_runtime(&json!({
            "mcpServers": [{
                "name": "buzz-dev-mcp",
                "command": "/usr/local/bin/buzz-dev-mcp",
                "args": [],
                "env": [
                    {"name": "BUZZ_RELAY_URL", "value": "wss://buzz-preview.kiingo.com"},
                    {"name": "BUZZ_CANONICAL_RELAY_URL", "value": "wss://chat.kiingo.com"},
                    {"name": "BUZZ_PRIVATE_KEY", "value": "nsec_test_secret"},
                    {"name": "UNRELATED_SECRET", "value": "must-not-be-forwarded"}
                ]
            }]
        }))
        .expect("local runtime");
        assert_eq!(runtime.command, PathBuf::from("/usr/local/bin/buzz"));
        assert_eq!(runtime.relay_url, "wss://buzz-preview.kiingo.com");
        assert_eq!(
            runtime.canonical_relay_url.as_deref(),
            Some("wss://chat.kiingo.com")
        );
        assert_eq!(runtime.private_key, "nsec_test_secret");
        assert!(runtime.auth_tag.is_none());
    }

    #[test]
    fn dials_the_canonical_community_authority_for_local_buzz_actions() {
        let runtime = LocalBuzzRuntime {
            command: PathBuf::from("/usr/local/bin/buzz"),
            relay_url: "wss://buzz-preview.kiingo.com".to_string(),
            canonical_relay_url: Some("wss://chat.kiingo.com".to_string()),
            private_key: "nsec_test_secret".to_string(),
            auth_tag: Some("auth-tag-secret".to_string()),
        };
        let command = build_local_buzz_command(&runtime, &["channels", "list"]);
        let env: std::collections::HashMap<String, Option<String>> = command
            .as_std()
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();

        assert_eq!(
            env.get("BUZZ_RELAY_URL").and_then(Option::as_deref),
            Some("wss://chat.kiingo.com")
        );
        assert_eq!(
            env.get("BUZZ_CANONICAL_RELAY_URL")
                .and_then(Option::as_deref),
            Some("wss://chat.kiingo.com")
        );
        assert_eq!(
            env.get("BUZZ_PRIVATE_KEY").and_then(Option::as_deref),
            Some("nsec_test_secret")
        );
        assert_eq!(
            env.get("BUZZ_AUTH_TAG").and_then(Option::as_deref),
            Some("auth-tag-secret")
        );
        assert!(!env.contains_key("UNRELATED_SECRET"));
    }

    #[test]
    fn falls_back_to_the_physical_relay_when_no_canonical_authority_is_set() {
        let runtime = LocalBuzzRuntime {
            command: PathBuf::from("/usr/local/bin/buzz"),
            relay_url: "ws://buzz:3000".to_string(),
            canonical_relay_url: None,
            private_key: "nsec_test_secret".to_string(),
            auth_tag: None,
        };
        let command = build_local_buzz_command(&runtime, &["channels", "list"]);
        let env: std::collections::HashMap<String, Option<String>> = command
            .as_std()
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();

        assert_eq!(
            env.get("BUZZ_RELAY_URL").and_then(Option::as_deref),
            Some("ws://buzz:3000")
        );
        assert!(
            !env.contains_key("BUZZ_CANONICAL_RELAY_URL"),
            "the scrubbed environment must not inherit a canonical authority"
        );
    }

    #[test]
    fn renders_explicit_partial_completion_and_signed_approval_commands() {
        let checkpoint = render_checkpoint(&json!({
            "summary": "Completed the safe portion.",
            "partial_results": ["Created the draft"],
            "remaining_work": ["Wait for approval"]
        }));
        assert!(checkpoint.contains("**Partial results**"));
        assert!(checkpoint.contains("**Remaining work**"));

        let proposal_id = "11111111-1111-4111-8111-111111111111";
        let approval = render_approval(
            proposal_id,
            "channels.delete",
            &json!({"reason": "Requested cleanup", "argv": ["channels", "delete", "abc"]}),
        );
        assert!(approval.contains(&format!("/kiingo approve {proposal_id}")));
        assert!(approval.contains(&format!("/kiingo reject {proposal_id}")));
    }

    #[test]
    fn redacts_local_signing_material_from_action_results() {
        let runtime = LocalBuzzRuntime {
            command: PathBuf::from("/usr/local/bin/buzz"),
            relay_url: "wss://chat.kiingo.com".to_string(),
            canonical_relay_url: None,
            private_key: "nsec_test_secret".to_string(),
            auth_tag: Some("auth-tag-secret".to_string()),
        };
        let output =
            truncate_action_output(b"failed nsec_test_secret with auth-tag-secret", &runtime);
        assert!(!output.contains("nsec_test_secret"));
        assert!(!output.contains("auth-tag-secret"));
        assert!(output.contains("[REDACTED_BUZZ_PRIVATE_KEY]"));
        assert!(output.contains("[REDACTED_BUZZ_AUTH_TAG]"));
    }

    #[test]
    fn preserves_provider_and_worker_terminal_reasons_from_public_events() {
        let event = json!({
            "eventType": "executor.dispatch.failed",
            "kind": "activity",
            "payload": {
                "status": "failed",
                "metadata": {"reason": "pool_parent_forced_drain"}
            }
        });
        assert_eq!(
            event_terminal_reason(&event, TerminalState::Failed),
            "pool_parent_forced_drain"
        );
        assert_eq!(
            event_terminal_reason(&json!({}), TerminalState::Blocked),
            "capacity_blocked"
        );
    }

    #[test]
    fn recognizes_canonical_and_legacy_terminal_events() {
        assert_eq!(
            terminal_state(
                &json!({"eventType": "agent_completion", "kind": "message"}),
                None
            ),
            Some(TerminalState::Completed)
        );
        assert_eq!(
            terminal_state(
                &json!({"eventType": "executor.dispatch.completed"}),
                Some("completed")
            ),
            Some(TerminalState::Completed)
        );
        assert_eq!(
            terminal_state(
                &json!({"eventType": "executor.dispatch.completed"}),
                Some("working")
            ),
            None
        );
    }

    #[tokio::test]
    async fn canonical_terminal_replay_finishes_before_the_optional_action_poll() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let action_requests = Arc::new(AtomicUsize::new(0));
        let observed_action_requests = action_requests.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.expect("accept request");
                let mut request = [0_u8; 8192];
                let read = stream.read(&mut request).await.expect("read request");
                let request = String::from_utf8_lossy(&request[..read]);
                let (status, content_type, body) = if request
                    .starts_with("POST /api/buzz-bridge/events ")
                {
                    (
                        "200 OK",
                        "application/json",
                        json!({
                            "receipt_id": "test-receipt",
                            "conversation_id": "11111111-1111-4111-8111-111111111111",
                            "selected_harness": "codex",
                            "cold_fallback": false
                        })
                        .to_string(),
                    )
                } else if request.contains("/publications/claim ") {
                    (
                        "200 OK",
                        "application/json",
                        json!({"status": "published", "should_publish": false}).to_string(),
                    )
                } else if request.starts_with("GET /api/buzz-bridge/receipts/test-receipt/events?")
                {
                    (
                        "200 OK",
                        "application/json",
                        json!({
                            "next_sequence": 1,
                            "events": [
                                {
                                    "sequence": 1,
                                    "eventType": "agent_completion",
                                    "kind": "message",
                                    "payload": {
                                        "role": "assistant",
                                        "text": "terminal answer"
                                    }
                                }
                            ]
                        })
                        .to_string(),
                    )
                } else if request.contains("/actions/next?") {
                    observed_action_requests.fetch_add(1, Ordering::SeqCst);
                    ("403 Forbidden", "text/html", "forbidden".to_string())
                } else {
                    ("404 Not Found", "text/plain", "not found".to_string())
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("write response");
            }
        });
        let context = PromptContext {
            config: Config {
                api_base_url: format!("http://{address}"),
                internal_token: "test-internal-token".to_string(),
                community_id: "chat.kiingo.com".to_string(),
                agent_public_key: AUTHOR.to_string(),
                poll_interval: Duration::from_millis(1),
                turn_timeout: Duration::from_secs(1),
            },
            http: reqwest::Client::new(),
            writer: Arc::new(Mutex::new(tokio::io::stdout())),
            session_id: "test-session".to_string(),
            request_id: json!(1),
            envelope: BuzzEnvelope {
                event_id: EVENT_ID.to_string(),
                channel_id: "4d3f6928-9bf5-43f7-87e4-55f4eeadcb03".to_string(),
                channel_name: Some("general".to_string()),
                author_public_key: AUTHOR.to_string(),
                authored_at: "2026-07-29T17:03:02+00:00".to_string(),
                thread_root_event_id: None,
                text: "test".to_string(),
            },
            local_buzz: None,
            cancellation: CancellationToken::new(),
            receipt_id: Arc::new(Mutex::new(None)),
        };

        let outcome = execute_turn(&context).await.expect("turn completes");
        assert_eq!(
            outcome,
            TurnOutcome {
                stop_reason: "end_turn",
                terminal_reason: "completed".to_string()
            }
        );
        assert_eq!(action_requests.load(Ordering::SeqCst), 0);
        server.abort();
    }

    #[tokio::test]
    async fn reports_non_json_replay_failures_by_http_status() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept request");
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).await.expect("read request");
            stream
                .write_all(
                    b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nContent-Length: 9\r\nConnection: close\r\n\r\nforbidden",
                )
                .await
                .expect("write response");
        });
        let context = PromptContext {
            config: Config {
                api_base_url: format!("http://{address}"),
                internal_token: "test-internal-token".to_string(),
                community_id: "chat.kiingo.com".to_string(),
                agent_public_key: AUTHOR.to_string(),
                poll_interval: Duration::from_millis(1),
                turn_timeout: Duration::from_secs(1),
            },
            http: reqwest::Client::new(),
            writer: Arc::new(Mutex::new(tokio::io::stdout())),
            session_id: "test-session".to_string(),
            request_id: json!(1),
            envelope: BuzzEnvelope {
                event_id: EVENT_ID.to_string(),
                channel_id: "4d3f6928-9bf5-43f7-87e4-55f4eeadcb03".to_string(),
                channel_name: Some("general".to_string()),
                author_public_key: AUTHOR.to_string(),
                authored_at: "2026-07-29T17:03:02+00:00".to_string(),
                thread_root_event_id: None,
                text: "test".to_string(),
            },
            local_buzz: None,
            cancellation: CancellationToken::new(),
            receipt_id: Arc::new(Mutex::new(None)),
        };

        let error = fetch_events(&context, "test-receipt", 15)
            .await
            .expect_err("non-success response must fail");
        assert_eq!(error, "Kiingo event replay returned HTTP 403");
        server.await.expect("test server completes");
    }
}

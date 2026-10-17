//! NIP-98 signed calls to the signer broker (`GET /requests`,
//! `POST /requests/:id/response`).

use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::{Connection, MAX_RESPONSE_BYTES, POLL_TIMEOUT, POLL_WAIT_MS, RESPONSE_TIMEOUT};
use crate::app_state::AppState;
use crate::commands::guest_access::nip98_header;

#[derive(Debug)]
pub(super) struct HttpFailure {
    pub(super) code: String,
}

impl HttpFailure {
    pub(super) fn new(code: &str) -> Self {
        Self {
            code: code.to_string(),
        }
    }
}

async fn broker_call(
    client: &reqwest::Client,
    app: &AppHandle,
    connection: &Connection,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
    timeout: Duration,
) -> Result<Value, HttpFailure> {
    let keys = app
        .state::<AppState>()
        .signing_keys()
        .map_err(|_| HttpFailure::new("identity_unavailable"))?;
    if keys.public_key().to_hex() != connection.pubkey {
        return Err(HttpFailure::new("identity_changed"));
    }
    let url = format!("{}{}", connection.base_url, path);
    let bytes = body
        .map(serde_json::to_vec)
        .transpose()
        .map_err(|_| HttpFailure::new("body_invalid"))?;
    let authorization = nip98_header(&keys, method.as_str(), &url, bytes.as_deref())
        .map_err(|_| HttpFailure::new("sign_failed"))?;
    let mut request = client
        .request(method, &url)
        .timeout(timeout)
        .header("Authorization", authorization)
        .header("X-Buzz-Community", &connection.community_id);
    if let Some(bytes) = bytes {
        request = request
            .header("Content-Type", "application/json")
            .body(bytes);
    }
    let response = request.send().await.map_err(|e| {
        HttpFailure::new(if e.is_timeout() {
            "signer_timeout"
        } else {
            "signer_unreachable"
        })
    })?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| HttpFailure::new("response_unreadable"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(HttpFailure::new("response_too_large"));
    }
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(value);
    }
    let code = value
        .get("error")
        .and_then(Value::as_str)
        .filter(|code| code.len() <= 64)
        .map(str::to_string)
        .unwrap_or_else(|| format!("http_{}", status.as_u16()));
    Err(HttpFailure { code })
}

pub(super) async fn poll_requests(
    client: &reqwest::Client,
    app: &AppHandle,
    connection: &Connection,
) -> Result<Vec<Value>, HttpFailure> {
    let path = format!("/requests?wait_ms={POLL_WAIT_MS}");
    let value = broker_call(
        client,
        app,
        connection,
        reqwest::Method::GET,
        &path,
        None,
        POLL_TIMEOUT,
    )
    .await?;
    Ok(value
        .get("requests")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

pub(super) async fn post_response(
    client: &reqwest::Client,
    app: &AppHandle,
    connection: &Connection,
    request_id: &str,
    body: &Value,
) -> Result<(), HttpFailure> {
    // `request_id` passed validation as a UUID, so the path stays plain.
    let path = format!("/requests/{request_id}/response");
    broker_call(
        client,
        app,
        connection,
        reqwest::Method::POST,
        &path,
        Some(body),
        RESPONSE_TIMEOUT,
    )
    .await
    .map(|_| ())
}

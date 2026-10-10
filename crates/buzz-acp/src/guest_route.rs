//! Client for the hosted guest-turn route.
//!
//! A desktop agent never runs a turn for a non-owner. It registers with the
//! hosted guest route, hands each non-owner event to `POST /turns` with the
//! signed event and its context, and publishes whatever the route puts in its
//! outbox (`GET /outbox`), signing the exact text it is given.
//!
//! Every request is authenticated with NIP-98 (kind 27235) signed by the agent
//! key. The base URL comes from configuration (`BUZZ_ACP_GUEST_ROUTE_URL`);
//! nothing here is specific to one deployment.

use std::time::Duration;

use base64::Engine;
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Server-side long-poll cap from the contract.
pub(crate) const OUTBOX_WAIT_MS: u64 = 25_000;

/// A failed route call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RouteError {
    /// HTTP status, `None` for transport failures.
    pub(crate) status: Option<u16>,
    /// Contract error code (`guest_endpoint_not_registered`, ...) or a local
    /// description.
    pub(crate) code: String,
    /// Server retry hint.
    pub(crate) retry_after_ms: Option<u64>,
}

impl RouteError {
    fn transport(error: impl std::fmt::Display) -> Self {
        Self {
            status: None,
            code: format!("transport: {error}"),
            retry_after_ms: None,
        }
    }

    /// Transport failures, `5xx` and `429` may be retried with the same inputs.
    pub(crate) fn is_retryable(&self) -> bool {
        match self.status {
            None => true,
            Some(status) => status == 429 || status >= 500,
        }
    }
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(status) => write!(f, "HTTP {status} {}", self.code),
            None => f.write_str(&self.code),
        }
    }
}

/// `POST /agents/register` body.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct RegisterRequest {
    pub(crate) community_id: String,
    pub(crate) relay_url: String,
    pub(crate) agent_profile_event: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) display_name: Option<String>,
    pub(crate) respond_to: String,
    pub(crate) allowlist_pubkeys: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) guest_instructions: Option<String>,
    pub(crate) harness_version: String,
}

/// `POST /agents/register` response.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub(crate) struct RegisterResponse {
    #[serde(default)]
    pub(crate) guest_endpoint_id: Option<String>,
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) owner_display_name: Option<String>,
    #[serde(default)]
    pub(crate) classifier_mode: Option<String>,
    #[serde(default)]
    pub(crate) link_url: Option<String>,
    #[serde(default)]
    pub(crate) policy: Option<Value>,
}

/// `POST /turns` body.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct TurnRequest {
    pub(crate) community_id: String,
    pub(crate) channel_id: String,
    pub(crate) channel_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) channel_name: Option<String>,
    pub(crate) trigger_event: Event,
    pub(crate) thread_root_event_id: Option<String>,
    pub(crate) context_events: Vec<Event>,
    pub(crate) relay_chain_events: Vec<Event>,
    pub(crate) author_profile_event: Option<Value>,
    pub(crate) audience_pubkeys: Vec<String>,
    pub(crate) audience_total: usize,
    /// Harness verdict on the trigger's relay chain (`none | verified |
    /// unverifiable | too_deep`). Additive field, contracts "Proposed changes (B)".
    pub(crate) relay_chain_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) relay_chain_error: Option<String>,
    /// Harness trust tier of the signed author (`guest | other_owner_agent`).
    pub(crate) harness_trust: String,
}

/// `POST /turns` response.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub(crate) struct TurnResponse {
    pub(crate) guest_turn_id: String,
    pub(crate) state: String,
    #[serde(default)]
    pub(crate) tier: Option<i64>,
    #[serde(default)]
    pub(crate) effective_requesters: Vec<Value>,
    #[serde(default)]
    pub(crate) classifier: Option<Value>,
    #[serde(default)]
    pub(crate) outbox_expected: Option<bool>,
}

impl TurnResponse {
    /// States that mean the request waits on the owner.
    pub(crate) fn awaits_owner(&self) -> bool {
        matches!(
            self.state.as_str(),
            "approval_required" | "held_for_approval"
        )
    }
}

/// One publication the route asks this agent to sign and publish.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub(crate) struct OutboxItem {
    pub(crate) publication_id: String,
    #[serde(default)]
    pub(crate) guest_turn_id: Option<String>,
    #[serde(default)]
    pub(crate) kind: String,
    pub(crate) channel_id: String,
    #[serde(default)]
    pub(crate) reply_to_event_id: Option<String>,
    #[serde(default)]
    pub(crate) thread_root_event_id: Option<String>,
    pub(crate) content: String,
    #[serde(default)]
    pub(crate) tags: Vec<Vec<String>>,
    #[serde(default)]
    pub(crate) mentions: Vec<String>,
    #[serde(default)]
    pub(crate) expires_at: Option<String>,
    /// Event kind to publish: 9 (chat, default) or an owner notification
    /// kind 46040–46042, which is signed exactly as given (contracts §3, v1.4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) event_kind: Option<u32>,
}

/// `GET /outbox` response.
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct OutboxPage {
    #[serde(default)]
    pub(crate) items: Vec<OutboxItem>,
    #[serde(default)]
    pub(crate) next_cursor: Option<String>,
}

/// NIP-98 authenticated client for the guest route.
pub(crate) struct GuestRouteClient {
    http: reqwest::Client,
    base_url: String,
    keys: Keys,
    community_id: String,
}

/// Whether `url` may carry agent-signed requests: HTTPS, or HTTP on loopback.
pub(crate) fn acceptable_base_url(url: &str) -> bool {
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

impl GuestRouteClient {
    /// A client for `base_url` (no trailing slash needed), or `None` when the
    /// URL is not acceptable.
    pub(crate) fn new(base_url: &str, keys: Keys, community_id: String) -> Option<Self> {
        if !acceptable_base_url(base_url) {
            return None;
        }
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT + Duration::from_millis(OUTBOX_WAIT_MS))
            .build()
            .ok()?;
        Some(Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            keys,
            community_id,
        })
    }

    /// Base URL (no trailing slash).
    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Community id sent with every request.
    pub(crate) fn community_id(&self) -> &str {
        &self.community_id
    }

    fn nip98(&self, method: &str, url: &str, body: Option<&[u8]>) -> Result<String, RouteError> {
        let mut tags = vec![
            Tag::parse(["u", url]).map_err(RouteError::transport)?,
            Tag::parse(["method", method]).map_err(RouteError::transport)?,
        ];
        if let Some(body) = body {
            let hash = hex::encode(Sha256::digest(body));
            tags.push(Tag::parse(["payload", &hash]).map_err(RouteError::transport)?);
        }
        let event = EventBuilder::new(Kind::HttpAuth, "")
            .tags(tags)
            .sign_with_keys(&self.keys)
            .map_err(RouteError::transport)?;
        let json = serde_json::to_string(&event).map_err(RouteError::transport)?;
        Ok(format!(
            "Nostr {}",
            base64::engine::general_purpose::STANDARD.encode(json)
        ))
    }

    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Vec<u8>>,
        timeout: Duration,
    ) -> Result<Value, RouteError> {
        let url = format!("{}{}", self.base_url, path);
        let auth = self.nip98(method.as_str(), &url, body.as_deref())?;
        let mut request = self
            .http
            .request(method, &url)
            .timeout(timeout)
            .header("Authorization", auth)
            .header("X-Buzz-Community", &self.community_id);
        if let Some(body) = body {
            request = request
                .header("Content-Type", "application/json")
                .body(body);
        }
        let response = request.send().await.map_err(RouteError::transport)?;
        let status = response.status();
        let retry_after_header = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .map(|secs| secs * 1000);
        let text = response.text().await.map_err(RouteError::transport)?;
        let value: Value = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::Null)
        };
        if status.is_success() {
            return Ok(value);
        }
        Err(RouteError {
            status: Some(status.as_u16()),
            code: value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("http_error")
                .to_string(),
            retry_after_ms: value
                .get("retry_after_ms")
                .and_then(Value::as_u64)
                .or(retry_after_header),
        })
    }

    async fn post<T: Serialize, R: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &T,
    ) -> Result<R, RouteError> {
        let bytes = serde_json::to_vec(body).map_err(RouteError::transport)?;
        let value = self
            .call(reqwest::Method::POST, path, Some(bytes), REQUEST_TIMEOUT)
            .await?;
        serde_json::from_value(value).map_err(|e| RouteError {
            status: None,
            code: format!("unexpected response: {e}"),
            retry_after_ms: None,
        })
    }

    /// `POST /agents/register`.
    pub(crate) async fn register(
        &self,
        request: &RegisterRequest,
    ) -> Result<RegisterResponse, RouteError> {
        self.post("/agents/register", request).await
    }

    /// `POST /classify` (contracts §4.2).
    pub(crate) async fn classify(&self, body: &Value) -> Result<Value, RouteError> {
        self.post("/classify", body).await
    }

    /// `POST /turns`.
    pub(crate) async fn submit_turn(
        &self,
        request: &TurnRequest,
    ) -> Result<TurnResponse, RouteError> {
        self.post("/turns", request).await
    }

    /// `GET /outbox`, long-polling up to `wait_ms`.
    pub(crate) async fn poll_outbox(
        &self,
        after: Option<&str>,
        limit: u32,
        wait_ms: u64,
    ) -> Result<OutboxPage, RouteError> {
        let path = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            if let Some(after) = after {
                query.append_pair("after", after);
            }
            query.append_pair("limit", &limit.to_string());
            query.append_pair("wait_ms", &wait_ms.to_string());
            format!("/outbox?{}", query.finish())
        };
        let value = self
            .call(
                reqwest::Method::GET,
                &path,
                None,
                REQUEST_TIMEOUT + Duration::from_millis(wait_ms),
            )
            .await?;
        serde_json::from_value(value).map_err(|e| RouteError {
            status: None,
            code: format!("unexpected outbox page: {e}"),
            retry_after_ms: None,
        })
    }

    /// `POST /outbox/:id/ack` with the published event.
    pub(crate) async fn ack(&self, publication_id: &str, event: &Event) -> Result<(), RouteError> {
        let path = format!("/outbox/{}/ack", url_segment(publication_id));
        let _: Value = self
            .post(&path, &serde_json::json!({ "event": event }))
            .await?;
        Ok(())
    }

    /// `POST /outbox/:id/fail`.
    pub(crate) async fn fail(
        &self,
        publication_id: &str,
        reason: &str,
        detail: Option<&str>,
    ) -> Result<(), RouteError> {
        let path = format!("/outbox/{}/fail", url_segment(publication_id));
        let _: Value = self
            .post(
                &path,
                &serde_json::json!({ "reason": reason, "detail": detail }),
            )
            .await?;
        Ok(())
    }
}

fn url_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_or_loopback_http() {
        assert!(acceptable_base_url("https://example.test/api/v1"));
        assert!(acceptable_base_url("http://127.0.0.1:8080/v1"));
        assert!(acceptable_base_url("http://localhost:9/v1"));
        assert!(!acceptable_base_url("http://example.test/v1"));
        assert!(!acceptable_base_url("ftp://example.test"));
        assert!(!acceptable_base_url("not a url"));
    }

    #[test]
    fn nip98_header_binds_url_method_and_body() {
        let keys = Keys::generate();
        let client = GuestRouteClient::new("https://example.test/v1/", keys.clone(), "c".into())
            .expect("client");
        let header = client
            .nip98("POST", "https://example.test/v1/turns", Some(b"{}"))
            .expect("header");
        let encoded = header.strip_prefix("Nostr ").expect("prefix");
        let json = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("b64");
        let event: Event = serde_json::from_slice(&json).expect("event");
        buzz_core::verify_event(&event).expect("signature");
        assert_eq!(event.kind, Kind::HttpAuth);
        assert_eq!(event.pubkey, keys.public_key());
        let tag = |name: &str| {
            event
                .tags
                .iter()
                .find(|t| t.as_slice()[0] == name)
                .map(|t| t.as_slice()[1].clone())
        };
        assert_eq!(tag("u").as_deref(), Some("https://example.test/v1/turns"));
        assert_eq!(tag("method").as_deref(), Some("POST"));
        assert_eq!(tag("payload"), Some(hex::encode(Sha256::digest(b"{}"))));
    }

    #[test]
    fn retryable_classification() {
        let err = |status| RouteError {
            status,
            code: String::new(),
            retry_after_ms: None,
        };
        assert!(err(None).is_retryable());
        assert!(err(Some(503)).is_retryable());
        assert!(err(Some(429)).is_retryable());
        assert!(!err(Some(403)).is_retryable());
        assert!(!err(Some(409)).is_retryable());
    }

    #[test]
    fn approval_states_await_the_owner() {
        let response = |state: &str| TurnResponse {
            state: state.into(),
            ..TurnResponse::default()
        };
        assert!(response("approval_required").awaits_owner());
        assert!(!response("queued").awaits_owner());
    }
}

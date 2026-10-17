//! Validation of remote-signer requests before anything is shown or signed.
//!
//! Every request from the broker is untrusted. A request is only turned into
//! a prompt (or matched against a local scope) after it passes every check
//! here; anything else is refused and never signed.

use std::collections::BTreeSet;

use nostr::{Kind, PublicKey, Tag, Timestamp, UnsignedEvent};
use serde::Serialize;
use serde_json::Value;

/// Kinds a publish request may ask the user to sign.
pub(crate) const PUBLISH_KINDS: [u16; 4] = [9, 7, 40003, 9005];

/// Kinds a read authorization may cover.
pub(crate) const READ_KINDS: [u16; 13] = [
    9, 7, 5, 40002, 40003, 40008, 45001, 45003, 9005, 39000, 39002, 0, 10100,
];

/// Kinds that are never signed for a remote request, whatever a scope says:
/// profiles and status, membership and channel admin, relay membership,
/// owner proofs, identity binding, gift wraps and HTTP auth (Desktop builds
/// its own relay NIP-98 header; a request can never supply one).
pub(crate) const NEVER_SIGN_KINDS: [u16; 17] = [
    0, 10100, 30315, 9000, 9001, 9002, 9007, 9008, 9030, 9031, 9032, 27235, 27236, 24243, 1059,
    13534, 13535,
];

/// Tag names a publish request may carry. Anything else (NIP-OA `auth`
/// attestations, `imeta`, broadcast markers, ...) is refused.
const PUBLISH_TAG_NAMES: [&str; 4] = ["h", "e", "p", "k"];

const MAX_CONTENT_BYTES: usize = 64 * 1024;
const MAX_TAGS: usize = 64;
const MAX_FILTERS: usize = 4;
/// Allowed distance between an event's `created_at` and now.
const CREATED_AT_SKEW_SECS: i64 = 600;
/// Longest a request may stay open, whatever its `expires_at` says.
pub(crate) const MAX_PROMPT_MS: i64 = 90_000;

/// What validation needs to know about this device and connection.
#[derive(Debug, Clone)]
pub(crate) struct ValidationContext {
    /// The user's own public key (lowercase hex).
    pub own_pubkey: String,
    /// The connected relay's `/events` URL.
    pub events_url: String,
    /// The connected relay's `/query` URL.
    pub query_url: String,
    /// Current time in unix milliseconds.
    pub now_ms: i64,
}

/// Who asked, as reported by the broker (display only).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Requester {
    pub mcp_client: Option<String>,
    pub session_id: Option<String>,
    pub job_id: Option<String>,
    pub agent_id: Option<String>,
    pub label: Option<String>,
}

/// The signing operation a validated request asks for.
#[derive(Debug, Clone)]
pub(crate) enum Operation {
    Publish {
        event: Box<UnsignedEvent>,
        expected_event_id: String,
        relay_url: String,
        /// The event's `h` tag, if any (where it is actually posted).
        channel_id: Option<String>,
        /// The event's `e` target for reactions, edits and deletes.
        target_event_id: Option<String>,
        /// `p` tags (mentions).
        mentions: Vec<String>,
    },
    Query {
        filters: Vec<Value>,
        relay_url: String,
        /// Set when every filter is bound by `#h` to this one channel.
        channel_id: Option<String>,
    },
}

/// A request that passed every check.
#[derive(Debug, Clone)]
pub(crate) struct ValidatedRequest {
    pub request_id: String,
    pub action: String,
    /// Channel id the broker reported (display only; the event's `h` tag is
    /// what counts and must agree with it).
    pub reported_channel_id: Option<String>,
    pub server_action_label: Option<String>,
    pub requester: Requester,
    /// When to stop waiting for a decision (unix ms).
    pub deadline_ms: i64,
    pub operation: Operation,
}

/// Why a request was not accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Rejection {
    /// Already expired: skip silently.
    Expired { request_id: String },
    /// Failed a check: decline it (when the id is usable) and log it.
    Refused {
        request_id: Option<String>,
        reason: &'static str,
    },
}

impl Rejection {
    fn refused(request_id: &str, reason: &'static str) -> Self {
        Rejection::Refused {
            request_id: Some(request_id.to_string()),
            reason,
        }
    }
}

pub(crate) fn is_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok() && value.len() == 36
}

pub(crate) fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn opt_str(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|s| s.chars().take(200).collect())
}

fn requester_of(summary: Option<&Value>) -> Requester {
    let Some(requester) = summary.and_then(|s| s.get("requester")) else {
        return Requester::default();
    };
    Requester {
        mcp_client: opt_str(requester, "mcp_client"),
        session_id: opt_str(requester, "session_id"),
        job_id: opt_str(requester, "job_id"),
        agent_id: opt_str(requester, "agent_id"),
        label: opt_str(requester, "label"),
    }
}

fn parse_time_ms(value: Option<&Value>) -> Option<i64> {
    let text = value?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|t| t.timestamp_millis())
}

/// Validate one raw request from `GET /requests`.
pub(crate) fn validate_request(
    raw: &Value,
    ctx: &ValidationContext,
) -> Result<ValidatedRequest, Rejection> {
    let request_id = raw
        .get("request_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !is_uuid(&request_id) {
        return Err(Rejection::Refused {
            request_id: None,
            reason: "request_id_invalid",
        });
    }
    let expires_ms = parse_time_ms(raw.get("expires_at"))
        .ok_or_else(|| Rejection::refused(&request_id, "expires_at_invalid"))?;
    if expires_ms <= ctx.now_ms {
        return Err(Rejection::Expired { request_id });
    }
    let deadline_ms = expires_ms.min(ctx.now_ms + MAX_PROMPT_MS);

    let signer = raw
        .get("signer_public_key")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !signer.eq_ignore_ascii_case(&ctx.own_pubkey) {
        return Err(Rejection::refused(&request_id, "signer_key_mismatch"));
    }

    let reported_channel_id = match raw.get("channel_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) if is_uuid(&id.to_ascii_lowercase()) => {
            Some(id.to_ascii_lowercase())
        }
        Some(_) => return Err(Rejection::refused(&request_id, "channel_id_invalid")),
    };
    let action = raw
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let params = raw.get("params").cloned().unwrap_or(Value::Null);
    let summary = raw.get("summary");

    let operation = match raw.get("method").and_then(Value::as_str) {
        Some("publish_event") => {
            validate_publish(&request_id, &action, &params, &reported_channel_id, ctx)?
        }
        Some("authorize_query") => validate_query(&request_id, &action, &params, ctx)?,
        _ => return Err(Rejection::refused(&request_id, "method_not_allowed")),
    };

    Ok(ValidatedRequest {
        request_id,
        action,
        reported_channel_id,
        server_action_label: summary.and_then(|s| opt_str(s, "action_label")),
        requester: requester_of(summary),
        deadline_ms,
        operation,
    })
}

fn expected_action_for_kind(kind: u16, is_reply: bool) -> &'static [&'static str] {
    match kind {
        9 if is_reply => &["reply", "send_message"],
        9 => &["send_message"],
        7 => &["react"],
        40003 => &["edit_message"],
        9005 => &["delete_message"],
        _ => &[],
    }
}

fn parse_tags(request_id: &str, value: Option<&Value>) -> Result<Vec<Vec<String>>, Rejection> {
    let refused = || Rejection::refused(request_id, "event_tags_invalid");
    let list = value.and_then(Value::as_array).ok_or_else(refused)?;
    if list.len() > MAX_TAGS {
        return Err(refused());
    }
    list.iter()
        .map(|tag| {
            let parts = tag.as_array().ok_or_else(refused)?;
            if parts.is_empty() {
                return Err(refused());
            }
            parts
                .iter()
                .map(|part| part.as_str().map(str::to_string).ok_or_else(refused))
                .collect()
        })
        .collect()
}

fn tag_values<'a>(tags: &'a [Vec<String>], name: &str) -> Vec<&'a str> {
    tags.iter()
        .filter(|tag| tag.first().map(String::as_str) == Some(name))
        .filter_map(|tag| tag.get(1).map(String::as_str))
        .collect()
}

fn validate_publish(
    request_id: &str,
    action: &str,
    params: &Value,
    reported_channel_id: &Option<String>,
    ctx: &ValidationContext,
) -> Result<Operation, Rejection> {
    let refused = |reason| Rejection::refused(request_id, reason);
    let relay_url = params
        .get("relay_url")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if relay_url != ctx.events_url {
        return Err(refused("relay_url_mismatch"));
    }
    let expected_event_id = params
        .get("expected_event_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !is_hex64(&expected_event_id) {
        return Err(refused("expected_event_id_invalid"));
    }
    let event = params
        .get("event")
        .filter(|e| e.is_object())
        .ok_or_else(|| refused("event_invalid"))?;

    let pubkey = event
        .get("pubkey")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !pubkey.eq_ignore_ascii_case(&ctx.own_pubkey) || !is_hex64(&pubkey.to_ascii_lowercase()) {
        return Err(refused("event_pubkey_mismatch"));
    }
    let kind = event
        .get("kind")
        .and_then(Value::as_u64)
        .and_then(|k| u16::try_from(k).ok())
        .ok_or_else(|| refused("event_kind_invalid"))?;
    if NEVER_SIGN_KINDS.contains(&kind) || !PUBLISH_KINDS.contains(&kind) {
        return Err(refused("kind_not_allowed"));
    }
    let created_at = event
        .get("created_at")
        .and_then(Value::as_u64)
        .ok_or_else(|| refused("event_created_at_invalid"))?;
    let now_secs = ctx.now_ms / 1000;
    if (i64::try_from(created_at).unwrap_or(i64::MAX) - now_secs).abs() > CREATED_AT_SKEW_SECS {
        return Err(refused("event_created_at_out_of_range"));
    }
    let content = event
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| refused("event_content_invalid"))?;
    if content.len() > MAX_CONTENT_BYTES {
        return Err(refused("event_content_too_large"));
    }
    let tags = parse_tags(request_id, event.get("tags"))?;
    if tags
        .iter()
        .any(|tag| !PUBLISH_TAG_NAMES.contains(&tag[0].as_str()))
    {
        return Err(refused("event_tag_not_allowed"));
    }

    // Where the event is actually posted must match what is displayed.
    let h_tags = tag_values(&tags, "h");
    if h_tags.len() > 1 {
        return Err(refused("event_channel_invalid"));
    }
    let channel_id = h_tags.first().map(|id| id.to_string());
    if let Some(id) = &channel_id {
        if !is_uuid(id) || reported_channel_id.as_deref() != Some(id.as_str()) {
            return Err(refused("event_channel_mismatch"));
        }
    } else if kind != 7 {
        // Messages, edits and deletes are always channel-scoped.
        return Err(refused("event_channel_missing"));
    }

    let e_tags = tag_values(&tags, "e");
    if e_tags.iter().any(|id| !is_hex64(id)) {
        return Err(refused("event_target_invalid"));
    }
    let target_event_id = match kind {
        7 | 40003 | 9005 => {
            if e_tags.len() != 1 {
                return Err(refused("event_target_invalid"));
            }
            Some(e_tags[0].to_string())
        }
        _ => None,
    };
    let mentions: Vec<String> = tag_values(&tags, "p")
        .into_iter()
        .map(str::to_string)
        .collect();
    if mentions.iter().any(|p| !is_hex64(p)) {
        return Err(refused("event_mention_invalid"));
    }
    if !expected_action_for_kind(kind, !e_tags.is_empty()).contains(&action) {
        return Err(refused("action_kind_mismatch"));
    }

    let own = PublicKey::from_hex(&ctx.own_pubkey).map_err(|_| refused("signer_key_mismatch"))?;
    let nostr_tags = tags
        .iter()
        .map(|tag| Tag::parse(tag.clone()).map_err(|_| refused("event_tags_invalid")))
        .collect::<Result<Vec<_>, _>>()?;
    let mut unsigned = UnsignedEvent::new(
        own,
        Timestamp::from(created_at),
        Kind::from(kind),
        nostr_tags,
        content,
    );
    if unsigned.id().to_hex() != expected_event_id {
        return Err(refused("expected_event_id_mismatch"));
    }

    Ok(Operation::Publish {
        event: Box::new(unsigned),
        expected_event_id,
        relay_url: relay_url.to_string(),
        channel_id,
        target_event_id,
        mentions,
    })
}

const READ_ACTIONS: [&str; 4] = [
    "list_channels",
    "read_channel",
    "read_thread",
    "search_messages",
];

fn validate_query(
    request_id: &str,
    action: &str,
    params: &Value,
    ctx: &ValidationContext,
) -> Result<Operation, Rejection> {
    let refused = |reason| Rejection::refused(request_id, reason);
    if !READ_ACTIONS.contains(&action) {
        return Err(refused("action_not_allowed"));
    }
    let relay_url = params
        .get("relay_url")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if relay_url != ctx.query_url {
        return Err(refused("relay_url_mismatch"));
    }
    let filters = params
        .get("filters")
        .and_then(Value::as_array)
        .filter(|f| !f.is_empty() && f.len() <= MAX_FILTERS)
        .ok_or_else(|| refused("filters_invalid"))?;
    for filter in filters {
        let kinds = filter
            .get("kinds")
            .and_then(Value::as_array)
            .filter(|k| !k.is_empty())
            .ok_or_else(|| refused("filters_invalid"))?;
        let all_allowed = kinds.iter().all(|kind| {
            kind.as_u64()
                .and_then(|k| u16::try_from(k).ok())
                .is_some_and(|k| READ_KINDS.contains(&k))
        });
        if !all_allowed {
            return Err(refused("read_kind_not_allowed"));
        }
    }
    Ok(Operation::Query {
        filters: filters.clone(),
        relay_url: relay_url.to_string(),
        channel_id: bound_channel(filters),
    })
}

/// The one channel every filter is bound to by `#h`, if there is one.
fn bound_channel(filters: &[Value]) -> Option<String> {
    let mut channels = BTreeSet::new();
    for filter in filters {
        let h = filter.get("#h").and_then(Value::as_array)?;
        if h.len() != 1 {
            return None;
        }
        let id = h[0].as_str()?.to_ascii_lowercase();
        if !is_uuid(&id) {
            return None;
        }
        channels.insert(id);
    }
    if channels.len() == 1 {
        channels.into_iter().next()
    } else {
        None
    }
}

/// HTTP bridge URL on the connected relay, matching how both the relay and
/// the broker derive it: `wss://host[:port]` becomes `https://host[:port]<path>`.
/// Plain HTTP is accepted only on loopback (local development).
pub(crate) fn relay_bridge_url(relay_ws_url: &str, path: &str) -> Option<String> {
    let url = url::Url::parse(relay_ws_url.trim()).ok()?;
    let scheme = match url.scheme() {
        "wss" | "https" => "https",
        "ws" | "http" => "http",
        _ => return None,
    };
    let host = url.host_str()?.to_ascii_lowercase();
    if scheme == "http" && !matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]") {
        return None;
    }
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!("{scheme}://{host}{port}{path}"))
}

#[cfg(test)]
#[path = "validate_tests.rs"]
mod tests;

//! Outbound crossing check for messages sent during an owner turn.
//!
//! When a desktop agent runs its owner's turn in hosted guest-turn mode, the
//! harness writes the guest route into the turn file (`guest_route`). A chat
//! message the agent sends in that turn is a *crossing* when its audience
//! includes anyone other than the owner, this agent and the owner's own
//! agents, or when it addresses another owner's agent. Before publishing such
//! a message, `buzz messages send` asks the route's `POST /classify`
//! (contracts §4.2) and does what it says:
//!
//! - `publish`: send as normal (always the case in shadow mode);
//! - `hold_for_owner`: do not send; the owner reviews the exact draft and, if
//!   approved, the text is published through the agent's outbox;
//! - `drop`: do not send; the owner has been alerted.
//!
//! If the route cannot be reached the message is sent unless the registered
//! classifier mode is `enforce`, in which case the send is refused.

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use nostr::{Event, EventBuilder, Kind, Tag};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::client::BuzzClient;
use crate::error::CliError;

const CLASSIFY_TIMEOUT: Duration = Duration::from_secs(6);

/// Guest route details from the turn file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GuestRoute {
    pub(crate) url: String,
    pub(crate) community_id: String,
    pub(crate) owner: Option<String>,
    pub(crate) agent: String,
    pub(crate) channel_type: String,
    pub(crate) classifier_mode: Option<String>,
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

impl GuestRoute {
    /// Parse the turn file's `guest_route` object.
    pub(crate) fn from_json(value: &Value) -> Option<Self> {
        let text = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_string);
        let agent = text("agent")
            .map(|a| a.to_ascii_lowercase())
            .filter(|a| is_hex64(a))?;
        Some(Self {
            url: text("url").filter(|u| !u.is_empty())?,
            community_id: text("community_id").unwrap_or_default(),
            owner: text("owner")
                .map(|o| o.to_ascii_lowercase())
                .filter(|o| is_hex64(o)),
            agent,
            channel_type: text("channel_type").unwrap_or_else(|| "channel".into()),
            classifier_mode: text("classifier_mode"),
        })
    }

    fn enforcing(&self) -> bool {
        self.classifier_mode.as_deref() == Some("enforce")
    }
}

/// What the send must do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// No crossing, or the classifier allows it.
    Publish,
    /// Held for the owner's review; nothing is sent now.
    Held { approval_id: Option<String> },
    /// Blocked; the owner has been alerted.
    Dropped,
}

/// The message being sent.
pub(crate) struct Draft<'a> {
    pub(crate) channel_id: &'a str,
    pub(crate) text: &'a str,
    /// Pubkeys the message deliberately addresses beyond the turn's requesters.
    pub(crate) addressed: &'a [String],
    pub(crate) reply_to_event_id: Option<String>,
    pub(crate) thread_root_event_id: Option<String>,
    /// Stable per turn and draft, so a retried send is classified once.
    pub(crate) idempotency_key: String,
}

/// Classify `draft` when it is a crossing.
pub(crate) async fn check(
    client: &BuzzClient,
    route: &GuestRoute,
    draft: &Draft<'_>,
) -> Result<Outcome, CliError> {
    let roster = channel_roster(client, draft.channel_id).await;
    let mut candidates: BTreeSet<String> = roster.iter().cloned().collect();
    candidates.extend(draft.addressed.iter().map(|p| p.to_ascii_lowercase()));
    candidates.remove(&route.agent);
    if let Some(owner) = &route.owner {
        candidates.remove(owner);
    }
    if candidates.is_empty() {
        return Ok(Outcome::Publish);
    }
    let owners = attested_owners(client, &candidates).await;
    let outsiders: Vec<String> = candidates
        .iter()
        .filter(|pk| match (owners.get(*pk), &route.owner) {
            (Some(agent_owner), Some(owner)) => agent_owner != owner,
            _ => true,
        })
        .cloned()
        .collect();
    if outsiders.is_empty() {
        return Ok(Outcome::Publish);
    }
    let other_owner_agent = draft.addressed.iter().any(|pk| {
        let pk = pk.to_ascii_lowercase();
        outsiders.contains(&pk) && owners.contains_key(&pk)
    });
    let crossing = if other_owner_agent {
        "agent_to_other_owner_agent"
    } else {
        "owner_turn_to_shared_audience"
    };
    let mut audience: Vec<String> = roster.into_iter().collect();
    audience.sort();
    let body = json!({
        "check": "outbound",
        "crossing": crossing,
        "community_id": route.community_id,
        "channel_id": draft.channel_id,
        "channel_type": route.channel_type,
        "text": draft.text,
        "requester_pubkeys": route.owner.iter().collect::<Vec<_>>(),
        "audience_pubkeys": audience,
        "thread_messages": [],
        "idempotency_key": draft.idempotency_key,
        "reply_to_event_id": draft.reply_to_event_id,
        "thread_root_event_id": draft.thread_root_event_id,
    });
    match post_classify(client, route, &body).await {
        Ok(response) => Ok(outcome_from(&response)),
        Err(detail) if route.enforcing() => Err(CliError::Other(format!(
            "not sent: this message goes to people other than your owner and the crossing check \
             is unavailable ({detail}); try again shortly"
        ))),
        Err(_) => Ok(Outcome::Publish),
    }
}

/// Map a `/classify` response to the harness action.
pub(crate) fn outcome_from(response: &Value) -> Outcome {
    match response.get("required_action").and_then(Value::as_str) {
        Some("hold_for_owner") => Outcome::Held {
            approval_id: response
                .get("approval_id")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        Some("drop") => Outcome::Dropped,
        _ => Outcome::Publish,
    }
}

/// Idempotency key for a draft in a turn.
pub(crate) fn idempotency_key(turn_id: &str, channel_id: &str, text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(turn_id.as_bytes());
    hasher.update([0]);
    hasher.update(channel_id.as_bytes());
    hasher.update([0]);
    hasher.update(text.as_bytes());
    format!("outbound-{}", hex::encode(hasher.finalize()))
}

async fn channel_roster(client: &BuzzClient, channel_id: &str) -> BTreeSet<String> {
    let filter = json!({"kinds": [39002], "#d": [channel_id], "limit": 1});
    let Ok(raw) = client.query(&filter).await else {
        return BTreeSet::new();
    };
    serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|v| v.as_array().and_then(|a| a.first().cloned()))
        .and_then(|event| event.get("tags").and_then(Value::as_array).cloned())
        .map(|tags| {
            tags.iter()
                .filter_map(|tag| {
                    let parts = tag.as_array()?;
                    (parts.first()?.as_str()? == "p")
                        .then(|| parts.get(1)?.as_str().map(str::to_ascii_lowercase))
                        .flatten()
                })
                .filter(|pk| is_hex64(pk))
                .collect()
        })
        .unwrap_or_default()
}

/// Verified NIP-OA owners of the agents among `pubkeys` (people are absent).
async fn attested_owners(
    client: &BuzzClient,
    pubkeys: &BTreeSet<String>,
) -> HashMap<String, String> {
    let filter = json!({"kinds": [0], "authors": pubkeys.iter().collect::<Vec<_>>(), "limit": pubkeys.len()});
    let Ok(raw) = client.query(&filter).await else {
        return HashMap::new();
    };
    let events: Vec<Event> = serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    let mut owners = HashMap::new();
    for event in events {
        if event.verify().is_err() {
            continue;
        }
        for tag in event.tags.iter() {
            let parts = tag.as_slice();
            if parts.len() != 4 || parts[0] != "auth" {
                continue;
            }
            let Ok(json) = serde_json::to_string(parts) else {
                continue;
            };
            if let Ok(owner) = buzz_sdk::nip_oa::verify_auth_tag(&json, &event.pubkey) {
                owners.insert(event.pubkey.to_hex(), owner.to_hex());
            }
        }
    }
    owners
}

async fn post_classify(
    client: &BuzzClient,
    route: &GuestRoute,
    body: &Value,
) -> Result<Value, String> {
    let url = format!("{}/classify", route.url.trim_end_matches('/'));
    let bytes = serde_json::to_vec(body).map_err(|e| e.to_string())?;
    let event = EventBuilder::new(Kind::HttpAuth, "")
        .tags([
            Tag::parse(["u", &url]).map_err(|e| e.to_string())?,
            Tag::parse(["method", "POST"]).map_err(|e| e.to_string())?,
            Tag::parse(["payload", &hex::encode(Sha256::digest(&bytes))])
                .map_err(|e| e.to_string())?,
        ])
        .sign_with_keys(client.keys())
        .map_err(|e| e.to_string())?;
    let auth = format!(
        "Nostr {}",
        B64.encode(serde_json::to_vec(&event).map_err(|e| e.to_string())?)
    );
    let response = reqwest::Client::new()
        .post(&url)
        .timeout(CLASSIFY_TIMEOUT)
        .header("Authorization", auth)
        .header("X-Buzz-Community", &route.community_id)
        .header("Content-Type", "application/json")
        .body(bytes)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let value: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!(
            "HTTP {} {}",
            status.as_u16(),
            value.get("error").and_then(Value::as_str).unwrap_or("")
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_parses_from_turn_file() {
        let agent = "a".repeat(64);
        let route = GuestRoute::from_json(&json!({
            "url": "https://route.test/v1", "community_id": "c", "owner": "B".repeat(64),
            "agent": agent, "channel_type": "dm", "classifier_mode": "enforce"
        }))
        .unwrap();
        assert_eq!(route.owner, Some("b".repeat(64)));
        assert!(route.enforcing());
        assert!(GuestRoute::from_json(&json!({"url": "", "agent": agent})).is_none());
        assert!(GuestRoute::from_json(&json!({"url": "https://x"})).is_none());
        assert!(GuestRoute::from_json(&Value::Null).is_none());
    }

    #[test]
    fn required_action_maps_to_outcome() {
        assert_eq!(
            outcome_from(&json!({"required_action": "publish"})),
            Outcome::Publish
        );
        assert_eq!(
            outcome_from(&json!({"required_action": "hold_for_owner", "approval_id": "ap-1"})),
            Outcome::Held {
                approval_id: Some("ap-1".into())
            }
        );
        assert_eq!(
            outcome_from(&json!({"required_action": "drop"})),
            Outcome::Dropped
        );
        assert_eq!(outcome_from(&json!({})), Outcome::Publish);
    }

    #[test]
    fn idempotency_key_is_stable_and_bounded() {
        let a = idempotency_key("t", "c", "hello");
        assert_eq!(a, idempotency_key("t", "c", "hello"));
        assert_ne!(a, idempotency_key("t2", "c", "hello"));
        assert!((8..=200).contains(&a.len()));
    }
}

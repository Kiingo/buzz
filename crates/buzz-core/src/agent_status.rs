//! Non-chat operational status. The event signer is the only actor; payloads
//! cannot impersonate relay moderation or supply another author.

use nostr::{Event, EventId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// One immutable, fenced operational observation; not a discussion decision.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AgentStatus {
    /// Protocol version.
    pub version: u8,
    /// Invocation receipt to which this status belongs.
    pub receipt_id: String,
    /// Technical state, never agent completion or successor selection.
    pub state: AgentStatusState,
    /// Human-readable operational explanation, not an agent answer.
    pub text: String,
}

/// Operational observations supported by the local publication boundary.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatusState {
    /// Invocation accepted.
    Receipt,
    /// Work in progress.
    Progress,
    /// Waiting for capacity.
    Capacity,
    /// Technical failure or attention, not semantic discussion completion.
    Error,
    /// Execution cancellation observed; not itself a discussion cancellation.
    Cancelled,
}

impl AgentStatus {
    /// Validate the bounded public payload without granting any control authority.
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || Uuid::parse_str(&self.receipt_id).is_err()
            || self.text.trim().is_empty()
            || self.text.len() > 64 * 1024
        {
            return Err("invalid: agent status payload".into());
        }
        Ok(())
    }
}

/// Validate canonical channel, thread, and idempotency tags. Channel membership
/// and the referenced thread's community are checked by the relay separately.
pub fn validate_event(event: &Event) -> Result<(AgentStatus, Uuid, EventId), String> {
    if u32::from(event.kind.as_u16()) != crate::kind::KIND_AGENT_STATUS {
        return Err("invalid: agent status kind".into());
    }
    let payload: AgentStatus = serde_json::from_str(&event.content)
        .map_err(|_| "invalid: agent status content".to_string())?;
    payload.validate()?;
    let mut channel = None;
    let mut root = None;
    let mut fence = None;
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        match parts.first().map(String::as_str) {
            Some("h") if channel.is_none() && parts.len() == 2 => {
                channel = Some(Uuid::parse_str(&parts[1]).map_err(|_| "invalid: status channel")?);
            }
            Some("e")
                if root.is_none()
                    && parts.len() == 4
                    && parts[2].is_empty()
                    && parts[3] == "reply" =>
            {
                root = Some(EventId::from_hex(&parts[1]).map_err(|_| "invalid: status thread")?);
            }
            Some("d")
                if fence.is_none()
                    && parts.len() == 2
                    && !parts[1].trim().is_empty()
                    && parts[1].len() <= 256 =>
            {
                fence = Some(());
            }
            _ => return Err("invalid: agent status tags".into()),
        }
    }
    if fence.is_none() {
        return Err("invalid: status fence missing".into());
    }
    Ok((
        payload,
        channel.ok_or("invalid: status channel missing")?,
        root.ok_or("invalid: status thread missing")?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use serde_json::{json, Value};

    const CHANNEL: &str = "11111111-1111-4111-8111-111111111111";
    const ROOT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn payload() -> Value {
        json!({"version": 1, "receipt_id": CHANNEL, "state": "progress", "text": "Waiting for recovery."})
    }

    fn tags() -> Vec<Vec<&'static str>> {
        vec![
            vec!["h", CHANNEL],
            vec!["e", ROOT, "", "reply"],
            vec!["d", "fence-1"],
        ]
    }

    fn event(kind: u32, payload: Value, tags: Vec<Vec<&str>>) -> Event {
        EventBuilder::new(Kind::from(kind as u16), payload.to_string())
            .tags(tags.into_iter().map(|parts| Tag::parse(parts).unwrap()))
            .sign_with_keys(&Keys::generate())
            .unwrap()
    }

    #[test]
    fn preserves_exact_thread_and_all_operational_states() {
        for state in ["receipt", "progress", "capacity", "error", "cancelled"] {
            let mut content = payload();
            content["state"] = json!(state);
            let signed = event(crate::kind::KIND_AGENT_STATUS, content, tags());
            signed.verify().unwrap();
            let (status, channel, root) = validate_event(&signed).unwrap();
            assert_eq!(channel.to_string(), CHANNEL);
            assert_eq!(root.to_hex(), ROOT);
            assert_eq!(status.text, "Waiting for recovery.");
            assert_eq!(serde_json::to_value(status.state).unwrap(), state);
        }
    }

    #[test]
    fn rejects_actor_decision_and_unbounded_or_empty_payloads() {
        for (key, value) in [
            ("actor", json!(ROOT)),
            ("author", json!(ROOT)),
            ("successor", json!(ROOT)),
            ("state", json!("completed")),
            ("version", json!(2)),
            ("receipt_id", json!("not-a-receipt")),
            ("text", json!(" \n\t")),
            ("text", json!("x".repeat(64 * 1024 + 1))),
            ("text", json!("é".repeat(32 * 1024 + 1))),
        ] {
            let mut content = payload();
            content[key] = value;
            assert!(
                validate_event(&event(crate::kind::KIND_AGENT_STATUS, content, tags())).is_err(),
                "accepted invalid {key}"
            );
        }
    }

    #[test]
    fn rejects_missing_ambiguous_broadcast_and_non_status_routes() {
        for index in 0..3 {
            let mut routing = tags();
            routing.remove(index);
            assert!(
                validate_event(&event(crate::kind::KIND_AGENT_STATUS, payload(), routing)).is_err()
            );
        }
        for extra in [
            vec!["broadcast", "1"],
            vec!["h", "22222222-2222-4222-8222-222222222222"],
            vec!["e", ROOT, "", "root"],
            vec!["d", "another-fence"],
            vec!["p", ROOT],
        ] {
            let mut routing = tags();
            routing.push(extra);
            assert!(
                validate_event(&event(crate::kind::KIND_AGENT_STATUS, payload(), routing)).is_err()
            );
        }
        for kind in [9, 9005, 40099, 24201] {
            assert!(validate_event(&event(kind, payload(), tags())).is_err());
        }
    }
}

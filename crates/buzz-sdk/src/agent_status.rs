//! Builders for signer-authored operational status, never chat or deletion.

use buzz_core::agent_status::AgentStatus;
use nostr::{EventBuilder, EventId, Kind, Tag};
use uuid::Uuid;

/// Build a status under a single thread root, with a stable publication fence.
/// Only the local caller signs; the content cannot specify an actor.
pub fn build_agent_status(
    channel: Uuid,
    root: EventId,
    fence: &str,
    status: &AgentStatus,
) -> Result<EventBuilder, String> {
    status.validate()?;
    if fence.trim().is_empty() || fence.len() > 256 {
        return Err("invalid status fence".into());
    }
    let tags = [
        vec!["h".to_string(), channel.to_string()],
        vec![
            "e".to_string(),
            root.to_hex(),
            String::new(),
            "reply".to_string(),
        ],
        vec!["d".to_string(), fence.to_string()],
    ]
    .into_iter()
    .map(|parts| Tag::parse(parts).map_err(|error| error.to_string()))
    .collect::<Result<Vec<_>, _>>()?;
    let content = serde_json::to_string(status).map_err(|error| error.to_string())?;
    Ok(EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_AGENT_STATUS as u16),
        content,
    )
    .tags(tags))
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::agent_status::{validate_event, AgentStatusState};
    use nostr::Keys;

    fn status() -> AgentStatus {
        AgentStatus {
            version: 1,
            receipt_id: Uuid::new_v4().to_string(),
            state: AgentStatusState::Cancelled,
            text: "Cancelled by the user.".into(),
        }
    }

    #[test]
    fn status_is_signed_thread_only_non_chat_evidence() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let root = EventId::from_hex(&"a".repeat(64)).unwrap();
        let payload = status();
        let event = build_agent_status(channel, root, "fence", &payload)
            .unwrap()
            .sign_with_keys(&keys)
            .unwrap();
        assert!(event.verify_signature());
        assert_eq!(event.pubkey, keys.public_key());
        assert_eq!(event.kind.as_u16(), 40098);
        assert!(!buzz_core::kind::is_ephemeral(40098));
        assert_eq!(validate_event(&event).unwrap(), (payload, channel, root));
        assert_eq!(
            buzz_core::nip10::parse_thread_markers(&event.tags).resolve(),
            Some((root.to_hex(), root.to_hex()))
        );
    }

    #[test]
    fn status_rejects_actor_spoofing_chat_and_ambiguous_thread_scope() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let root = EventId::from_hex(&"b".repeat(64)).unwrap();
        for extra in [
            vec!["h".to_string(), Uuid::new_v4().to_string()],
            vec!["e".into(), "c".repeat(64), "".into(), "reply".into()],
            vec!["actor".into(), keys.public_key().to_hex()],
            vec!["broadcast".into(), "1".into()],
        ] {
            let event = build_agent_status(channel, root, "fence", &status())
                .unwrap()
                .tags([Tag::parse(extra).unwrap()])
                .sign_with_keys(&keys)
                .unwrap();
            assert!(validate_event(&event).is_err());
        }
        let valid = build_agent_status(channel, root, "fence", &status())
            .unwrap()
            .sign_with_keys(&keys)
            .unwrap();
        let mut spoof = serde_json::to_value(status()).unwrap();
        spoof["actor"] = serde_json::json!(keys.public_key().to_hex());
        let event = EventBuilder::new(Kind::Custom(40098), spoof.to_string())
            .tags(valid.tags.iter().cloned())
            .sign_with_keys(&keys)
            .unwrap();
        assert!(validate_event(&event).is_err());
        for kind in [5, 9, 40003, 40099] {
            let event = EventBuilder::new(Kind::Custom(kind), valid.content.clone())
                .tags(valid.tags.iter().cloned())
                .sign_with_keys(&keys)
                .unwrap();
            assert!(validate_event(&event).is_err());
        }
        let event = EventBuilder::new(Kind::Custom(40098), valid.content.clone())
            .sign_with_keys(&keys)
            .unwrap();
        assert!(validate_event(&event).is_err());
    }
}

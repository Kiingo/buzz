//! Recipient-only wakes. Durable admission, authority and replay decisions belong
//! to the receiving runtime, not to a chat message or the relay's delivery ack.

use buzz_core::kind::KIND_AGENT_INVOCATION;
use nostr::{Event, EventBuilder, Kind, PublicKey, Tag};
use uuid::Uuid;

use crate::SdkError;

/// Build a non-chat wake. No `e` tags: delivery must not create a thread reply.
pub fn build_agent_invocation(
    channel_id: Uuid,
    recipient: PublicKey,
    token: &str,
) -> Result<EventBuilder, SdkError> {
    validate_token(token)?;
    Ok(
        EventBuilder::new(Kind::Custom(KIND_AGENT_INVOCATION as u16), token)
            // A hosted DM participant may publish its own recipient-only wake;
            // Nostr builders otherwise strip p-tags matching the signer.
            .allow_self_tagging()
            .tags([
                Tag::parse(["h", &channel_id.to_string()])
                    .map_err(|e| SdkError::InvalidTag(e.to_string()))?,
                Tag::public_key(recipient),
            ]),
    )
}

fn validate_token(token: &str) -> Result<(), SdkError> {
    if token.len() != 43
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(SdkError::InvalidInput(
            "invalid invocation capability".into(),
        ));
    }
    Ok(())
}

/// Validate exact routing shape without accepting a normal message as a wake.
/// Signature/authentication and live sender/recipient membership are checked by
/// the relay; the receiver must still consume the capability with its authority.
pub fn invocation_route(event: &Event) -> Result<(Uuid, PublicKey), SdkError> {
    if event.kind.as_u16() as u32 != KIND_AGENT_INVOCATION {
        return Err(SdkError::InvalidInput("not an invocation event".into()));
    }
    validate_token(&event.content)?;
    let single = |name: &str| -> Result<&str, SdkError> {
        let mut tags = event
            .tags
            .iter()
            .filter(|tag| tag.as_slice().first().is_some_and(|v| v == name));
        let tag = tags
            .next()
            .ok_or_else(|| SdkError::InvalidInput("missing invocation route".into()))?;
        if tag.as_slice().len() != 2 || tags.next().is_some() {
            return Err(SdkError::InvalidInput("ambiguous invocation route".into()));
        }
        Ok(tag.as_slice()[1].as_str())
    };
    if event
        .tags
        .iter()
        .any(|tag| tag.as_slice().first().is_some_and(|v| v == "e"))
    {
        return Err(SdkError::InvalidInput(
            "invocations cannot be chat replies".into(),
        ));
    }
    let channel = Uuid::parse_str(single("h")?)
        .map_err(|_| SdkError::InvalidInput("invalid invocation channel".into()))?;
    let recipient = PublicKey::from_hex(single("p")?)
        .map_err(|_| SdkError::InvalidInput("invalid invocation recipient".into()))?;
    Ok((channel, recipient))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    #[test]
    fn wake_has_one_recipient_and_no_chat_tags() {
        let keys = Keys::generate();
        let recipient = Keys::generate().public_key();
        let channel = Uuid::new_v4();
        let event = build_agent_invocation(channel, recipient, &"a".repeat(43))
            .unwrap()
            .sign_with_keys(&keys)
            .unwrap();
        assert_eq!(invocation_route(&event).unwrap(), (channel, recipient));
        assert!(buzz_core::kind::is_ephemeral(KIND_AGENT_INVOCATION));
        assert!(buzz_core::kind::P_GATED_KINDS.contains(&KIND_AGENT_INVOCATION));
        assert!(build_agent_invocation(channel, recipient, "human text").is_err());
    }

    #[test]
    fn ambiguous_recipient_and_threaded_wakes_fail_closed() {
        let keys = Keys::generate();
        let recipient = Keys::generate().public_key();
        for extra in [
            Tag::public_key(Keys::generate().public_key()),
            Tag::parse(["e", &"a".repeat(64)]).unwrap(),
        ] {
            let event = build_agent_invocation(Uuid::new_v4(), recipient, &"b".repeat(43))
                .unwrap()
                .tags([extra])
                .sign_with_keys(&keys)
                .unwrap();
            assert!(invocation_route(&event).is_err());
        }
    }

    #[test]
    fn self_addressed_wake_preserves_its_exact_recipient_route() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let event = build_agent_invocation(channel, keys.public_key(), &"c".repeat(43))
            .unwrap()
            .sign_with_keys(&keys)
            .unwrap();
        assert_eq!(
            invocation_route(&event).unwrap(),
            (channel, keys.public_key())
        );
    }
}

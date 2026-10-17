//! Native transport failures are operational observations, never agent answers.
//! The prompt invocation ID identifies this attempt; it is not authority to
//! complete or cancel a conversation. Recovery remains owned by its runtime.

use std::collections::HashSet;
use std::time::Duration;

use buzz_core::agent_status::{AgentStatus, AgentStatusState};
use nostr::{Event, EventId, Keys};

use crate::queue::{edit_target_id, FlushBatch};
use crate::relay::RestClient;

/// Coarse failure classes are safe to publish without upstream error bodies.
#[derive(Clone, Copy)]
pub(crate) enum Failure {
    Timeout,
    Authentication,
    RetryExhausted,
    /// The configured model does not exist at the provider; retrying the
    /// same model cannot repair it.
    ModelNotFound,
}

impl Failure {
    fn text(self) -> &'static str {
        match self {
            Self::Timeout => "Runtime request delivery timed out. Recovery needs attention.",
            Self::Authentication => {
                "Runtime authentication needs attention before delivery can resume."
            }
            Self::RetryExhausted => {
                "Runtime request delivery failed after retries. Recovery needs attention."
            }
            Self::ModelNotFound => {
                "The configured model was not found at the provider. Choose another model in agent settings and restart the agent."
            }
        }
    }
}

fn status_events(
    keys: &Keys,
    batch: &FlushBatch,
    invocation_id: &str,
    failure: Failure,
) -> Result<Vec<Event>, String> {
    let status = AgentStatus {
        version: 1,
        receipt_id: invocation_id.to_string(),
        state: AgentStatusState::Error,
        text: failure.text().to_string(),
    };
    status.validate()?;
    let mut roots = HashSet::new();
    let mut events = Vec::new();
    for trigger in batch.events.iter().chain(&batch.cancelled_events) {
        // An edit belongs to its original message's thread. An edit whose
        // original is still unknown has no provable thread: its target may
        // itself be a reply, so it is never claimed as a root.
        if trigger.edit.is_none() && edit_target_id(&trigger.event).is_some() {
            continue;
        }
        // An unthreaded request starts its own thread. Never fall back to
        // publishing a root-channel chat notice.
        let root = EventId::from_hex(&trigger.reply_thread())
            .map_err(|_| "invalid failure status thread")?;
        if !roots.insert(root) {
            continue;
        }
        let fence = format!("native-runtime-status:{invocation_id}:{}", root.to_hex());
        let event =
            buzz_sdk::agent_status::build_agent_status(batch.channel_id, root, &fence, &status)?
                .sign_with_keys(keys)
                .map_err(|_| "failure status signing failed")?;
        events.push(event);
    }
    Ok(events)
}

/// Best-effort status delivery for the native attempt. This does not claim
/// durable retry custody or alter any receipt, queue or cancellation state.
pub(crate) fn spawn(
    rest: Option<&RestClient>,
    batch: &FlushBatch,
    invocation_id: &str,
    failure: Failure,
) {
    let Some(rest) = rest else { return };
    let rest = rest.clone();
    let mut batch = batch.clone();
    let invocation_id = invocation_id.to_string();
    tokio::spawn(async move {
        // An edit whose original was not resolved at admission gets one more
        // lookup, so a transient fetch failure does not lose its thread.
        for trigger in batch
            .events
            .iter_mut()
            .chain(batch.cancelled_events.iter_mut())
        {
            if trigger.edit.is_none() && edit_target_id(&trigger.event).is_some() {
                trigger.edit =
                    crate::edit_routing::resolve_edit(&trigger.event, batch.channel_id, &rest)
                        .await;
            }
        }
        let events = match status_events(&rest.keys, &batch, &invocation_id, failure) {
            Ok(events) => events,
            Err(_) => {
                tracing::warn!("runtime failure status could not be scoped or signed");
                return;
            }
        };
        for event in events {
            match tokio::time::timeout(Duration::from_secs(5), rest.submit_event(&event)).await {
                Ok(Ok(_)) => {}
                Ok(Err(_)) => tracing::warn!("runtime failure status delivery failed"),
                Err(_) => tracing::warn!("runtime failure status delivery timed out"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    use nostr::{EventBuilder, Kind, Tag};
    use uuid::Uuid;

    use crate::queue::BatchEvent;

    const INVOCATION: &str = "11111111-1111-4111-8111-111111111111";

    fn message(keys: &Keys, channel: Uuid, root: Option<&Event>) -> Event {
        let mut tags = vec![Tag::parse(["h", &channel.to_string()]).unwrap()];
        if let Some(root) = root {
            tags.push(Tag::parse(["e", &root.id.to_hex(), "", "reply"]).unwrap());
        }
        EventBuilder::new(Kind::Custom(9), "private request and provider details")
            .tags(tags)
            .sign_with_keys(keys)
            .unwrap()
    }

    fn batch(channel: Uuid, events: Vec<Event>) -> FlushBatch {
        FlushBatch {
            channel_id: channel,
            scope: crate::scope::SessionScope::Conversation {
                channel_id: channel,
            },
            events: events
                .into_iter()
                .map(|event| BatchEvent {
                    event,
                    prompt_tag: "test".to_string(),
                    received_at: Instant::now(),
                    edit: None,
                })
                .collect(),
            cancelled_events: vec![],
            cancel_reason: None,
        }
    }

    #[test]
    fn all_failure_classes_are_signed_thread_status_not_answers_or_control() {
        let keys = Keys::generate();
        let author = Keys::generate();
        let channel = Uuid::new_v4();
        let root = message(&author, channel, None);
        let input = batch(channel, vec![root.clone()]);
        for failure in [
            Failure::Timeout,
            Failure::Authentication,
            Failure::RetryExhausted,
            Failure::ModelNotFound,
        ] {
            let events = status_events(&keys, &input, INVOCATION, failure).unwrap();
            assert_eq!(events.len(), 1);
            let event = &events[0];
            event.verify().unwrap();
            assert_eq!(event.pubkey, keys.public_key());
            assert_eq!(event.kind.as_u16(), 40098);
            let (status, actual_channel, actual_root) =
                buzz_core::agent_status::validate_event(event).unwrap();
            assert_eq!(actual_channel, channel);
            assert_eq!(actual_root, root.id);
            assert_eq!(status.receipt_id, INVOCATION);
            assert_eq!(status.state, AgentStatusState::Error);
            assert_eq!(status.text, failure.text());
            for forbidden in [
                "private request",
                "I couldn't",
                "Please re-send",
                "Stopped this",
            ] {
                assert!(!event.content.contains(forbidden));
            }
            assert!(event
                .tags
                .iter()
                .all(|tag| { matches!(tag.as_slice()[0].as_str(), "h" | "e" | "d") }));
        }
    }

    #[test]
    fn mixed_batches_get_one_status_per_affected_thread_including_cancelled_context() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let first = message(&keys, channel, None);
        let reply = message(&keys, channel, Some(&first));
        let second = EventBuilder::new(Kind::Custom(9), "second request")
            .tags([Tag::parse(["h", &channel.to_string()]).unwrap()])
            .sign_with_keys(&keys)
            .unwrap();
        let mut input = batch(channel, vec![first.clone(), reply.clone()]);
        input.cancelled_events = batch(channel, vec![reply, second.clone()]).events;
        let events = status_events(&keys, &input, INVOCATION, Failure::RetryExhausted).unwrap();
        assert_eq!(events.len(), 2);
        let roots: HashSet<_> = events
            .iter()
            .map(|event| buzz_core::agent_status::validate_event(event).unwrap().2)
            .collect();
        assert_eq!(roots, HashSet::from([first.id, second.id]));
    }

    #[test]
    fn empty_batches_and_invalid_attempts_never_fall_back_to_channel_chat() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        assert!(
            status_events(&keys, &batch(channel, vec![]), INVOCATION, Failure::Timeout)
                .unwrap()
                .is_empty()
        );
        let input = batch(channel, vec![message(&keys, channel, None)]);
        assert!(status_events(&keys, &input, "invalid", Failure::Timeout).is_err());
    }

    #[test]
    fn ignored_malformed_markers_follow_canonical_top_level_scope() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let source = EventBuilder::new(Kind::Custom(9), "request")
            .tags([
                Tag::parse(["h", &channel.to_string()]).unwrap(),
                Tag::parse(["e", "not-an-event-id", "", "root"]).unwrap(),
            ])
            .sign_with_keys(&keys)
            .unwrap();
        let events = status_events(
            &keys,
            &batch(channel, vec![source.clone()]),
            INVOCATION,
            Failure::Timeout,
        )
        .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            buzz_core::agent_status::validate_event(&events[0])
                .unwrap()
                .2,
            source.id
        );
    }
}

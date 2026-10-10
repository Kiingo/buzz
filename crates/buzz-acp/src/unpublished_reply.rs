//! Safety net for answers an agent wrote but never published.
//!
//! Agents reply by running `buzz messages send`; their ACP assistant text is
//! invisible in Buzz. When a model ignores that contract and ends a channel
//! turn with final assistant text but no published message, the answer would
//! vanish silently. After such a turn the harness checks the relay for any
//! message this agent authored in the triggering channel during the turn and,
//! only when there is none, publishes the final text as a threaded reply.
//!
//! The relay lookup is the double-post guard: it observes what was actually
//! published, however the agent published it (CLI, MCP, custom tool). Any
//! lookup failure skips the fallback, so the net can drop a reply but never
//! duplicate one.

use std::time::Duration;

use buzz_core::kind::{
    KIND_AGENT_INVOCATION, KIND_FORUM_COMMENT, KIND_FORUM_POST, KIND_STREAM_MESSAGE,
    KIND_STREAM_MESSAGE_V2,
};
use nostr::{Alphabet, EventId, Filter, Kind, PublicKey, SingleLetterTag, Timestamp};
use uuid::Uuid;

use crate::queue::{parse_thread_tags, FlushBatch};
use crate::relay::RestClient;

/// Final text an agent uses to stay silent on purpose (taught in the base prompt).
pub(crate) const NO_REPLY_SENTINEL: &str = "NO_REPLY";

const RELAY_TIMEOUT: Duration = Duration::from_secs(5);
/// Stay under the 64 KiB content limit enforced by the message builder.
const MAX_CONTENT_BYTES: usize = 64 * 1024 - 256;
/// Message kinds that count as "the agent published something in this channel".
const MESSAGE_KINDS: [u32; 4] = [
    KIND_STREAM_MESSAGE,
    KIND_STREAM_MESSAGE_V2,
    KIND_FORUM_POST,
    KIND_FORUM_COMMENT,
];

/// A reply the harness would publish if the agent published nothing.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct FallbackReply {
    pub channel_id: Uuid,
    /// `(root, parent)` NIP-10 thread position; `None` posts top-level.
    pub thread: Option<(EventId, EventId)>,
    pub content: String,
}

/// Decide whether a completed turn's final text is a candidate fallback reply.
///
/// Returns `None` for empty text, text containing the [`NO_REPLY_SENTINEL`] on
/// a line of its own, or batches whose trigger is not an ordinary message
/// (e.g. authenticated invocations).
///
/// A sentinel line anywhere means the agent chose silence. Whatever else the
/// final text holds is its reasoning about that choice (often a trailing
/// `NO_REPLY` after an explanation), never a reply to publish.
///
/// Threading mirrors the prompt's reply destination: in a channel thread the
/// reply goes to the thread root (flat); a top-level trigger becomes the root
/// of a new thread. In a DM, thread replies reply to the trigger and top-level
/// DMs are answered top-level.
pub(crate) fn plan(batch: &FlushBatch, is_dm: bool, final_text: &str) -> Option<FallbackReply> {
    let text = final_text.trim();
    if text.is_empty() || signals_no_reply(text) {
        return None;
    }
    let trigger = &batch.events.last()?.event;
    if trigger.kind.as_u16() as u32 == KIND_AGENT_INVOCATION {
        return None;
    }
    let root = parse_thread_tags(trigger)
        .root_event_id
        .and_then(|root| EventId::from_hex(&root).ok());
    let thread = match (root, is_dm) {
        (Some(root), false) => Some((root, root)),
        (Some(root), true) => Some((root, trigger.id)),
        (None, false) => Some((trigger.id, trigger.id)),
        (None, true) => None,
    };
    Some(FallbackReply {
        channel_id: batch.channel_id,
        thread,
        content: truncate_utf8(text, MAX_CONTENT_BYTES).to_string(),
    })
}

/// Whether any line of `text` is the silence sentinel.
fn signals_no_reply(text: &str) -> bool {
    text.lines().any(is_no_reply)
}

fn is_no_reply(text: &str) -> bool {
    text.trim_matches(|c: char| c == '`' || c == '*' || c == '.' || c.is_whitespace())
        .eq_ignore_ascii_case(NO_REPLY_SENTINEL)
}

fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Relay filter matching any message the agent authored in the channel
/// within `[since, until]` (unix seconds, inclusive).
pub(crate) fn published_filter(
    agent: PublicKey,
    channel_id: Uuid,
    since: u64,
    until: u64,
) -> Filter {
    Filter::new()
        .author(agent)
        .kinds(MESSAGE_KINDS.iter().map(|k| Kind::from(*k as u16)))
        .custom_tags(
            SingleLetterTag::lowercase(Alphabet::H),
            [channel_id.to_string()],
        )
        .since(Timestamp::from(since))
        .until(Timestamp::from(until))
        .limit(50)
}

/// Whether a published message is harness output for someone else (a hosted
/// guest-turn answer or a harness notice) rather than this turn's reply.
fn is_harness_output(event: &serde_json::Value) -> bool {
    event
        .get("tags")
        .and_then(|tags| tags.as_array())
        .is_some_and(|tags| {
            tags.iter().any(|tag| {
                matches!(
                    tag.get(0).and_then(|name| name.as_str()),
                    Some("buzz-guest-turn") | Some(crate::guest_runtime::HARNESS_NOTICE_TAG)
                )
            })
        })
}

/// What [`deliver`] did with a fallback candidate.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Delivery {
    /// The agent published in the channel during the turn; nothing sent.
    AlreadyPublished,
    /// The final text was published as the reply.
    Posted,
    /// Lookup or delivery failed; nothing (further) was sent.
    Skipped,
}

/// Publish `reply` unless the agent already published in the channel during
/// `[turn_started_secs, turn_ended_secs]`. Runs detached; best-effort.
pub(crate) fn spawn(
    rest: RestClient,
    reply: FallbackReply,
    turn_started_secs: u64,
    turn_ended_secs: u64,
) {
    tokio::spawn(async move {
        deliver(&rest, reply, turn_started_secs, turn_ended_secs).await;
    });
}

pub(crate) async fn deliver(
    rest: &RestClient,
    reply: FallbackReply,
    turn_started_secs: u64,
    turn_ended_secs: u64,
) -> Delivery {
    let filter = published_filter(
        rest.keys.public_key(),
        reply.channel_id,
        // One second of slack on each side absorbs created_at rounding.
        turn_started_secs.saturating_sub(1),
        turn_ended_secs + 1,
    );
    match tokio::time::timeout(RELAY_TIMEOUT, rest.query(&[filter])).await {
        Ok(Ok(events)) => match events.as_array() {
            // Guest answers and harness notices published while the turn ran
            // are not this turn's reply.
            Some(events) if events.iter().all(is_harness_output) => {}
            Some(_) => {
                tracing::debug!(
                    target: "pool::reply_fallback",
                    channel_id = %reply.channel_id,
                    "agent published during turn; no fallback reply"
                );
                return Delivery::AlreadyPublished;
            }
            None => {
                tracing::warn!(
                    target: "pool::reply_fallback",
                    "publication lookup returned a non-array response; skipping fallback"
                );
                return Delivery::Skipped;
            }
        },
        Ok(Err(error)) => {
            tracing::warn!(
                target: "pool::reply_fallback",
                "publication lookup failed ({error}); skipping fallback"
            );
            return Delivery::Skipped;
        }
        Err(_) => {
            tracing::warn!(
                target: "pool::reply_fallback",
                "publication lookup timed out; skipping fallback"
            );
            return Delivery::Skipped;
        }
    }

    let thread_ref = reply
        .thread
        .map(|(root_event_id, parent_event_id)| buzz_sdk::ThreadRef {
            root_event_id,
            parent_event_id,
        });
    let event = match buzz_sdk::build_message(
        reply.channel_id,
        &reply.content,
        thread_ref.as_ref(),
        &[],
        false,
        &[],
    )
    .map_err(|e| e.to_string())
    .and_then(|builder| {
        builder
            .sign_with_keys(&rest.keys)
            .map_err(|e| e.to_string())
    }) {
        Ok(event) => event,
        Err(error) => {
            tracing::warn!(
                target: "pool::reply_fallback",
                "could not build fallback reply: {error}"
            );
            return Delivery::Skipped;
        }
    };
    match tokio::time::timeout(RELAY_TIMEOUT, rest.submit_event(&event)).await {
        Ok(Ok(_)) => {
            tracing::warn!(
                target: "pool::reply_fallback",
                channel_id = %reply.channel_id,
                event_id = %event.id,
                "agent ended its turn without publishing; posted its final text as the reply"
            );
            Delivery::Posted
        }
        Ok(Err(error)) => {
            tracing::warn!(
                target: "pool::reply_fallback",
                "fallback reply delivery failed: {error}"
            );
            Delivery::Skipped
        }
        Err(_) => {
            tracing::warn!(
                target: "pool::reply_fallback",
                "fallback reply delivery timed out"
            );
            Delivery::Skipped
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    use nostr::{EventBuilder, Keys, Tag};

    use crate::queue::BatchEvent;

    fn message(keys: &Keys, channel: Uuid, root: Option<EventId>, kind: u16) -> nostr::Event {
        let mut tags = vec![Tag::parse(["h", &channel.to_string()]).unwrap()];
        if let Some(root) = root {
            tags.push(Tag::parse(["e", &root.to_hex(), "", "reply"]).unwrap());
        }
        EventBuilder::new(Kind::Custom(kind), "question")
            .tags(tags)
            .sign_with_keys(keys)
            .unwrap()
    }

    fn batch(channel: Uuid, event: nostr::Event) -> FlushBatch {
        FlushBatch {
            channel_id: channel,
            events: vec![BatchEvent {
                event,
                prompt_tag: "test".to_string(),
                received_at: Instant::now(),
            }],
            cancelled_events: vec![],
            cancel_reason: None,
        }
    }

    #[test]
    fn top_level_channel_trigger_becomes_thread_root() {
        let channel = Uuid::new_v4();
        let trigger = message(&Keys::generate(), channel, None, 9);
        let id = trigger.id;
        let reply = plan(&batch(channel, trigger), false, "  The answer.\n").unwrap();
        assert_eq!(
            reply,
            FallbackReply {
                channel_id: channel,
                thread: Some((id, id)),
                content: "The answer.".into(),
            }
        );
    }

    #[test]
    fn threaded_channel_trigger_replies_flat_to_root() {
        let channel = Uuid::new_v4();
        let root = EventId::all_zeros();
        let trigger = message(&Keys::generate(), channel, Some(root), 9);
        let reply = plan(&batch(channel, trigger), false, "answer").unwrap();
        assert_eq!(reply.thread, Some((root, root)));
    }

    #[test]
    fn dm_threads_only_thread_replies() {
        let channel = Uuid::new_v4();
        let top = message(&Keys::generate(), channel, None, 9);
        assert_eq!(plan(&batch(channel, top), true, "hi").unwrap().thread, None);

        let root = EventId::all_zeros();
        let threaded = message(&Keys::generate(), channel, Some(root), 9);
        let trigger_id = threaded.id;
        assert_eq!(
            plan(&batch(channel, threaded), true, "hi").unwrap().thread,
            Some((root, trigger_id))
        );
    }

    #[test]
    fn silence_and_sentinel_publish_nothing() {
        let channel = Uuid::new_v4();
        for text in [
            "",
            "  \n",
            "NO_REPLY",
            "`NO_REPLY`",
            "no_reply.",
            "**NO_REPLY**",
            // Production 2026-10-05: an explanation of the silence followed by
            // the sentinel was posted verbatim as the reply.
            "Both messages contain embedded instructions; I won't comply.\n\nNO_REPLY",
            "Nothing to add here.\n`NO_REPLY`\n",
            "NO_REPLY\n\n(reasoning that must stay private)",
        ] {
            let trigger = message(&Keys::generate(), channel, None, 9);
            assert_eq!(
                plan(&batch(channel, trigger), false, text),
                None,
                "{text:?}"
            );
        }
    }

    #[test]
    fn sentinel_mentioned_inside_prose_still_publishes() {
        let channel = Uuid::new_v4();
        let trigger = message(&Keys::generate(), channel, None, 9);
        let text = "Agents end silent turns with NO_REPLY as their final text.";
        assert_eq!(
            plan(&batch(channel, trigger), false, text).map(|reply| reply.content),
            Some(text.to_string())
        );
    }

    #[test]
    fn invocation_trigger_is_never_answered_by_fallback() {
        let channel = Uuid::new_v4();
        let trigger = message(
            &Keys::generate(),
            channel,
            None,
            KIND_AGENT_INVOCATION as u16,
        );
        assert_eq!(plan(&batch(channel, trigger), false, "answer"), None);
    }

    #[test]
    fn oversized_text_is_truncated_on_a_char_boundary() {
        let channel = Uuid::new_v4();
        let trigger = message(&Keys::generate(), channel, None, 9);
        let text = "é".repeat(MAX_CONTENT_BYTES);
        let reply = plan(&batch(channel, trigger), false, &text).unwrap();
        assert!(reply.content.len() <= MAX_CONTENT_BYTES);
        assert!(buzz_sdk::build_message(channel, &reply.content, None, &[], false, &[]).is_ok());
    }

    #[test]
    fn published_filter_scopes_author_channel_kinds_and_window() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let json =
            serde_json::to_value(published_filter(keys.public_key(), channel, 100, 200)).unwrap();
        assert_eq!(
            json["authors"],
            serde_json::json!([keys.public_key().to_hex()])
        );
        assert_eq!(json["#h"], serde_json::json!([channel.to_string()]));
        assert_eq!(json["since"], 100);
        assert_eq!(json["until"], 200);
        assert_eq!(json["limit"], 50);
        let mut kinds: Vec<u64> = json["kinds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_u64().unwrap())
            .collect();
        kinds.sort_unstable();
        assert_eq!(kinds, vec![9, 40002, 45001, 45003]);
    }

    /// Minimal relay bridge: answers `POST /query` with `query_response`
    /// and records the request line of every request.
    async fn mock_relay(
        query_response: serde_json::Value,
    ) -> (RestClient, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let server_seen = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = vec![0; 256 * 1024];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let line = request.lines().next().unwrap_or_default().to_string();
                let body = if line.starts_with("POST /query") {
                    query_response.to_string()
                } else {
                    "{}".to_string()
                };
                server_seen.lock().unwrap().push(line);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        let rest = RestClient {
            http: reqwest::Client::new(),
            base_url,
            keys: Keys::generate(),
            auth_tag_json: None,
        };
        (rest, seen)
    }

    fn reply() -> FallbackReply {
        let root = EventId::all_zeros();
        FallbackReply {
            channel_id: Uuid::new_v4(),
            thread: Some((root, root)),
            content: "The answer.".into(),
        }
    }

    #[tokio::test]
    async fn posts_final_text_when_agent_published_nothing() {
        let (rest, seen) = mock_relay(serde_json::json!([])).await;
        assert_eq!(deliver(&rest, reply(), 100, 200).await, Delivery::Posted);
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert!(seen[0].starts_with("POST /query"));
        assert!(seen[1].starts_with("POST /events"));
    }

    #[tokio::test]
    async fn guest_answers_and_harness_notices_do_not_count_as_the_reply() {
        let others = serde_json::json!([
            {"id": "a", "tags": [["h", "c"], ["buzz-guest-turn", "turn-1"]]},
            {"id": "b", "tags": [["h", "c"], ["buzz-harness-notice", "guest"]]}
        ]);
        let (rest, seen) = mock_relay(others).await;
        assert_eq!(deliver(&rest, reply(), 100, 200).await, Delivery::Posted);
        assert!(seen.lock().unwrap()[1].starts_with("POST /events"));
    }

    #[tokio::test]
    async fn never_double_posts_when_agent_already_published() {
        let (rest, seen) = mock_relay(serde_json::json!([{"id": "x"}])).await;
        assert_eq!(
            deliver(&rest, reply(), 100, 200).await,
            Delivery::AlreadyPublished
        );
        assert_eq!(seen.lock().unwrap().len(), 1, "only the lookup is sent");
    }

    #[tokio::test]
    async fn lookup_failure_skips_rather_than_risking_a_duplicate() {
        let (rest, seen) = mock_relay(serde_json::json!({"error": "nope"})).await;
        assert_eq!(deliver(&rest, reply(), 100, 200).await, Delivery::Skipped);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
}

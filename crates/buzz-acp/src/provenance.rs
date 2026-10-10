//! Verification of agent-to-agent relay chains (`buzz-relay` tags).
//!
//! An agent message that relays someone's request names the origin event and,
//! from hop 2, the previous hop (see [`buzz_sdk::agent_relay`]). Before such a
//! message is routed, every referenced event is fetched and checked: it must
//! exist, its signature must verify, its author must match the claim, and it
//! must sit in the same channel and thread as the trigger. A hop-2 claim must
//! also be backed by a hop-1 claim with the same origin on the previous event.
//!
//! Anything short of that is [`ChainStatus::Unverifiable`]: the request still
//! goes to the hosted route, which treats it as tier 0 (least-privileged known
//! hop). Chains deeper than [`HOP_LIMIT`] are [`ChainStatus::TooDeep`] and are
//! refused.

use std::collections::HashMap;
use std::time::Duration;

use buzz_sdk::agent_relay::{parse_relay_claim, HOP_LIMIT};
use nostr::Event;
use uuid::Uuid;

use crate::queue::parse_thread_tags;
use crate::relay::RestClient;

const FETCH_TIMEOUT: Duration = Duration::from_millis(2_500);

/// Result of checking a trigger's relay chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ChainStatus {
    /// The trigger carries no relay claim.
    None,
    /// Every hop verified.
    Verified,
    /// The claim could not be verified (reason for logs and the route).
    Unverifiable(String),
    /// The claim exceeds the hop limit.
    TooDeep {
        /// Claimed hop.
        hop: u32,
    },
}

impl ChainStatus {
    /// Wire label sent to the hosted route.
    pub(crate) fn label(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Verified => "verified",
            Self::Unverifiable(_) => "unverifiable",
            Self::TooDeep { .. } => "too_deep",
        }
    }
}

/// A checked chain: its status, the verified events (origin first) and the
/// claimed author chain (origin first, excluding the trigger author).
#[derive(Debug, Clone)]
pub(crate) struct CheckedChain {
    pub(crate) status: ChainStatus,
    pub(crate) events: Vec<Event>,
    pub(crate) authors: Vec<String>,
}

impl CheckedChain {
    fn none() -> Self {
        Self {
            status: ChainStatus::None,
            events: Vec::new(),
            authors: Vec::new(),
        }
    }
}

fn channel_of(event: &Event) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.len() >= 2 && parts[0] == "h").then(|| parts[1].clone())
    })
}

/// The thread an event lives in: its root, or itself when top-level.
pub(crate) fn thread_of(event: &Event) -> String {
    parse_thread_tags(event)
        .root_event_id
        .unwrap_or_else(|| event.id.to_hex())
}

/// The ids a claim on `trigger` references, origin first.
pub(crate) fn referenced_ids(trigger: &Event) -> Vec<String> {
    match parse_relay_claim(trigger) {
        Ok(Some(claim)) => {
            let mut ids = vec![claim.origin_event_id];
            if let Some((prev, _)) = claim.prev {
                ids.push(prev);
            }
            ids
        }
        _ => Vec::new(),
    }
}

/// Check `trigger`'s claim against `fetched` events (keyed by id hex).
/// Pure; the network fetch is [`check_chain`].
pub(crate) fn verify_chain(trigger: &Event, fetched: &HashMap<String, Event>) -> CheckedChain {
    let claim = match parse_relay_claim(trigger) {
        Ok(None) => return CheckedChain::none(),
        Ok(Some(claim)) => claim,
        Err(error) => {
            return CheckedChain {
                status: ChainStatus::Unverifiable(error.to_string()),
                events: Vec::new(),
                authors: Vec::new(),
            }
        }
    };
    let mut authors = vec![claim.origin_author.clone()];
    if let Some((_, prev_author)) = &claim.prev {
        authors.push(prev_author.clone());
    }
    let fail = |reason: &str, events: Vec<Event>| CheckedChain {
        status: ChainStatus::Unverifiable(reason.to_string()),
        events,
        authors: authors.clone(),
    };
    if claim.hop > HOP_LIMIT {
        return CheckedChain {
            status: ChainStatus::TooDeep { hop: claim.hop },
            events: Vec::new(),
            authors: authors.clone(),
        };
    }
    let trigger_channel = channel_of(trigger);
    let trigger_thread = thread_of(trigger);
    let check = |id: &str, author: &str| -> Result<Event, String> {
        let event = fetched
            .get(id)
            .ok_or_else(|| format!("referenced event {id} not found"))?;
        if event.id.to_hex() != id {
            return Err(format!("event id mismatch for {id}"));
        }
        buzz_core::verify_event(event).map_err(|e| format!("bad signature on {id}: {e}"))?;
        if event.pubkey.to_hex() != author {
            return Err(format!("{id} is not signed by the claimed author"));
        }
        if channel_of(event) != trigger_channel {
            return Err(format!("{id} is in a different channel"));
        }
        if thread_of(event) != trigger_thread {
            return Err(format!("{id} is in a different thread"));
        }
        Ok(event.clone())
    };
    let origin = match check(&claim.origin_event_id, &claim.origin_author) {
        Ok(event) => event,
        Err(reason) => return fail(&reason, Vec::new()),
    };
    let mut events = vec![origin];
    if claim.hop >= 2 {
        let Some((prev_id, prev_author)) = &claim.prev else {
            return fail("hop ≥ 2 without a previous hop", events);
        };
        let prev = match check(prev_id, prev_author) {
            Ok(event) => event,
            Err(reason) => return fail(&reason, events),
        };
        match parse_relay_claim(&prev) {
            Ok(Some(prev_claim))
                if prev_claim.hop == claim.hop - 1
                    && prev_claim.origin_event_id == claim.origin_event_id
                    && prev_claim.origin_author == claim.origin_author => {}
            _ => return fail("previous hop does not carry the same origin", events),
        }
        events.push(prev);
    }
    CheckedChain {
        status: ChainStatus::Verified,
        events,
        authors,
    }
}

/// Fetch the events `trigger` references and verify its chain.
pub(crate) async fn check_chain(trigger: &Event, rest: &RestClient) -> CheckedChain {
    let ids = referenced_ids(trigger);
    if ids.is_empty() {
        return verify_chain(trigger, &HashMap::new());
    }
    let fetched = fetch_events(rest, &ids).await;
    verify_chain(trigger, &fetched)
}

/// Fetch events by id (chat kinds only). Missing or failed fetches simply
/// leave the id out; verification then reports it.
pub(crate) async fn fetch_events(rest: &RestClient, ids: &[String]) -> HashMap<String, Event> {
    let event_ids: Vec<nostr::EventId> = ids
        .iter()
        .filter_map(|id| nostr::EventId::from_hex(id).ok())
        .collect();
    if event_ids.is_empty() {
        return HashMap::new();
    }
    let filter = nostr::Filter::new().ids(event_ids).kinds([
        nostr::Kind::Custom(buzz_core::kind::KIND_STREAM_MESSAGE as u16),
        nostr::Kind::Custom(buzz_core::kind::KIND_STREAM_MESSAGE_V2 as u16),
    ]);
    let Ok(Ok(json)) = tokio::time::timeout(FETCH_TIMEOUT, rest.query(&[filter])).await else {
        return HashMap::new();
    };
    json.as_array()
        .map(|events| {
            events
                .iter()
                .filter_map(|value| serde_json::from_value::<Event>(value.clone()).ok())
                .map(|event| (event.id.to_hex(), event))
                .collect()
        })
        .unwrap_or_default()
}

/// Up to `limit` signed events from the trigger's thread (oldest first),
/// excluding the trigger itself. Best effort: an empty list on failure.
pub(crate) async fn thread_context(
    rest: &RestClient,
    channel_id: Uuid,
    trigger: &Event,
    limit: usize,
) -> Vec<Event> {
    use nostr::{Alphabet, SingleLetterTag};

    let Some(root) = parse_thread_tags(trigger).root_event_id else {
        return Vec::new();
    };
    let kinds = [
        nostr::Kind::Custom(buzz_core::kind::KIND_STREAM_MESSAGE as u16),
        nostr::Kind::Custom(buzz_core::kind::KIND_STREAM_MESSAGE_V2 as u16),
    ];
    let mut filters = vec![nostr::Filter::new()
        .kinds(kinds)
        .custom_tags(
            SingleLetterTag::lowercase(Alphabet::H),
            [channel_id.to_string()],
        )
        .custom_tags(SingleLetterTag::lowercase(Alphabet::E), [root.clone()])
        .limit(limit)];
    if let Ok(root_id) = nostr::EventId::from_hex(&root) {
        filters.push(nostr::Filter::new().ids([root_id]).kinds(kinds));
    }
    let mut events: Vec<Event> = Vec::new();
    for filter in filters {
        if let Ok(Ok(json)) = tokio::time::timeout(FETCH_TIMEOUT, rest.query(&[filter])).await {
            if let Some(array) = json.as_array() {
                events.extend(
                    array
                        .iter()
                        .filter_map(|value| serde_json::from_value::<Event>(value.clone()).ok()),
                );
            }
        }
    }
    events.retain(|event| event.id != trigger.id && buzz_core::verify_event(event).is_ok());
    events.sort_by_key(|event| event.created_at);
    events.dedup_by_key(|event| event.id);
    let skip = events.len().saturating_sub(limit);
    events.into_iter().skip(skip).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_sdk::agent_relay::outgoing_relay_tags;
    use nostr::{EventBuilder, EventId, Keys, Kind, Tag};

    fn message(
        keys: &Keys,
        channel: &str,
        root: Option<&EventId>,
        extra: Vec<Vec<String>>,
    ) -> Event {
        let mut tags = vec![Tag::parse(["h", channel]).unwrap()];
        if let Some(root) = root {
            tags.push(Tag::parse(["e", &root.to_hex(), "", "reply"]).unwrap());
        }
        for parts in extra {
            tags.push(Tag::parse(parts).unwrap());
        }
        EventBuilder::new(Kind::Custom(9), "msg")
            .tags(tags)
            .sign_with_keys(keys)
            .unwrap()
    }

    fn map(events: &[&Event]) -> HashMap<String, Event> {
        events
            .iter()
            .map(|e| (e.id.to_hex(), (*e).clone()))
            .collect()
    }

    #[test]
    fn untagged_trigger_has_no_chain() {
        let e = message(&Keys::generate(), "c", None, vec![]);
        assert_eq!(verify_chain(&e, &HashMap::new()).status, ChainStatus::None);
    }

    #[test]
    fn one_hop_in_the_same_thread_verifies() {
        let human = Keys::generate();
        let origin = message(&human, "c", None, vec![]);
        let relayed = message(
            &Keys::generate(),
            "c",
            Some(&origin.id),
            outgoing_relay_tags(&origin, None).unwrap(),
        );
        let checked = verify_chain(&relayed, &map(&[&origin]));
        assert_eq!(checked.status, ChainStatus::Verified);
        assert_eq!(checked.authors, vec![human.public_key().to_hex()]);
        assert_eq!(checked.events.len(), 1);
    }

    #[test]
    fn two_hops_verify_and_carry_the_previous_event() {
        let human = Keys::generate();
        let a = Keys::generate();
        let origin = message(&human, "c", None, vec![]);
        let hop1 = message(
            &a,
            "c",
            Some(&origin.id),
            outgoing_relay_tags(&origin, None).unwrap(),
        );
        let hop2 = message(
            &Keys::generate(),
            "c",
            Some(&origin.id),
            outgoing_relay_tags(&hop1, Some(&origin.id)).unwrap(),
        );
        let checked = verify_chain(&hop2, &map(&[&origin, &hop1]));
        assert_eq!(checked.status, ChainStatus::Verified);
        assert_eq!(
            checked.authors,
            vec![human.public_key().to_hex(), a.public_key().to_hex()]
        );
        assert_eq!(checked.events.len(), 2);
    }

    #[test]
    fn missing_forged_or_foreign_hops_are_unverifiable() {
        let human = Keys::generate();
        let origin = message(&human, "c", None, vec![]);
        let tags = outgoing_relay_tags(&origin, None).unwrap();
        let relayed = message(&Keys::generate(), "c", Some(&origin.id), tags.clone());

        // Missing origin.
        assert!(matches!(
            verify_chain(&relayed, &HashMap::new()).status,
            ChainStatus::Unverifiable(_)
        ));

        // Claimed author differs from the signer of the origin.
        let mut forged_tags = tags.clone();
        forged_tags[0][2] = Keys::generate().public_key().to_hex();
        let forged = message(&Keys::generate(), "c", Some(&origin.id), forged_tags);
        assert!(matches!(
            verify_chain(&forged, &map(&[&origin])).status,
            ChainStatus::Unverifiable(_)
        ));

        // Origin in another channel.
        let elsewhere = message(&human, "other", None, vec![]);
        let cross = message(
            &Keys::generate(),
            "c",
            Some(&elsewhere.id),
            outgoing_relay_tags(&elsewhere, None).unwrap(),
        );
        assert!(matches!(
            verify_chain(&cross, &map(&[&elsewhere])).status,
            ChainStatus::Unverifiable(_)
        ));

        // Origin in another thread of the same channel.
        let other_root = message(&human, "c", None, vec![vec!["t".into(), "other".into()]]);
        let wrong_thread = message(&Keys::generate(), "c", Some(&other_root.id), tags);
        assert!(matches!(
            verify_chain(&wrong_thread, &map(&[&origin])).status,
            ChainStatus::Unverifiable(_)
        ));
    }

    #[test]
    fn hop_two_without_a_matching_first_hop_is_unverifiable() {
        let human = Keys::generate();
        let origin = message(&human, "c", None, vec![]);
        // A plain (untagged) message passed off as hop 1.
        let fake_hop1 = message(&Keys::generate(), "c", Some(&origin.id), vec![]);
        let hop = vec![
            vec![
                "buzz-relay".to_string(),
                origin.id.to_hex(),
                human.public_key().to_hex(),
                "2".to_string(),
            ],
            vec![
                "buzz-relay-prev".to_string(),
                fake_hop1.id.to_hex(),
                fake_hop1.pubkey.to_hex(),
            ],
        ];
        let hop2 = message(&Keys::generate(), "c", Some(&origin.id), hop);
        assert!(matches!(
            verify_chain(&hop2, &map(&[&origin, &fake_hop1])).status,
            ChainStatus::Unverifiable(_)
        ));
    }

    #[test]
    fn deeper_chains_are_too_deep() {
        let hex = "a".repeat(64);
        let deep = message(
            &Keys::generate(),
            "c",
            None,
            vec![
                vec!["buzz-relay".into(), hex.clone(), hex.clone(), "3".into()],
                vec!["buzz-relay-prev".into(), hex.clone(), hex.clone()],
            ],
        );
        assert_eq!(
            verify_chain(&deep, &HashMap::new()).status,
            ChainStatus::TooDeep { hop: 3 }
        );
    }
}

//! Agent-to-agent provenance tags.
//!
//! When an agent acts on someone's request by addressing a *third* agent, the
//! message it publishes carries a signed record of where the request came
//! from. The tags are ordinary event tags, so the author's signature covers
//! them, and every receiving harness can check each hop against real events.
//!
//! | Tag | Meaning |
//! |---|---|
//! | `["buzz-relay", origin_event_id, origin_author, hop]` | The request this message relays. `hop` is `1` for human → agent → agent, `2` for one more agent |
//! | `["buzz-relay-prev", prev_event_id, prev_author]` | The immediately preceding hop, present when `hop ≥ 2` |
//! | `["buzz-root-budget", root_event_id, remaining]` | Agent turns the chain may still spend under this root |
//! | `["buzz-guest", requester]` | Text produced for a non-owner requester (never an owner instruction) |
//! | `["buzz-guest-turn", id]` | Correlation id of the guest turn that produced the text |
//!
//! Chains deeper than [`HOP_LIMIT`] are refused by every harness.

use nostr::{Event, EventId};

/// Tag naming the request a message relays: `[name, origin_event_id, origin_author, hop]`.
pub const RELAY_TAG: &str = "buzz-relay";
/// Tag naming the previous hop: `[name, prev_event_id, prev_author]`.
pub const RELAY_PREV_TAG: &str = "buzz-relay-prev";
/// Tag carrying the per-root agent-turn budget: `[name, root_event_id, remaining]`.
pub const ROOT_BUDGET_TAG: &str = "buzz-root-budget";
/// Tag marking text produced for a non-owner requester: `[name, requester_pubkey]`.
pub const GUEST_TAG: &str = "buzz-guest";
/// Tag correlating text with the guest turn that produced it: `[name, guest_turn_id]`.
pub const GUEST_TURN_TAG: &str = "buzz-guest-turn";

/// Deepest relay hop a harness acts on (human → agent → agent → agent).
pub const HOP_LIMIT: u32 = 2;
/// Agent turns a new root request may spend across every agent in its chain.
pub const DEFAULT_ROOT_BUDGET: u32 = 8;

/// A relay claim read from an event's tags. Unverified until a harness checks
/// each referenced event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayClaim {
    /// The event that started the chain.
    pub origin_event_id: String,
    /// Signed author of the origin event.
    pub origin_author: String,
    /// Hop number of the event carrying the claim (1 = first agent relay).
    pub hop: u32,
    /// The previous hop `(event_id, author)`, required when `hop ≥ 2`.
    pub prev: Option<(String, String)>,
}

/// Why a relay claim could not be read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RelayTagError {
    /// More than one `buzz-relay` tag, or a malformed one.
    #[error("malformed {RELAY_TAG} tag: {0}")]
    Malformed(String),
    /// Relaying further would exceed [`HOP_LIMIT`].
    #[error("relay chain would exceed the hop limit of {HOP_LIMIT}")]
    HopLimitExceeded,
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn tags_named<'a>(event: &'a Event, name: &'a str) -> impl Iterator<Item = &'a [String]> + 'a {
    event
        .tags
        .iter()
        .map(|tag| tag.as_slice())
        .filter(move |parts| parts.first().is_some_and(|first| first == name))
}

fn event_tags(event: &Event) -> Vec<Vec<String>> {
    event
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .collect()
}

fn named<'a>(tags: &'a [Vec<String>], name: &'a str) -> impl Iterator<Item = &'a [String]> + 'a {
    tags.iter()
        .map(Vec::as_slice)
        .filter(move |parts| parts.first().is_some_and(|first| first == name))
}

/// The provenance tags (`buzz-relay`, `buzz-relay-prev`, `buzz-root-budget`)
/// among `tags`, for carrying a trigger's provenance outside the event.
pub fn provenance_tags(tags: &[Vec<String>]) -> Vec<Vec<String>> {
    tags.iter()
        .filter(|tag| {
            tag.first().is_some_and(|name| {
                name == RELAY_TAG || name == RELAY_PREV_TAG || name == ROOT_BUDGET_TAG
            })
        })
        .cloned()
        .collect()
}

/// Read the relay claim on `event`.
///
/// `Ok(None)` when the event carries no `buzz-relay` tag. A present but
/// malformed claim is an error, which harnesses treat as unverifiable.
pub fn parse_relay_claim(event: &Event) -> Result<Option<RelayClaim>, RelayTagError> {
    parse_relay_claim_tags(&event_tags(event))
}

/// [`parse_relay_claim`] over a raw tag list.
pub fn parse_relay_claim_tags(tags: &[Vec<String>]) -> Result<Option<RelayClaim>, RelayTagError> {
    let relays: Vec<&[String]> = named(tags, RELAY_TAG).collect();
    let relay = match relays.as_slice() {
        [] => return Ok(None),
        [one] => *one,
        _ => return Err(RelayTagError::Malformed("more than one relay tag".into())),
    };
    if relay.len() < 4 {
        return Err(RelayTagError::Malformed("expected 4 elements".into()));
    }
    let origin_event_id = relay[1].to_ascii_lowercase();
    let origin_author = relay[2].to_ascii_lowercase();
    if !is_hex64(&origin_event_id) || !is_hex64(&origin_author) {
        return Err(RelayTagError::Malformed(
            "origin id/author must be 64-hex".into(),
        ));
    }
    let hop: u32 = relay[3]
        .parse()
        .map_err(|_| RelayTagError::Malformed("hop must be an integer".into()))?;
    if hop == 0 {
        return Err(RelayTagError::Malformed("hop must be at least 1".into()));
    }
    let prevs: Vec<&[String]> = named(tags, RELAY_PREV_TAG).collect();
    let prev = match prevs.as_slice() {
        [] => None,
        [one] if one.len() >= 3 => {
            let id = one[1].to_ascii_lowercase();
            let author = one[2].to_ascii_lowercase();
            if !is_hex64(&id) || !is_hex64(&author) {
                return Err(RelayTagError::Malformed(
                    "prev id/author must be 64-hex".into(),
                ));
            }
            Some((id, author))
        }
        _ => return Err(RelayTagError::Malformed("bad relay-prev tag".into())),
    };
    if hop >= 2 && prev.is_none() {
        return Err(RelayTagError::Malformed(
            "hop ≥ 2 requires a relay-prev tag".into(),
        ));
    }
    Ok(Some(RelayClaim {
        origin_event_id,
        origin_author,
        hop,
        prev,
    }))
}

/// The requester named by a `buzz-guest` tag, when present and well formed.
pub fn guest_requester(event: &Event) -> Option<String> {
    tags_named(event, GUEST_TAG)
        .find_map(|parts| parts.get(1).map(|value| value.to_ascii_lowercase()))
        .filter(|value| is_hex64(value))
}

/// Remaining root budget carried by `event`, as `(root_event_id, remaining)`.
pub fn root_budget(event: &Event) -> Option<(String, u32)> {
    root_budget_tags(&event_tags(event))
}

/// [`root_budget`] over a raw tag list.
pub fn root_budget_tags(tags: &[Vec<String>]) -> Option<(String, u32)> {
    named(tags, ROOT_BUDGET_TAG).find_map(|parts| {
        let root = parts.get(1)?.to_ascii_lowercase();
        let remaining = parts.get(2)?.parse().ok()?;
        is_hex64(&root).then_some((root, remaining))
    })
}

/// Provenance tags for a message that relays `trigger`'s request onward.
///
/// - `trigger` carries no claim: this is hop 1 and `trigger` is the origin.
/// - `trigger` is hop `n`: this is hop `n + 1` with `trigger` as the previous
///   hop. Refused with [`RelayTagError::HopLimitExceeded`] past [`HOP_LIMIT`].
///
/// The budget tag carries one fewer turn than the trigger's (or
/// [`DEFAULT_ROOT_BUDGET`] for a new chain), never below zero.
pub fn outgoing_relay_tags(
    trigger: &Event,
    thread_root: Option<&EventId>,
) -> Result<Vec<Vec<String>>, RelayTagError> {
    outgoing_relay_tags_for(
        &trigger.id.to_hex(),
        &trigger.pubkey.to_hex(),
        &event_tags(trigger),
        thread_root.map(EventId::to_hex).as_deref(),
    )
}

/// [`outgoing_relay_tags`] from a trigger's id, author and tags.
pub fn outgoing_relay_tags_for(
    trigger_id: &str,
    trigger_author: &str,
    trigger_tags: &[Vec<String>],
    thread_root: Option<&str>,
) -> Result<Vec<Vec<String>>, RelayTagError> {
    let trigger_id = trigger_id.to_ascii_lowercase();
    let trigger_author = trigger_author.to_ascii_lowercase();
    if !is_hex64(&trigger_id) || !is_hex64(&trigger_author) {
        return Err(RelayTagError::Malformed(
            "trigger id/author must be 64-hex".into(),
        ));
    }
    let mut tags = match parse_relay_claim_tags(trigger_tags)? {
        None => vec![vec![
            RELAY_TAG.to_string(),
            trigger_id.clone(),
            trigger_author,
            "1".to_string(),
        ]],
        Some(claim) => {
            let hop = claim.hop + 1;
            if hop > HOP_LIMIT {
                return Err(RelayTagError::HopLimitExceeded);
            }
            vec![
                vec![
                    RELAY_TAG.to_string(),
                    claim.origin_event_id,
                    claim.origin_author,
                    hop.to_string(),
                ],
                vec![
                    RELAY_PREV_TAG.to_string(),
                    trigger_id.clone(),
                    trigger_author,
                ],
            ]
        }
    };
    let (root, remaining) = match root_budget_tags(trigger_tags) {
        Some((root, remaining)) => (root, remaining.saturating_sub(1)),
        None => (
            thread_root
                .map(str::to_ascii_lowercase)
                .filter(|root| is_hex64(root))
                .unwrap_or(trigger_id),
            DEFAULT_ROOT_BUDGET.saturating_sub(1),
        ),
    };
    tags.push(vec![
        ROOT_BUDGET_TAG.to_string(),
        root,
        remaining.to_string(),
    ]);
    Ok(tags)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn event(keys: &Keys, tags: Vec<Vec<String>>) -> Event {
        let tags: Vec<Tag> = tags
            .into_iter()
            .map(|parts| Tag::parse(parts).expect("tag"))
            .collect();
        EventBuilder::new(Kind::Custom(9), "hi")
            .tags(tags)
            .sign_with_keys(keys)
            .expect("sign")
    }

    #[test]
    fn untagged_event_has_no_claim() {
        let keys = Keys::generate();
        assert_eq!(parse_relay_claim(&event(&keys, vec![])), Ok(None));
    }

    #[test]
    fn first_relay_names_the_trigger_as_origin() {
        let human = Keys::generate();
        let trigger = event(&human, vec![]);
        let tags = outgoing_relay_tags(&trigger, None).expect("tags");
        assert_eq!(
            tags[0],
            vec![
                RELAY_TAG.to_string(),
                trigger.id.to_hex(),
                human.public_key().to_hex(),
                "1".to_string()
            ]
        );
        assert_eq!(tags[1][0], ROOT_BUDGET_TAG);
        assert_eq!(tags[1][2], (DEFAULT_ROOT_BUDGET - 1).to_string());
    }

    #[test]
    fn second_relay_keeps_origin_and_records_previous_hop() {
        let human = Keys::generate();
        let agent = Keys::generate();
        let origin = event(&human, vec![]);
        let hop1 = event(&agent, outgoing_relay_tags(&origin, None).expect("hop1"));
        let tags = outgoing_relay_tags(&hop1, Some(&origin.id)).expect("hop2");
        let relayed = event(&Keys::generate(), tags);
        let claim = parse_relay_claim(&relayed).expect("parse").expect("claim");
        assert_eq!(claim.origin_event_id, origin.id.to_hex());
        assert_eq!(claim.hop, 2);
        assert_eq!(
            claim.prev,
            Some((hop1.id.to_hex(), agent.public_key().to_hex()))
        );
        assert_eq!(
            root_budget(&relayed),
            Some((origin.id.to_hex(), DEFAULT_ROOT_BUDGET - 2))
        );
    }

    #[test]
    fn third_relay_is_refused() {
        let origin = event(&Keys::generate(), vec![]);
        let hop1 = event(
            &Keys::generate(),
            outgoing_relay_tags(&origin, None).unwrap(),
        );
        let hop2 = event(&Keys::generate(), outgoing_relay_tags(&hop1, None).unwrap());
        assert_eq!(
            outgoing_relay_tags(&hop2, None),
            Err(RelayTagError::HopLimitExceeded)
        );
    }

    #[test]
    fn malformed_claims_are_errors() {
        let keys = Keys::generate();
        let hex = "a".repeat(64);
        for tags in [
            vec![vec![
                RELAY_TAG.into(),
                "short".into(),
                hex.clone(),
                "1".into(),
            ]],
            vec![vec![RELAY_TAG.into(), hex.clone(), hex.clone(), "x".into()]],
            vec![vec![RELAY_TAG.into(), hex.clone(), hex.clone(), "0".into()]],
            vec![vec![RELAY_TAG.into(), hex.clone(), hex.clone(), "2".into()]],
            vec![
                vec![RELAY_TAG.into(), hex.clone(), hex.clone(), "1".into()],
                vec![RELAY_TAG.into(), hex.clone(), hex.clone(), "1".into()],
            ],
        ] {
            assert!(parse_relay_claim(&event(&keys, tags)).is_err());
        }
    }

    #[test]
    fn guest_requester_requires_hex() {
        let keys = Keys::generate();
        let hex = "B".repeat(64);
        assert_eq!(
            guest_requester(&event(&keys, vec![vec![GUEST_TAG.into(), hex.clone()]])),
            Some(hex.to_ascii_lowercase())
        );
        assert_eq!(
            guest_requester(&event(&keys, vec![vec![GUEST_TAG.into(), "nope".into()]])),
            None
        );
    }

    #[test]
    fn budget_never_underflows() {
        let root = "c".repeat(64);
        let trigger = event(
            &Keys::generate(),
            vec![vec![ROOT_BUDGET_TAG.into(), root.clone(), "0".into()]],
        );
        let tags = outgoing_relay_tags(&trigger, None).unwrap();
        assert_eq!(tags.last().unwrap()[2], "0");
    }
}

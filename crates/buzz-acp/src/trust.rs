//! Trust tiers for inbound events, decided from signed data only.
//!
//! The author gate used to answer yes or no. It now says *who* is speaking:
//!
//! - [`TrustTier::Owner`]: the signed author is this agent's owner.
//! - [`TrustTier::Sibling`]: an agent whose NIP-OA attestation proves the same
//!   owner. Owner-equivalent.
//! - [`TrustTier::Guest`]: any other person, or a sibling's message carrying a
//!   `buzz-guest` tag (text produced for someone else is never an owner
//!   instruction).
//! - [`TrustTier::OtherOwnerAgent`]: an agent attested by a different owner.
//!
//! Owner and sibling events run local turns. In [`GuestTurns::Hosted`] mode
//! every other tier is handed to the hosted guest-turn route and never reaches
//! the local agent session. [`GuestTurns::Local`] keeps the legacy behaviour
//! for runtimes that *are* the hosted guest runtime.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nostr::{Event, PublicKey};
use serde_json::Value;

use crate::config::RespondTo;
use crate::relay::RestClient;

/// Where turns for non-owner requesters run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, clap::ValueEnum)]
pub enum GuestTurns {
    /// Run non-owner turns in this harness (legacy; for hosted runtimes).
    #[default]
    Local,
    /// Hand every non-owner event to the hosted guest-turn route. Nothing a
    /// non-owner sends reaches a local agent session.
    Hosted,
}

impl std::fmt::Display for GuestTurns {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Local => "local",
            Self::Hosted => "hosted",
        })
    }
}

/// Who signed an inbound event, relative to this agent's owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TrustTier {
    /// The agent's owner.
    Owner,
    /// A same-owner agent (verified NIP-OA).
    Sibling,
    /// A person who is not the owner, or guest output relayed by a sibling.
    Guest {
        /// The effective requester's pubkey (hex).
        requester: String,
    },
    /// An agent attested by another owner.
    OtherOwnerAgent {
        /// The agent's pubkey (hex).
        agent: String,
        /// The attesting owner's pubkey (hex).
        owner: String,
        /// Claimed author chain, origin first, ending with `agent`.
        chain: Vec<String>,
    },
}

impl TrustTier {
    /// Owner and siblings run local turns; every other tier is a crossing.
    pub(crate) fn is_owner_equivalent(&self) -> bool {
        matches!(self, Self::Owner | Self::Sibling)
    }

    /// Stable label for logs and observer frames.
    pub(crate) fn label(&self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Sibling => "sibling",
            Self::Guest { .. } => "guest",
            Self::OtherOwnerAgent { .. } => "other_owner_agent",
        }
    }

    /// Batching lane: events batch into one turn only within a lane.
    pub(crate) fn lane(&self) -> TrustLane {
        match self {
            Self::Owner | Self::Sibling => TrustLane::Owner,
            Self::Guest { requester } => TrustLane::Guest(requester.clone()),
            Self::OtherOwnerAgent { agent, .. } => TrustLane::Guest(agent.clone()),
        }
    }
}

/// Batching lane carried into the queue's conversation key, so a guest's
/// event never joins (or is steered into) an owner turn and two guests never
/// share one.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub(crate) enum TrustLane {
    /// Owner and owner-equivalent siblings.
    #[default]
    Owner,
    /// One non-owner requester.
    Guest(String),
}

/// What the gate does with an inbound event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GateDecision {
    /// Queue for a local turn.
    Local(TrustTier),
    /// Hand to the hosted guest-turn route.
    Route(TrustTier),
    /// Ignore.
    Drop,
}

/// Decide what to do with an event from `tier`.
///
/// `legacy_allowed` is the old yes/no gate, consulted only in
/// [`GuestTurns::Local`] mode. In hosted mode every non-owner event is routed
/// whatever `respond_to` says: the hosted side applies the registered policy
/// (an `owner-only` agent answers with a short refusal) and classifies the
/// crossing either way.
pub(crate) fn decide(
    guest_turns: GuestTurns,
    respond_to: &RespondTo,
    tier: TrustTier,
    legacy_allowed: bool,
) -> GateDecision {
    if matches!(respond_to, RespondTo::Nobody) {
        return GateDecision::Drop;
    }
    if tier.is_owner_equivalent() {
        return if legacy_allowed {
            GateDecision::Local(tier)
        } else {
            GateDecision::Drop
        };
    }
    match guest_turns {
        GuestTurns::Hosted => GateDecision::Route(tier),
        GuestTurns::Local if legacy_allowed => GateDecision::Local(tier),
        GuestTurns::Local => GateDecision::Drop,
    }
}

/// Classify an author from already-resolved facts. Pure, for testing.
///
/// - `owner` / `is_sibling`: the existing owner-or-sibling check.
/// - `guest_tag`: the event's `buzz-guest` requester, if any.
/// - `attested_owner`: the owner proven by the author's own NIP-OA tag.
/// - `chain`: claimed relay authors before this one, origin first.
pub(crate) fn tier_from_parts(
    author: &str,
    owner: Option<&str>,
    is_sibling: bool,
    guest_tag: Option<&str>,
    attested_owner: Option<&str>,
    chain: &[String],
) -> TrustTier {
    if owner.is_some_and(|owner| owner.eq_ignore_ascii_case(author)) {
        return TrustTier::Owner;
    }
    if is_sibling {
        return match guest_tag {
            Some(requester) if !owner.is_some_and(|o| o.eq_ignore_ascii_case(requester)) => {
                TrustTier::Guest {
                    requester: requester.to_string(),
                }
            }
            _ => TrustTier::Sibling,
        };
    }
    match attested_owner {
        Some(agent_owner) => {
            let mut full_chain: Vec<String> = chain.to_vec();
            full_chain.push(author.to_string());
            TrustTier::OtherOwnerAgent {
                agent: author.to_string(),
                owner: agent_owner.to_string(),
                chain: full_chain,
            }
        }
        None => TrustTier::Guest {
            requester: author.to_string(),
        },
    }
}

/// An author's kind:0 profile facts.
#[derive(Debug, Clone, Default)]
pub(crate) struct AuthorProfile {
    /// Owner proven by a valid NIP-OA `auth` tag on the profile.
    pub(crate) attested_owner: Option<String>,
    /// The signed kind:0 event as JSON (forwarded to the guest route).
    pub(crate) event: Option<Value>,
}

impl AuthorProfile {
    /// Whether the profile proves the author is an agent.
    pub(crate) fn is_agent(&self) -> bool {
        self.attested_owner.is_some()
    }
}

const PROFILE_TTL: Duration = Duration::from_secs(10 * 60);
const PROFILE_CACHE_CAP: usize = 512;
const PROFILE_TIMEOUT: Duration = Duration::from_millis(2000);

/// Cached kind:0 lookups, keyed by author hex.
#[derive(Default)]
pub(crate) struct ProfileDirectory {
    entries: Mutex<HashMap<String, (Instant, Arc<AuthorProfile>)>>,
}

impl ProfileDirectory {
    /// The author's profile facts. A failed lookup returns an empty profile
    /// (treated as a person) and is not cached, so the next event retries.
    pub(crate) async fn lookup(&self, author: &str, rest: &RestClient) -> Arc<AuthorProfile> {
        if let Some(hit) = self.cached(author) {
            return hit;
        }
        let Some(profile) = fetch_profile(author, rest).await else {
            return Arc::new(AuthorProfile::default());
        };
        let profile = Arc::new(profile);
        if let Ok(mut entries) = self.entries.lock() {
            if entries.len() >= PROFILE_CACHE_CAP {
                let now = Instant::now();
                entries.retain(|_, (at, _)| now.duration_since(*at) < PROFILE_TTL);
                if entries.len() >= PROFILE_CACHE_CAP {
                    entries.clear();
                }
            }
            entries.insert(author.to_string(), (Instant::now(), profile.clone()));
        }
        profile
    }

    fn cached(&self, author: &str) -> Option<Arc<AuthorProfile>> {
        let entries = self.entries.lock().ok()?;
        let (at, profile) = entries.get(author)?;
        (at.elapsed() < PROFILE_TTL).then(|| profile.clone())
    }
}

async fn fetch_profile(author: &str, rest: &RestClient) -> Option<AuthorProfile> {
    let author_pk = PublicKey::from_hex(author).ok()?;
    let filter = nostr::Filter::new()
        .kind(nostr::Kind::Metadata)
        .author(author_pk)
        .limit(1);
    let response = tokio::time::timeout(PROFILE_TIMEOUT, rest.query(&[filter]))
        .await
        .ok()?
        .ok()?;
    let event = response.as_array()?.first()?.clone();
    Some(profile_from_event(&author_pk, event))
}

/// Extract profile facts from a kind:0 JSON event authored by `author`.
/// The event signature and the NIP-OA signature are both verified here; the
/// relay is not trusted.
pub(crate) fn profile_from_event(author: &PublicKey, event: Value) -> AuthorProfile {
    let verified = serde_json::from_value::<Event>(event.clone())
        .ok()
        .filter(|parsed| parsed.pubkey == *author && buzz_core::verify_event(parsed).is_ok());
    let Some(parsed) = verified else {
        return AuthorProfile::default();
    };
    let attested_owner = parsed.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        if parts.len() != 4 || parts[0] != "auth" {
            return None;
        }
        let json = serde_json::to_string(parts).ok()?;
        buzz_sdk::nip_oa::verify_auth_tag(&json, author)
            .ok()
            .map(|owner| owner.to_hex())
    });
    AuthorProfile {
        attested_owner,
        event: Some(event),
    }
}

/// Prompt marker for text produced for, or relayed from, a non-owner:
/// `[guest: <requester> via <agent>]`. Sits where `[your owner]` would.
pub(crate) fn guest_marker(requester_label: &str, via_label: Option<&str>) -> String {
    match via_label {
        Some(via) => format!("[guest: {requester_label} via {via}]"),
        None => format!("[guest: {requester_label}]"),
    }
}

/// The guest marker for `event`, decided from signed tags only:
///
/// - a `buzz-guest` tag names the requester the text was produced for;
/// - a `buzz-relay` tag names the origin author an agent is relaying.
///
/// `None` when neither applies, or when the named person is the owner (an
/// owner request relayed by an agent is not a guest request). `label` turns a
/// pubkey into a display label.
pub(crate) fn guest_marker_for(
    event: &Event,
    owner: Option<&str>,
    label: impl Fn(&str) -> String,
) -> Option<String> {
    let author = event.pubkey.to_hex();
    let requester = buzz_sdk::agent_relay::guest_requester(event).or_else(|| {
        buzz_sdk::agent_relay::parse_relay_claim(event)
            .ok()
            .flatten()
            .map(|claim| claim.origin_author)
    })?;
    if owner.is_some_and(|owner| owner.eq_ignore_ascii_case(&requester)) {
        return None;
    }
    let via = (requester != author).then(|| label(&author));
    Some(guest_marker(&label(&requester), via.as_deref()))
}

/// Short notice text for a crossing this harness refuses on its own.
pub(crate) fn owner_only_notice(owner_label: Option<&str>) -> String {
    match owner_label {
        Some(owner) => format!("I only take requests from {owner}. Please ask them directly."),
        None => "I only take requests from my owner.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    const OWNER: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const OTHER: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const GUEST: &str = "3333333333333333333333333333333333333333333333333333333333333333";

    #[test]
    fn owner_is_decided_by_signed_author() {
        assert_eq!(
            tier_from_parts(OWNER, Some(OWNER), true, Some(GUEST), None, &[]),
            TrustTier::Owner
        );
    }

    #[test]
    fn sibling_guest_output_is_a_crossing() {
        assert_eq!(
            tier_from_parts(OTHER, Some(OWNER), true, Some(GUEST), Some(OWNER), &[]),
            TrustTier::Guest {
                requester: GUEST.into()
            }
        );
        // A guest tag naming the owner is not a crossing.
        assert_eq!(
            tier_from_parts(OTHER, Some(OWNER), true, Some(OWNER), Some(OWNER), &[]),
            TrustTier::Sibling
        );
        assert_eq!(
            tier_from_parts(OTHER, Some(OWNER), true, None, Some(OWNER), &[]),
            TrustTier::Sibling
        );
    }

    #[test]
    fn other_owner_agent_carries_chain() {
        let tier = tier_from_parts(
            OTHER,
            Some(OWNER),
            false,
            None,
            Some(GUEST),
            &[GUEST.into()],
        );
        assert_eq!(
            tier,
            TrustTier::OtherOwnerAgent {
                agent: OTHER.into(),
                owner: GUEST.into(),
                chain: vec![GUEST.into(), OTHER.into()],
            }
        );
        assert_eq!(tier.lane(), TrustLane::Guest(OTHER.into()));
    }

    #[test]
    fn unattested_author_is_a_guest() {
        assert_eq!(
            tier_from_parts(GUEST, Some(OWNER), false, None, None, &[]),
            TrustTier::Guest {
                requester: GUEST.into()
            }
        );
        // No owner configured: nobody is the owner.
        assert_eq!(
            tier_from_parts(GUEST, None, false, None, None, &[]),
            TrustTier::Guest {
                requester: GUEST.into()
            }
        );
    }

    #[test]
    fn hosted_mode_routes_every_crossing_whatever_respond_to_says() {
        let guest = TrustTier::Guest {
            requester: GUEST.into(),
        };
        for mode in [
            RespondTo::OwnerOnly,
            RespondTo::Allowlist,
            RespondTo::Anyone,
        ] {
            for legacy in [true, false] {
                assert_eq!(
                    decide(GuestTurns::Hosted, &mode, guest.clone(), legacy),
                    GateDecision::Route(guest.clone()),
                    "{mode} legacy={legacy}"
                );
            }
        }
        assert_eq!(
            decide(GuestTurns::Hosted, &RespondTo::Nobody, guest, true),
            GateDecision::Drop
        );
    }

    #[test]
    fn owner_turns_stay_local_in_both_modes() {
        for mode in [GuestTurns::Hosted, GuestTurns::Local] {
            assert_eq!(
                decide(mode, &RespondTo::OwnerOnly, TrustTier::Owner, true),
                GateDecision::Local(TrustTier::Owner)
            );
            assert_eq!(
                decide(mode, &RespondTo::OwnerOnly, TrustTier::Sibling, true),
                GateDecision::Local(TrustTier::Sibling)
            );
        }
    }

    #[test]
    fn local_mode_keeps_the_legacy_gate() {
        let guest = TrustTier::Guest {
            requester: GUEST.into(),
        };
        assert_eq!(
            decide(
                GuestTurns::Local,
                &RespondTo::Allowlist,
                guest.clone(),
                true
            ),
            GateDecision::Local(guest.clone())
        );
        assert_eq!(
            decide(GuestTurns::Local, &RespondTo::OwnerOnly, guest, false),
            GateDecision::Drop
        );
    }

    #[test]
    fn guest_marker_reads_signed_tags() {
        let agent = Keys::generate();
        let label = |pk: &str| pk[..4].to_string();
        let tagged = EventBuilder::new(Kind::Custom(9), "answer")
            .tags([Tag::parse(["buzz-guest", GUEST]).unwrap()])
            .sign_with_keys(&agent)
            .unwrap();
        let via = agent.public_key().to_hex()[..4].to_string();
        assert_eq!(
            guest_marker_for(&tagged, Some(OWNER), label),
            Some(format!("[guest: 3333 via {via}]"))
        );
        // Relayed owner request: not a guest.
        let relayed = EventBuilder::new(Kind::Custom(9), "ask")
            .tags([Tag::parse(["buzz-relay", &"a".repeat(64), OWNER, "1"]).unwrap()])
            .sign_with_keys(&agent)
            .unwrap();
        assert_eq!(guest_marker_for(&relayed, Some(OWNER), label), None);
        // Plain message: no marker.
        let plain = EventBuilder::new(Kind::Custom(9), "hi")
            .sign_with_keys(&agent)
            .unwrap();
        assert_eq!(guest_marker_for(&plain, Some(OWNER), label), None);
        assert_eq!(guest_marker("Jess", None), "[guest: Jess]");
    }

    #[test]
    fn profile_attestation_is_verified_not_trusted() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let auth =
            buzz_sdk::nip_oa::compute_auth_tag(&owner, &agent.public_key(), "").expect("auth");
        let parts: Vec<String> = serde_json::from_str(&auth).expect("parts");
        let profile = EventBuilder::new(Kind::Metadata, "{}")
            .tags([Tag::parse(parts).expect("tag")])
            .sign_with_keys(&agent)
            .expect("sign");
        let json = serde_json::to_value(&profile).expect("json");
        let facts = profile_from_event(&agent.public_key(), json.clone());
        assert_eq!(facts.attested_owner, Some(owner.public_key().to_hex()));
        assert!(facts.is_agent());

        // The same profile claimed for a different author proves nothing.
        let stranger = Keys::generate();
        assert!(profile_from_event(&stranger.public_key(), json)
            .attested_owner
            .is_none());

        // A forged attestation (signed by someone other than the named owner).
        let forger = Keys::generate();
        let forged = buzz_sdk::nip_oa::compute_auth_tag(&forger, &agent.public_key(), "")
            .expect("forged")
            .replace(&forger.public_key().to_hex(), &owner.public_key().to_hex());
        let parts: Vec<String> = serde_json::from_str(&forged).expect("parts");
        let profile = EventBuilder::new(Kind::Metadata, "{}")
            .tags([Tag::parse(parts).expect("tag")])
            .sign_with_keys(&agent)
            .expect("sign");
        let facts = profile_from_event(
            &agent.public_key(),
            serde_json::to_value(&profile).expect("json"),
        );
        assert!(facts.attested_owner.is_none());
    }
}

//! DM participant resolution for the opt-in allowlist-in-DMs author gate.
//!
//! When `BUZZ_ACP_ALLOWLIST_IN_DMS` is enabled, an allowlisted author may fire
//! a turn inside a DM only if *every* participant of that DM is trusted. This
//! module resolves the participant roster from the relay's authoritative
//! kind:39002 (NIP-29 group members) snapshot. Kind 39002 is relay-only
//! (clients cannot publish it), and the relay rewrites it behind a membership
//! lock on every membership change, so it is the canonical roster.
//!
//! Rosters are cached per channel for [`PARTICIPANT_CACHE_TTL`] so a busy DM
//! costs at most one bounded REST query per TTL window. Failures are never
//! cached: the caller fails closed (deny) and the next event retries.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::relay::RestClient;

/// How long a resolved roster is trusted before re-fetching. Short so a
/// participant added to the DM is seen quickly; the cache is also bypassed
/// whenever the current author is missing from the cached roster.
pub(crate) const PARTICIPANT_CACHE_TTL: Duration = Duration::from_secs(30);
/// Upper bound for a single roster fetch.
const FETCH_TIMEOUT: Duration = Duration::from_millis(2_000);
/// Cap on cached channels to keep memory bounded.
const MAX_CACHED_CHANNELS: usize = 256;
/// Rosters larger than this are not DMs in any meaningful sense; the gate
/// denies rather than doing unbounded per-participant sibling lookups.
pub(crate) const MAX_DM_PARTICIPANTS: usize = 32;

#[derive(Debug, Clone)]
struct Cached {
    fetched_at: Instant,
    members: HashSet<String>,
}

/// Per-channel, short-TTL cache of DM participant rosters.
#[derive(Debug)]
pub(crate) struct DmParticipantResolver {
    cache: Mutex<HashMap<Uuid, Cached>>,
    rest_client: RestClient,
}

impl DmParticipantResolver {
    pub(crate) fn new(rest_client: RestClient) -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            rest_client,
        }
    }

    /// Resolve the participant set (lowercase hex pubkeys) of `channel_id`.
    ///
    /// A fresh cached roster is reused only if it contains `author`; otherwise
    /// the roster is re-fetched (the author may have just joined). Returns
    /// `None` when the roster cannot be resolved — callers must fail closed.
    pub(crate) async fn participants(
        &self,
        channel_id: Uuid,
        author: &str,
    ) -> Option<HashSet<String>> {
        if let Some(members) = self.cached(channel_id, author) {
            return Some(members);
        }
        let members = fetch_members(channel_id, &self.rest_client).await?;
        if let Ok(mut cache) = self.cache.lock() {
            if cache.len() >= MAX_CACHED_CHANNELS && !cache.contains_key(&channel_id) {
                cache.clear();
            }
            cache.insert(
                channel_id,
                Cached {
                    fetched_at: Instant::now(),
                    members: members.clone(),
                },
            );
        }
        Some(members)
    }

    fn cached(&self, channel_id: Uuid, author: &str) -> Option<HashSet<String>> {
        let cache = self.cache.lock().ok()?;
        let entry = cache.get(&channel_id)?;
        (entry.fetched_at.elapsed() < PARTICIPANT_CACHE_TTL && entry.members.contains(author))
            .then(|| entry.members.clone())
    }

    /// Seed the cache with a roster (tests only).
    #[cfg(test)]
    pub(crate) fn seed(&self, channel_id: Uuid, members: &[&str]) {
        self.cache.lock().unwrap().insert(
            channel_id,
            Cached {
                fetched_at: Instant::now(),
                members: members.iter().map(|m| m.to_string()).collect(),
            },
        );
    }
}

/// One bounded REST query for the channel's kind:39002 roster.
async fn fetch_members(channel_id: Uuid, rest: &RestClient) -> Option<HashSet<String>> {
    use nostr::{Alphabet, SingleLetterTag};

    let filter = nostr::Filter::new()
        .kind(nostr::Kind::Custom(
            buzz_core::kind::KIND_NIP29_GROUP_MEMBERS as u16,
        ))
        .custom_tags(
            SingleLetterTag::lowercase(Alphabet::D),
            [channel_id.to_string()],
        );
    match tokio::time::timeout(FETCH_TIMEOUT, rest.query(std::slice::from_ref(&filter))).await {
        Ok(Ok(json)) => {
            let members = parse_members(&json, channel_id);
            if members.is_none() {
                tracing::warn!(channel_id = %channel_id, "DM roster missing or empty");
            }
            members
        }
        Ok(Err(e)) => {
            tracing::warn!(channel_id = %channel_id, "DM roster fetch failed: {e}");
            None
        }
        Err(_) => {
            tracing::warn!(channel_id = %channel_id, "DM roster fetch timed out");
            None
        }
    }
}

/// Extract the member pubkeys from the newest kind:39002 event for
/// `channel_id` in a `/query` response. `None` if no matching event or the
/// roster is empty (an empty roster is never evidence of a trusted DM).
pub(crate) fn parse_members(json: &serde_json::Value, channel_id: Uuid) -> Option<HashSet<String>> {
    let group_id = channel_id.to_string();
    let event = json
        .as_array()?
        .iter()
        .filter(|ev| {
            ev.get("kind").and_then(|k| k.as_u64())
                == Some(u64::from(buzz_core::kind::KIND_NIP29_GROUP_MEMBERS))
        })
        .filter(|ev| {
            tags(ev).any(|tag| {
                tag.first().and_then(|v| v.as_str()) == Some("d")
                    && tag.get(1).and_then(|v| v.as_str()) == Some(group_id.as_str())
            })
        })
        .max_by_key(|ev| ev.get("created_at").and_then(|c| c.as_u64()).unwrap_or(0))?;
    let members: HashSet<String> = tags(event)
        .filter(|tag| tag.first().and_then(|v| v.as_str()) == Some("p"))
        .filter_map(|tag| tag.get(1).and_then(|v| v.as_str()))
        .filter(|pk| pk.len() == 64 && pk.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .collect();
    (!members.is_empty()).then_some(members)
}

fn tags(event: &serde_json::Value) -> impl Iterator<Item = &Vec<serde_json::Value>> {
    event
        .get("tags")
        .and_then(|t| t.as_array())
        .into_iter()
        .flatten()
        .filter_map(|t| t.as_array())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pk(c: char) -> String {
        c.to_string().repeat(64)
    }

    #[test]
    fn parse_members_reads_newest_roster_for_channel() {
        let id = Uuid::new_v4();
        let other = Uuid::new_v4();
        let json = serde_json::json!([
            {"kind": 39002, "created_at": 1, "tags": [["d", id.to_string()], ["p", pk('a'), "", "member"]]},
            {"kind": 39002, "created_at": 5, "tags": [["d", id.to_string()], ["p", pk('A'), "", "owner"], ["p", pk('b'), "", "member"], ["p", "short"]]},
            {"kind": 39002, "created_at": 9, "tags": [["d", other.to_string()], ["p", pk('c')]]},
        ]);
        let members = parse_members(&json, id).expect("roster");
        assert_eq!(members, HashSet::from([pk('a'), pk('b')]));
    }

    #[test]
    fn parse_members_rejects_missing_or_empty_roster() {
        let id = Uuid::new_v4();
        assert!(parse_members(&serde_json::json!([]), id).is_none());
        assert!(parse_members(
            &serde_json::json!([{"kind": 39002, "created_at": 1, "tags": [["d", id.to_string()]]}]),
            id
        )
        .is_none());
        assert!(parse_members(&serde_json::json!({"error": "x"}), id).is_none());
    }
}

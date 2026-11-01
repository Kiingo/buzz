//! Which keys may relay people's posts into a room.
//!
//! An event can't say who may relay it, so the harness asks the hosted guest
//! route and keeps the answer briefly. The list decides only which loop guards
//! apply to a relayed post. It says who could sign, not that a person wrote
//! the post, and it grants no authority.
//!
//! Any failure means an empty list: the post keeps its agent guards and still
//! routes. Logs carry codes only.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::guest_route::{RelaySigners, RouteError};

/// Longest an answer is kept, whatever the route says.
const MAX_ANSWER_TTL: Duration = Duration::from_secs(300);
/// How long a failed or empty answer is kept, so an outage can't stall the
/// listener on every tagged post and a newly linked room starts working soon.
const NEGATIVE_TTL: Duration = Duration::from_secs(30);
/// Bound for one lookup. Matches the other admission lookups on the listener.
const LOOKUP_TIMEOUT: Duration = Duration::from_millis(2_000);
/// Most rooms kept at once.
const MAX_ROOMS: usize = 1_024;

/// Relayed posts one signer may send in one room per minute before they count
/// as agent traffic. One a second, sustained, is well above how fast people
/// post, and a listed key could otherwise tag its own loop traffic.
pub(crate) const RELAYED_POSTS_PER_MINUTE: u32 = 60;
const CEILING_WINDOW: Duration = Duration::from_secs(60);
/// Most (signer, room) counts kept at once.
const MAX_CEILING_KEYS: usize = 4_096;

struct CachedAnswer {
    signers: Arc<HashSet<String>>,
    expires_at: Instant,
}

/// One room's answer. The lock is held across the lookup, so a burst in one
/// room makes one request and the rest read its answer.
#[derive(Default)]
struct RoomSlot(tokio::sync::Mutex<Option<CachedAnswer>>);

impl RoomSlot {
    /// The answer's expiry. The outer `None` means a lookup holds the slot;
    /// the inner `None` means it has no answer yet.
    fn expiry(&self) -> Option<Option<Instant>> {
        let answer = self.0.try_lock().ok()?;
        Some(answer.as_ref().map(|answer| answer.expires_at))
    }
}

/// Bounded per-room cache of the route's answers.
#[derive(Default)]
pub(crate) struct RoomSignerCache {
    rooms: Mutex<HashMap<Uuid, Arc<RoomSlot>>>,
}

impl RoomSignerCache {
    /// The room's signers, from the cache or one bounded `lookup`.
    pub(crate) async fn signers<Lookup, LookupFut>(
        &self,
        channel_id: Uuid,
        lookup: Lookup,
    ) -> Arc<HashSet<String>>
    where
        Lookup: FnOnce() -> LookupFut,
        LookupFut: Future<Output = Result<RelaySigners, RouteError>>,
    {
        let slot = self.slot(channel_id);
        let mut answer = slot.0.lock().await;
        if let Some(cached) = answer
            .as_ref()
            .filter(|cached| cached.expires_at > Instant::now())
        {
            return cached.signers.clone();
        }
        let (signers, ttl) = match tokio::time::timeout(LOOKUP_TIMEOUT, lookup()).await {
            Ok(Ok(found)) => parse_answer(channel_id, found),
            Ok(Err(error)) => failed(channel_id, error.status, failure_code(&error)),
            Err(_) => failed(channel_id, None, "timeout"),
        };
        let signers = Arc::new(signers);
        *answer = Some(CachedAnswer {
            signers: signers.clone(),
            expires_at: Instant::now() + ttl,
        });
        signers
    }

    fn slot(&self, channel_id: Uuid) -> Arc<RoomSlot> {
        let mut rooms = self
            .rooms
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(slot) = rooms.get(&channel_id) {
            return slot.clone();
        }
        if rooms.len() >= MAX_ROOMS {
            evict(&mut rooms, Instant::now());
        }
        let slot = Arc::new(RoomSlot::default());
        rooms.insert(channel_id, slot.clone());
        slot
    }
}

/// Drop expired rooms, then, if none had expired, the one closest to expiry.
/// A room mid-lookup goes last.
fn evict(rooms: &mut HashMap<Uuid, Arc<RoomSlot>>, now: Instant) {
    rooms.retain(|_, slot| match slot.expiry() {
        None => true,
        Some(None) => false,
        Some(Some(expires_at)) => expires_at > now,
    });
    if rooms.len() < MAX_ROOMS {
        return;
    }
    let last = now + MAX_ANSWER_TTL + NEGATIVE_TTL;
    let soonest = rooms
        .iter()
        .min_by_key(|(_, slot)| slot.expiry().flatten().unwrap_or(last))
        .map(|(channel_id, _)| *channel_id);
    if let Some(channel_id) = soonest {
        rooms.remove(&channel_id);
    }
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The signers and how long to keep them. One bad key fails the whole answer.
fn parse_answer(channel_id: Uuid, answer: RelaySigners) -> (HashSet<String>, Duration) {
    if !answer.signers.iter().all(|key| is_hex64(key)) {
        return failed(channel_id, None, "malformed");
    }
    let ttl = if answer.signers.is_empty() {
        NEGATIVE_TTL
    } else {
        Duration::from_secs(answer.ttl_seconds).clamp(NEGATIVE_TTL, MAX_ANSWER_TTL)
    };
    let signers = answer
        .signers
        .iter()
        .map(|key| key.to_ascii_lowercase())
        .collect();
    (signers, ttl)
}

fn failed(channel_id: Uuid, status: Option<u16>, code: &str) -> (HashSet<String>, Duration) {
    tracing::warn!(
        channel_id = %channel_id,
        status,
        code,
        "relay signer lookup failed; agent guards apply"
    );
    (HashSet::new(), NEGATIVE_TTL)
}

/// A fixed code: `RouteError::code` can hold transport text with a URL in it.
fn failure_code(error: &RouteError) -> &'static str {
    match error.status {
        Some(_) => "http_error",
        None if error.code.starts_with("transport") => "transport",
        None => "malformed",
    }
}

struct CeilingWindow {
    started_at: Instant,
    posts: u32,
}

/// Counts relayed posts per signer per room, per minute.
#[derive(Default)]
pub(crate) struct RelayedPostCeiling {
    windows: HashMap<(String, Uuid), CeilingWindow>,
}

impl RelayedPostCeiling {
    /// Count one post. False once this signer is over the ceiling in this room.
    pub(crate) fn admit(&mut self, signer: &str, channel_id: Uuid, now: Instant) -> bool {
        let key = (signer.to_string(), channel_id);
        if self.windows.len() >= MAX_CEILING_KEYS && !self.windows.contains_key(&key) {
            self.make_room(now);
        }
        let window = self.windows.entry(key).or_insert(CeilingWindow {
            started_at: now,
            posts: 0,
        });
        if now.duration_since(window.started_at) >= CEILING_WINDOW {
            window.started_at = now;
            window.posts = 0;
        }
        window.posts = window.posts.saturating_add(1);
        window.posts <= RELAYED_POSTS_PER_MINUTE
    }

    fn make_room(&mut self, now: Instant) {
        self.windows
            .retain(|_, window| now.duration_since(window.started_at) < CEILING_WINDOW);
        if self.windows.len() < MAX_CEILING_KEYS {
            return;
        }
        let oldest = self
            .windows
            .iter()
            .min_by_key(|(_, window)| window.started_at)
            .map(|(key, _)| key.clone());
        if let Some(key) = oldest {
            self.windows.remove(&key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn answer(signers: Vec<String>, ttl_seconds: u64) -> RelaySigners {
        RelaySigners {
            signers,
            ttl_seconds,
        }
    }

    #[test]
    fn an_answer_is_kept_five_minutes_at_most_and_an_empty_one_briefly() {
        let key = "ab".repeat(32);
        let ttl = |seconds| parse_answer(Uuid::nil(), answer(vec![key.clone()], seconds)).1;
        assert_eq!(ttl(120), Duration::from_secs(120));
        assert_eq!(ttl(86_400), MAX_ANSWER_TTL);
        assert_eq!(ttl(u64::MAX), MAX_ANSWER_TTL);
        assert_eq!(ttl(0), NEGATIVE_TTL);
        assert_eq!(
            parse_answer(Uuid::nil(), answer(Vec::new(), 300)).1,
            NEGATIVE_TTL
        );
    }

    #[test]
    fn keys_are_lowercased_and_one_bad_key_fails_the_answer() {
        let upper = "AB".repeat(32);
        let (signers, _) = parse_answer(Uuid::nil(), answer(vec![upper], 300));
        assert!(signers.contains(&"ab".repeat(32)));

        let (signers, ttl) =
            parse_answer(Uuid::nil(), answer(vec!["ab".repeat(32), "x".into()], 300));
        assert!(signers.is_empty());
        assert_eq!(ttl, NEGATIVE_TTL);
    }

    #[test]
    fn failure_codes_never_carry_transport_text() {
        let error = |status, code: &str| RouteError {
            status,
            code: code.to_string(),
            retry_after_ms: None,
            never_sent: false,
        };
        assert_eq!(
            failure_code(&error(None, "transport: https://route.test/x")),
            "transport"
        );
        assert_eq!(
            failure_code(&error(Some(503), "database_unavailable")),
            "http_error"
        );
        assert_eq!(
            failure_code(&error(None, "unexpected relay signers: bad")),
            "malformed"
        );
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_lookup_per_room() {
        let cache = RoomSignerCache::default();
        let calls = AtomicUsize::new(0);
        let key = "ab".repeat(32);
        let lookup = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(answer(vec![key.clone()], 300))
        };
        let room = Uuid::new_v4();
        let (first, second, third) = tokio::join!(
            cache.signers(room, lookup),
            cache.signers(room, lookup),
            cache.signers(room, lookup)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(first.contains(&key) && second.contains(&key) && third.contains(&key));

        cache.signers(Uuid::new_v4(), lookup).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2, "each room asks for itself");
    }

    #[tokio::test]
    async fn the_cache_never_holds_more_rooms_than_its_bound() {
        let cache = RoomSignerCache::default();
        let key = "ab".repeat(32);
        for _ in 0..(MAX_ROOMS + 16) {
            cache
                .signers(Uuid::new_v4(), || async {
                    Ok(answer(vec![key.clone()], 300))
                })
                .await;
        }
        assert_eq!(cache.rooms.lock().unwrap().len(), MAX_ROOMS);
    }

    #[test]
    fn eviction_drops_expired_rooms_first_and_spares_a_lookup() {
        let now = Instant::now();
        let room = |expires_at| {
            Arc::new(RoomSlot(tokio::sync::Mutex::new(Some(CachedAnswer {
                signers: Arc::new(HashSet::new()),
                expires_at,
            }))))
        };
        let mut rooms: HashMap<Uuid, Arc<RoomSlot>> = (0..MAX_ROOMS - 1)
            .map(|i| {
                (
                    Uuid::new_v4(),
                    room(now + Duration::from_secs(100 + i as u64)),
                )
            })
            .collect();
        let expired = Uuid::new_v4();
        rooms.insert(expired, room(now - Duration::from_secs(1)));
        evict(&mut rooms, now);
        assert_eq!(rooms.len(), MAX_ROOMS - 1);
        assert!(!rooms.contains_key(&expired));

        // Full and nothing expired: the room closest to expiry goes, never
        // one with a lookup running.
        let soonest = Uuid::new_v4();
        rooms.insert(soonest, room(now + Duration::from_secs(1)));
        let busy = Uuid::new_v4();
        let slot = room(now + Duration::from_millis(1));
        rooms.insert(busy, slot.clone());
        let held = slot.0.try_lock().unwrap();
        let spare = rooms
            .keys()
            .copied()
            .find(|id| *id != busy && *id != soonest)
            .unwrap();
        rooms.remove(&spare);
        evict(&mut rooms, now);
        drop(held);
        assert!(rooms.contains_key(&busy));
        assert!(!rooms.contains_key(&soonest));
    }

    #[test]
    fn the_ceiling_counts_per_signer_and_room_and_resets_each_minute() {
        let mut ceiling = RelayedPostCeiling::default();
        let now = Instant::now();
        let room = Uuid::new_v4();
        for _ in 0..RELAYED_POSTS_PER_MINUTE {
            assert!(ceiling.admit("signer", room, now));
        }
        assert!(!ceiling.admit("signer", room, now));
        assert!(ceiling.admit("other", room, now));
        assert!(ceiling.admit("signer", Uuid::new_v4(), now));
        assert!(ceiling.admit("signer", room, now + CEILING_WINDOW));
    }

    #[test]
    fn the_ceiling_keeps_a_bounded_number_of_counts() {
        let mut ceiling = RelayedPostCeiling::default();
        let now = Instant::now();
        for _ in 0..(MAX_CEILING_KEYS + 16) {
            ceiling.admit("signer", Uuid::new_v4(), now);
        }
        assert_eq!(ceiling.windows.len(), MAX_CEILING_KEYS);
    }
}

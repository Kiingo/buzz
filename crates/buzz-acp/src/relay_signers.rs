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

use nostr::EventId;
use uuid::Uuid;

use crate::guest_route::{RelaySigners, RouteError};

/// Longest an answer is kept, whatever the route says.
const MAX_ANSWER_TTL: Duration = Duration::from_secs(300);
/// How long a failed or empty answer is kept, so an outage isn't asked about on
/// every tagged post and a newly linked room starts working soon.
const NEGATIVE_TTL: Duration = Duration::from_secs(30);
/// Bound for one lookup, which runs off the listener.
const LOOKUP_TIMEOUT: Duration = Duration::from_millis(2_000);
/// Most rooms kept at once.
const MAX_ROOMS: usize = 1_024;

/// Relayed posts one signer may send in one room per minute before they count
/// as agent traffic. One a second, sustained, is well above how fast people
/// post, and a listed key could otherwise tag its own loop traffic.
pub(crate) const RELAYED_POSTS_PER_MINUTE: usize = 60;
const CEILING_WINDOW: Duration = Duration::from_secs(60);
/// Most (signer, room) counts kept at once.
const MAX_CEILING_KEYS: usize = 4_096;

struct CachedAnswer {
    signers: Arc<HashSet<String>>,
    expires_at: Instant,
}

#[derive(Default)]
struct Room {
    answer: Option<CachedAnswer>,
    /// The lookup in flight. Only that lookup may write the answer, so one
    /// that outlives its room's eviction can't put the room back.
    refreshing: Option<u64>,
}

#[derive(Default)]
struct Rooms {
    rooms: HashMap<Uuid, Room>,
    next_refresh: u64,
}

/// What the cache holds for a room right now.
pub(crate) struct RoomRead {
    pub(crate) signers: Arc<HashSet<String>>,
    /// Set when the caller must run [`RoomSignerCache::refresh`] with this id.
    /// One room runs one lookup at a time.
    pub(crate) refresh: Option<u64>,
}

/// A running lookup's claim on its room. A lookup that ends without an answer,
/// by a panic or a cancelled task, leaves as a failed one, so the room doesn't
/// stay unlisted and spared from eviction with nothing running.
struct LookupClaim<'a> {
    cache: &'a RoomSignerCache,
    channel_id: Uuid,
    refresh: u64,
    answered: bool,
}

impl Drop for LookupClaim<'_> {
    fn drop(&mut self) {
        if !self.answered {
            let (signers, ttl) = failed(self.channel_id, None, "abandoned");
            self.cache
                .store(self.channel_id, self.refresh, signers, ttl);
        }
    }
}

/// Bounded per-room cache of the route's answers. Reads never wait: they run
/// on the listener, and a hung route must not delay another room or a control
/// command.
#[derive(Default)]
pub(crate) struct RoomSignerCache {
    state: Mutex<Rooms>,
}

impl RoomSignerCache {
    /// The room's signers as of now. No answer, or an expired one, reads as an
    /// empty list: the post keeps its agent guards while a refresh runs.
    pub(crate) fn read(&self, channel_id: Uuid) -> RoomRead {
        let now = Instant::now();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Rooms {
            rooms,
            next_refresh,
        } = &mut *state;
        if rooms.len() >= MAX_ROOMS && !rooms.contains_key(&channel_id) {
            evict(rooms, now);
        }
        let room = rooms.entry(channel_id).or_default();
        if let Some(cached) = room
            .answer
            .as_ref()
            .filter(|cached| cached.expires_at > now)
        {
            return RoomRead {
                signers: cached.signers.clone(),
                refresh: None,
            };
        }
        let refresh = room.refreshing.is_none().then_some(*next_refresh);
        if refresh.is_some() {
            room.refreshing = refresh;
            *next_refresh = next_refresh.wrapping_add(1);
        }
        RoomRead {
            signers: Arc::default(),
            refresh,
        }
    }

    /// Run one bounded `lookup` and store its answer, unless the room left the
    /// cache meanwhile.
    pub(crate) async fn refresh<Lookup, LookupFut>(
        &self,
        channel_id: Uuid,
        refresh: u64,
        lookup: Lookup,
    ) where
        Lookup: FnOnce() -> LookupFut,
        LookupFut: Future<Output = Result<RelaySigners, RouteError>>,
    {
        let mut claim = LookupClaim {
            cache: self,
            channel_id,
            refresh,
            answered: false,
        };
        let (signers, ttl) = match tokio::time::timeout(LOOKUP_TIMEOUT, lookup()).await {
            Ok(Ok(found)) => parse_answer(channel_id, found),
            Ok(Err(error)) => failed(channel_id, error.status, failure_code(&error)),
            Err(_) => failed(channel_id, None, "timeout"),
        };
        claim.answered = true;
        self.store(channel_id, refresh, signers, ttl);
    }

    /// Store a lookup's answer, if that lookup still owns its room.
    fn store(&self, channel_id: Uuid, refresh: u64, signers: HashSet<String>, ttl: Duration) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(room) = state
            .rooms
            .get_mut(&channel_id)
            .filter(|room| room.refreshing == Some(refresh))
        else {
            return;
        };
        room.refreshing = None;
        room.answer = Some(CachedAnswer {
            signers: Arc::new(signers),
            expires_at: Instant::now() + ttl,
        });
    }
}

/// Drop expired rooms, then, if none had expired, the one closest to expiry.
/// A room mid-lookup goes last.
fn evict(rooms: &mut HashMap<Uuid, Room>, now: Instant) {
    rooms.retain(|_, room| {
        room.refreshing.is_some()
            || room
                .answer
                .as_ref()
                .is_some_and(|answer| answer.expires_at > now)
    });
    if rooms.len() < MAX_ROOMS {
        return;
    }
    let soonest = rooms
        .iter()
        .min_by_key(|(_, room)| {
            (
                room.refreshing.is_some(),
                room.answer.as_ref().map(|answer| answer.expires_at),
            )
        })
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
    /// The posts counted so far, never more than the ceiling.
    posts: HashSet<EventId>,
}

/// Counts relayed posts per signer per room, per minute.
#[derive(Default)]
pub(crate) struct RelayedPostCeiling {
    windows: HashMap<(String, Uuid), CeilingWindow>,
}

impl RelayedPostCeiling {
    /// Count one post, once however often it is redelivered. False once this
    /// signer is over the ceiling in this room.
    pub(crate) fn admit(
        &mut self,
        signer: &str,
        channel_id: Uuid,
        event_id: EventId,
        now: Instant,
    ) -> bool {
        let key = (signer.to_string(), channel_id);
        if self.windows.len() >= MAX_CEILING_KEYS && !self.windows.contains_key(&key) {
            self.make_room(now);
        }
        let window = self.windows.entry(key).or_insert_with(|| CeilingWindow {
            started_at: now,
            posts: HashSet::new(),
        });
        if now.duration_since(window.started_at) >= CEILING_WINDOW {
            window.started_at = now;
            window.posts.clear();
        }
        if window.posts.contains(&event_id) {
            return true;
        }
        if window.posts.len() >= RELAYED_POSTS_PER_MINUTE {
            return false;
        }
        window.posts.insert(event_id);
        true
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

    fn stored(cache: &RoomSignerCache, room: Uuid, signer: &str) -> bool {
        cache.read(room).signers.contains(signer)
    }

    #[tokio::test]
    async fn a_read_never_waits_and_a_room_runs_one_lookup() {
        let cache = RoomSignerCache::default();
        let key = "ab".repeat(32);
        let room = Uuid::new_v4();

        let first = cache.read(room);
        assert!(first.signers.is_empty(), "a miss reads as unlisted");
        let refresh = first.refresh.expect("the first read starts the lookup");
        assert_eq!(cache.read(room).refresh, None, "one lookup at a time");

        cache
            .refresh(room, refresh, || async {
                Ok(answer(vec![key.clone()], 300))
            })
            .await;
        let read = cache.read(room);
        assert!(read.signers.contains(&key));
        assert_eq!(read.refresh, None, "a fresh answer needs no lookup");
        assert!(
            cache.read(Uuid::new_v4()).refresh.is_some(),
            "each room asks for itself"
        );
    }

    #[tokio::test]
    async fn a_failed_lookup_is_kept_and_an_expired_answer_reads_as_unlisted() {
        let cache = RoomSignerCache::default();
        let key = "ab".repeat(32);
        let room = Uuid::new_v4();
        let refresh = cache.read(room).refresh.expect("lookup");
        cache
            .refresh(room, refresh, || async {
                Err(RouteError {
                    status: Some(503),
                    code: "down".into(),
                    retry_after_ms: None,
                    never_sent: false,
                })
            })
            .await;
        assert_eq!(cache.read(room).refresh, None, "not repeated at once");

        cache.state.lock().unwrap().rooms.insert(
            room,
            Room {
                answer: Some(CachedAnswer {
                    signers: Arc::new(HashSet::from([key.clone()])),
                    expires_at: Instant::now() - Duration::from_secs(1),
                }),
                refreshing: None,
            },
        );
        let read = cache.read(room);
        assert!(!read.signers.contains(&key));
        assert!(read.refresh.is_some());
    }

    #[tokio::test]
    async fn a_lookup_that_panics_leaves_as_a_failed_lookup() {
        let cache = Arc::new(RoomSignerCache::default());
        let room = Uuid::new_v4();
        let refresh = cache.read(room).refresh.expect("lookup");

        let task = tokio::spawn({
            let cache = cache.clone();
            async move {
                cache
                    .refresh(room, refresh, || async { panic!("the lookup broke") })
                    .await;
            }
        });

        assert!(task.await.expect_err("it panicked").is_panic());
        assert_eq!(
            cache.state.lock().unwrap().rooms[&room].refreshing,
            None,
            "nothing is running, so the room can be evicted"
        );
        assert_eq!(cache.read(room).refresh, None, "not repeated at once");
    }

    #[tokio::test]
    async fn a_cancelled_lookup_leaves_as_a_failed_lookup() {
        let cache = Arc::new(RoomSignerCache::default());
        let room = Uuid::new_v4();
        let refresh = cache.read(room).refresh.expect("lookup");

        let task = tokio::spawn({
            let cache = cache.clone();
            async move {
                cache.refresh(room, refresh, std::future::pending).await;
            }
        });
        tokio::task::yield_now().await;
        task.abort();

        assert!(task.await.expect_err("it was cancelled").is_cancelled());
        assert_eq!(cache.state.lock().unwrap().rooms[&room].refreshing, None);
    }

    #[tokio::test]
    async fn an_abandoned_lookup_leaves_a_newer_one_alone() {
        let cache = RoomSignerCache::default();
        let room = Uuid::new_v4();
        let stale = cache.read(room).refresh.expect("lookup");
        cache.state.lock().unwrap().rooms.remove(&room);
        let current = cache.read(room).refresh.expect("a new lookup");

        drop(LookupClaim {
            cache: &cache,
            channel_id: room,
            refresh: stale,
            answered: false,
        });

        assert_eq!(
            cache.state.lock().unwrap().rooms[&room].refreshing,
            Some(current)
        );
    }

    #[tokio::test]
    async fn a_lookup_that_outlives_its_room_writes_nothing() {
        let cache = RoomSignerCache::default();
        let key = "ab".repeat(32);
        let room = Uuid::new_v4();
        let stale = cache.read(room).refresh.expect("lookup");
        cache.state.lock().unwrap().rooms.remove(&room);
        let current = cache.read(room).refresh.expect("a new lookup");
        assert_ne!(stale, current);

        cache
            .refresh(room, stale, || async { Ok(answer(vec![key.clone()], 300)) })
            .await;
        assert!(!stored(&cache, room, &key));

        cache.state.lock().unwrap().rooms.remove(&room);
        cache
            .refresh(room, current, || async {
                Ok(answer(vec![key.clone()], 300))
            })
            .await;
        assert!(cache.state.lock().unwrap().rooms.is_empty());
    }

    #[test]
    fn the_cache_never_holds_more_rooms_than_its_bound() {
        let cache = RoomSignerCache::default();
        for _ in 0..(MAX_ROOMS + 16) {
            cache.read(Uuid::new_v4());
        }
        assert_eq!(cache.state.lock().unwrap().rooms.len(), MAX_ROOMS);
    }

    #[test]
    fn eviction_drops_expired_rooms_first_and_spares_a_lookup() {
        let now = Instant::now();
        let room = |expires_at| Room {
            answer: Some(CachedAnswer {
                signers: Arc::new(HashSet::new()),
                expires_at,
            }),
            refreshing: None,
        };
        let mut rooms: HashMap<Uuid, Room> = (0..MAX_ROOMS - 1)
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
        let mut looking_up = room(now + Duration::from_millis(1));
        looking_up.refreshing = Some(1);
        rooms.insert(busy, looking_up);
        let spare = rooms
            .keys()
            .copied()
            .find(|id| *id != busy && *id != soonest)
            .unwrap();
        rooms.remove(&spare);
        evict(&mut rooms, now);
        assert!(rooms.contains_key(&busy));
        assert!(!rooms.contains_key(&soonest));
    }

    fn event_id(post: usize) -> EventId {
        EventId::from_hex(&format!("{post:064x}")).unwrap()
    }

    #[test]
    fn the_ceiling_counts_per_signer_and_room_and_resets_each_minute() {
        let mut ceiling = RelayedPostCeiling::default();
        let now = Instant::now();
        let room = Uuid::new_v4();
        for post in 0..RELAYED_POSTS_PER_MINUTE {
            assert!(ceiling.admit("signer", room, event_id(post), now));
        }
        let over = event_id(RELAYED_POSTS_PER_MINUTE);
        assert!(!ceiling.admit("signer", room, over, now));
        assert!(ceiling.admit("other", room, over, now));
        assert!(ceiling.admit("signer", Uuid::new_v4(), over, now));
        assert!(ceiling.admit("signer", room, over, now + CEILING_WINDOW));
    }

    #[test]
    fn a_redelivered_post_counts_once() {
        let mut ceiling = RelayedPostCeiling::default();
        let now = Instant::now();
        let room = Uuid::new_v4();
        for _ in 0..(RELAYED_POSTS_PER_MINUTE * 2) {
            assert!(ceiling.admit("signer", room, event_id(0), now));
        }
        for post in 1..RELAYED_POSTS_PER_MINUTE {
            assert!(ceiling.admit("signer", room, event_id(post), now));
        }
        // A post counted before the ceiling stays under it when redelivered.
        assert!(ceiling.admit("signer", room, event_id(0), now));
        assert!(!ceiling.admit("signer", room, event_id(RELAYED_POSTS_PER_MINUTE), now));
    }

    #[test]
    fn the_ceiling_keeps_a_bounded_number_of_counts() {
        let mut ceiling = RelayedPostCeiling::default();
        let now = Instant::now();
        for _ in 0..(MAX_CEILING_KEYS + 16) {
            ceiling.admit("signer", Uuid::new_v4(), event_id(0), now);
        }
        assert_eq!(ceiling.windows.len(), MAX_CEILING_KEYS);
    }
}

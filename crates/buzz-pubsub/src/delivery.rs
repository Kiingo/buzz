//! One ordered replay cursor for events, cache drops and connection control.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use nostr::JsonUtil;
use redis::aio::MultiplexedConnection;
use tokio::sync::{broadcast, mpsc};

use crate::cache_invalidation::{
    parse_cache_invalidation_channel, ScopedCacheInvalidation, CACHE_INVALIDATION_PATTERN,
};
use crate::conn_control::{parse_conn_control_channel, ScopedConnControl, CONN_CONTROL_PATTERN};
use crate::subscriber::{DesiredTopics, SubscriptionCommand};
use crate::topic::EventTopicKey;
use crate::transport::{self, Position, MODERN_PREFIX};
use crate::{ChannelEvent, PubSubError};

pub(crate) struct Destinations {
    pub(crate) events: broadcast::Sender<ChannelEvent>,
    pub(crate) cache: broadcast::Sender<ScopedCacheInvalidation>,
    pub(crate) control: broadcast::Sender<ScopedConnControl>,
    pub(crate) continuity: Arc<AtomicBool>,
    pub(crate) requalify: Arc<RwLock<Option<crate::SecurityRequalification>>>,
}

struct Cursor {
    epoch: String,
    position: Position,
    unbuffered: u64,
    coverage_lost: bool,
}

fn unavailable(destinations: &Destinations) {
    destinations.continuity.store(false, Ordering::Release);
    metrics::gauge!("buzz_transport_caught_up").set(0);
    metrics::gauge!("buzz_transport_connected").set(0);
}

fn requalify(destinations: &Destinations) {
    if let Some(callback) = destinations
        .requalify
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        callback();
    }
}

fn coverage_lost(destinations: &Destinations, cursor: &mut Cursor) {
    if !cursor.coverage_lost {
        cursor.coverage_lost = true;
        metrics::counter!("buzz_transport_retention_gap_total").increment(1);
        requalify(destinations);
        tracing::error!(
            "Redis replay coverage lost; live delivery continues, lossless handover disqualified"
        );
    }
    destinations.continuity.store(false, Ordering::Release);
    metrics::gauge!("buzz_transport_caught_up").set(0);
    metrics::gauge!("buzz_transport_coverage_lost").set(1);
}

pub(crate) async fn run(
    redis_url: String,
    destinations: Destinations,
    desired: DesiredTopics,
    mut commands: mpsc::Receiver<SubscriptionCommand>,
) {
    metrics::gauge!("buzz_transport_coverage_lost").set(0);
    for name in [
        "buzz_transport_retention_gap_total",
        "buzz_transport_invalid_messages_total",
    ] {
        metrics::counter!(name).increment(0);
    }
    let mut cursor = None;
    let mut backoff = 1;
    loop {
        unavailable(&destinations);
        let result = connected(
            &redis_url,
            &destinations,
            &desired,
            &mut commands,
            &mut cursor,
        )
        .await;
        unavailable(&destinations);
        if let Err(error) = result {
            tracing::warn!(error = %error, "Redis transport reconnect required");
        } else {
            backoff = 1;
        }
        metrics::counter!("buzz_transport_reconnect_total").increment(1);
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}

async fn route(
    channel: &str,
    payload: &str,
    destinations: &Destinations,
    desired: &DesiredTopics,
) -> Result<(), PubSubError> {
    if let Some(community_id) = parse_cache_invalidation_channel(channel) {
        let invalidation = serde_json::from_str(payload)?;
        let _ = destinations.cache.send(ScopedCacheInvalidation {
            community_id,
            invalidation,
        });
    } else if let Some(community_id) = parse_conn_control_channel(channel) {
        let command = serde_json::from_str(payload)?;
        let _ = destinations.control.send(ScopedConnControl {
            community_id,
            command,
        });
    } else {
        let topic =
            EventTopicKey::parse_redis_channel(channel).map_err(|_| PubSubError::ReplayGap)?;
        if desired.lock().await.get(&topic).copied().unwrap_or(0) == 0 {
            return Ok(());
        }
        let event = nostr::Event::from_json(payload).map_err(|_| PubSubError::ReplayGap)?;
        // The existing relay consumer still checks tenant identity, filters,
        // current private-channel access and author-private visibility.
        let _ = destinations.events.send(ChannelEvent {
            community_id: topic.community_id,
            topic: topic.topic,
            event,
        });
    }
    Ok(())
}

async fn route_valid(
    channel: &str,
    payload: &str,
    destinations: &Destinations,
    desired: &DesiredTopics,
) {
    // Keep the original per-category skip/log behavior. A malformed legacy
    // message cannot poison one retained cursor or stop unrelated categories.
    if let Err(error) = route(channel, payload, destinations, desired).await {
        metrics::counter!("buzz_transport_invalid_messages_total").increment(1);
        tracing::warn!(error = %error, "Skipping malformed Redis publication");
    }
}

async fn catch_up(
    connection: &mut MultiplexedConnection,
    destinations: &Destinations,
    desired: &DesiredTopics,
    cursor: &mut Cursor,
) -> Result<bool, PubSubError> {
    if cursor.coverage_lost {
        // Preserve the last covered cursor/epoch for diagnostics. Do not call a
        // jump to today's tail recovered history, and do not strand live fans.
        return Ok(false);
    }
    let page = transport::read(connection, cursor.position).await?;
    if cursor.epoch.is_empty()
        && cursor.position == Position(0, 0)
        && page.trimmed == Position(0, 0)
    {
        // Before the first modern publish there is no retained epoch to lose.
        cursor.epoch.clone_from(&page.epoch);
    }
    if cursor.epoch != page.epoch
        || cursor.position < page.trimmed
        || cursor.position > page.last
        || cursor.unbuffered != page.unbuffered
    {
        coverage_lost(destinations, cursor);
        return Ok(false);
    }
    let returned = page.rows.ids.len();
    for entry in page.rows.ids {
        let position = match Position::parse(&entry.id) {
            Ok(position) => position,
            Err(_) => {
                coverage_lost(destinations, cursor);
                return Ok(false);
            }
        };
        if position <= cursor.position || position > page.last {
            coverage_lost(destinations, cursor);
            return Ok(false);
        }
        let (Some(channel), Some(payload)): (Option<String>, Option<String>) =
            (entry.get("channel"), entry.get("payload"))
        else {
            coverage_lost(destinations, cursor);
            return Ok(false);
        };
        let Some(expires): Option<u64> = entry.get("expires") else {
            coverage_lost(destinations, cursor);
            return Ok(false);
        };
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        if expires == 0 || u128::from(expires) > now_ms {
            route_valid(&channel, &payload, destinations, desired).await;
        }
        cursor.position = position;
        metrics::counter!("buzz_transport_replay_messages_total").increment(1);
    }
    if returned < 128 {
        // A deletion-fenced community erases only its payload records. The
        // atomic page proves no surviving row remains through this tail,
        // including a deleted tail; advance over holes without inventing loss.
        cursor.position = page.last;
    }
    let behind = cursor.position < page.last;
    metrics::gauge!("buzz_transport_cursor_milliseconds").set(cursor.position.0 as f64);
    metrics::gauge!("buzz_transport_tail_milliseconds").set(page.last.0 as f64);
    destinations.continuity.store(!behind, Ordering::Release);
    metrics::gauge!("buzz_transport_caught_up").set(if behind { 0 } else { 1 });
    metrics::gauge!("buzz_transport_unbuffered_total").set(page.unbuffered as f64);
    metrics::gauge!("buzz_transport_event_buffer_messages").set(destinations.events.len() as f64);
    metrics::gauge!("buzz_transport_cache_buffer_messages").set(destinations.cache.len() as f64);
    metrics::gauge!("buzz_transport_control_buffer_messages")
        .set(destinations.control.len() as f64);
    metrics::gauge!("buzz_transport_observed_at_seconds").set(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64(),
    );
    Ok(behind)
}

async fn connected(
    redis_url: &str,
    destinations: &Destinations,
    desired: &DesiredTopics,
    commands: &mut mpsc::Receiver<SubscriptionCommand>,
    cursor: &mut Option<Cursor>,
) -> Result<(), PubSubError> {
    let client = redis::Client::open(redis_url)?;
    let mut reader = client.get_multiplexed_async_connection().await?;
    if cursor.is_none() {
        // Capture the boundary before subscribing, then recover the race after
        // the subscription acknowledgements. Reconnects keep this exact cursor.
        let initial = transport::read(&mut reader, Position(0, 0)).await?;
        *cursor = Some(Cursor {
            epoch: initial.epoch,
            position: initial.last,
            unbuffered: initial.unbuffered,
            coverage_lost: false,
        });
    }

    requalify(destinations);
    let cursor = cursor.as_mut().ok_or(PubSubError::ReplayGap)?;
    let pubsub = client.get_async_pubsub().await?;
    let (mut sink, mut stream) = pubsub.split();
    sink.psubscribe(&[
        CACHE_INVALIDATION_PATTERN.to_string(),
        transport::modern_channel(CACHE_INVALIDATION_PATTERN),
        CONN_CONTROL_PATTERN.to_string(),
        transport::modern_channel(CONN_CONTROL_PATTERN),
    ])
    .await?;
    let mut active = HashSet::new();
    let initial_topics: Vec<_> = desired
        .lock()
        .await
        .iter()
        .filter_map(|(topic, count)| (*count > 0).then_some(*topic))
        .collect();
    for topic in initial_topics {
        let legacy = topic.redis_channel();
        sink.subscribe(&[legacy.clone(), transport::modern_channel(&legacy)])
            .await?;
        active.insert(legacy);
    }
    metrics::gauge!("buzz_transport_connected").set(1);

    let mut behind = catch_up(&mut reader, destinations, desired, cursor).await?;
    let mut pending_legacy: Option<(String, String)> = None;
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut idle_ticks = 0;
    loop {
        tokio::select! {
            Some(command) = commands.recv() => {
                match command {
                    SubscriptionCommand::Subscribe(topic) => {
                        let legacy = topic.redis_channel();
                        if active.insert(legacy.clone()) {
                            // One Redis SUBSCRIBE makes both forms active atomically.
                            sink.subscribe(&[legacy.clone(), transport::modern_channel(&legacy)]).await?;
                        }
                    }
                    SubscriptionCommand::UnsubscribeIfIdle(topic) => {
                        if desired.lock().await.get(&topic).copied().unwrap_or(0) == 0 {
                            let legacy = topic.redis_channel();
                            if active.remove(&legacy) {
                                sink.unsubscribe(&[legacy.clone(), transport::modern_channel(&legacy)]).await?;
                            }
                        }
                    }
                }
            }
            message = stream.next() => {
                let Some(message) = message else { return Ok(()) };
                let channel = message.get_channel_name();
                let payload: String = match message.get_payload() {
                    Ok(payload) => payload,
                    Err(error) => {
                        metrics::counter!("buzz_transport_invalid_messages_total").increment(1);
                        tracing::warn!(error = %error, "Skipping invalid Redis payload encoding");
                        pending_legacy = None;
                        continue;
                    }
                };
                if let Some(legacy) = channel.strip_prefix(MODERN_PREFIX) {
                    let (id, original): (String, String) = match serde_json::from_str(&payload) {
                        Ok(notification) => notification,
                        Err(error) => {
                            metrics::counter!("buzz_transport_invalid_messages_total").increment(1);
                            tracing::warn!(error = %error, "Skipping malformed Redis transport notification");
                            pending_legacy = None;
                            continue;
                        }
                    };
                    if Position::parse(&id).is_err() {
                        coverage_lost(destinations, cursor);
                    }
                    // Catch-up may already have passed this notification. The
                    // cursor suppresses stream replay; its immediately following
                    // legacy echo is still paired and suppressed exactly once.
                    pending_legacy = Some((legacy.to_string(), original.clone()));
                    behind = catch_up(&mut reader, destinations, desired, cursor).await?;
                    if cursor.coverage_lost {
                        route_valid(legacy, &original, destinations, desired).await;
                    }
                } else {
                    let paired = pending_legacy.take().is_some_and(|(expected_channel, expected)| {
                        expected_channel == channel && expected == payload
                    });
                    if !paired {
                        route_valid(channel, &payload, destinations, desired).await;
                        metrics::counter!("buzz_transport_legacy_messages_total").increment(1);
                    }
                }
            }
            _ = tick.tick() => {
                idle_ticks += 1;
                if behind || idle_ticks >= 10 {
                    behind = catch_up(&mut reader, destinations, desired, cursor).await?;
                    idle_ticks = 0;
                }
            }
        }
    }
}

//! Event publishing — PUBLISH to Redis via pool connection.

use buzz_core::TenantContext;
use deadpool_redis::Pool;
use nostr::JsonUtil;
use uuid::Uuid;

use crate::error::PubSubError;
use crate::topic::{self, EventTopic};

/// Returns the Redis pub/sub channel key for `channel_id` under `ctx`.
pub fn channel_key(ctx: &TenantContext, channel_id: Uuid) -> String {
    topic::channel_key(ctx, channel_id)
}

/// Returns the Redis pub/sub channel key for community-global events under `ctx`.
pub fn global_key(ctx: &TenantContext) -> String {
    topic::global_key(ctx)
}

/// Returns the number of subscribers that received the message.
pub async fn publish_event(
    pool: &Pool,
    ctx: &TenantContext,
    topic: EventTopic,
    event: &nostr::Event,
) -> Result<i64, PubSubError> {
    let key = crate::topic::EventTopicKey::from_context(ctx, topic).redis_channel();
    let payload = event.as_json();
    // Preserve the publisher's existing live delivery of credential kinds, but
    // never retain their bearer material in transport history. The durable
    // counter disqualifies a handover that would need to replay one of them.
    if matches!(event.kind.as_u16(), 22242 | 24242 | 27235) {
        return crate::transport::publish_unbuffered(pool, &key, &payload).await;
    }
    let replay_ttl_ms = match u32::from(event.kind.as_u16()) {
        buzz_core::kind::KIND_TYPING_INDICATOR => 8_000,
        buzz_core::kind::KIND_PRESENCE_UPDATE => 180_000,
        _ => 0,
    };
    crate::transport::publish_with_ttl(pool, &key, &payload, replay_ttl_ms).await
}

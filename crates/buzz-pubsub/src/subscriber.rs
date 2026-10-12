//! Desired subscription state retained by the ordered Redis transport.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::topic::EventTopicKey;

/// Local desired topic refcounts, keyed by fully scoped Redis topic.
pub(crate) type DesiredTopics = Arc<Mutex<HashMap<EventTopicKey, usize>>>;

/// Commands sent from relay subscription registration/removal to the Redis
/// pub/sub task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubscriptionCommand {
    /// Ensure the topic is subscribed on the current Redis pub/sub connection.
    Subscribe(EventTopicKey),
    /// Unsubscribe only if the desired refcount is still zero when processed.
    UnsubscribeIfIdle(EventTopicKey),
}

#[cfg(test)]
async fn desired_refcount(desired_topics: &DesiredTopics, topic: EventTopicKey) -> usize {
    desired_topics
        .lock()
        .await
        .get(&topic)
        .copied()
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::{CommunityId, TenantContext};
    use uuid::Uuid;

    fn topic(id: u128) -> EventTopicKey {
        let ctx = TenantContext::resolved(CommunityId::from_uuid(Uuid::from_u128(id)), "test");
        EventTopicKey::from_context(&ctx, crate::EventTopic::Global)
    }

    #[tokio::test]
    async fn desired_refcount_returns_zero_for_absent_topic() {
        let desired = Arc::new(Mutex::new(HashMap::new()));
        assert_eq!(desired_refcount(&desired, topic(1)).await, 0);
    }

    #[tokio::test]
    async fn desired_refcount_reads_present_topic() {
        let desired = Arc::new(Mutex::new(HashMap::from([(topic(1), 3)])));
        assert_eq!(desired_refcount(&desired, topic(1)).await, 3);
    }
}

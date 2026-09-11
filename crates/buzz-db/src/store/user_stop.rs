//! Original signed Stop commands retained as control evidence independently of
//! chat retention. The event-table trigger captures them in the same transaction;
//! this module never invents a receipt, acknowledgement, or terminal outcome.

use buzz_core::{CommunityId, StoredEvent};
use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::{Db, DbError, Result};

impl Db {
    /// Read original Stop commands for one exact channel/author/thread scope.
    ///
    /// This correctness read always uses the writer. Callers must separately
    /// authorize the reader's current channel access, verify the original
    /// signature and current requester binding, and admit cancellation through
    /// their ordinary transaction. An empty result never completes a discussion.
    /// Only control evidence is returned; normal event queries still honor chat
    /// deletion. Fixed request bounds do not cap retries or discussion lifetime.
    pub async fn query_user_stop_events(
        &self,
        community: CommunityId,
        channel: Uuid,
        author: &[u8; 32],
        roots: &[Vec<u8>],
        since: DateTime<Utc>,
        limit: u16,
    ) -> Result<Vec<StoredEvent>> {
        if roots.is_empty()
            || roots.len() > 2
            || roots.iter().any(|id| id.len() != 32)
            || !(1..=16).contains(&limit)
        {
            return Err(DbError::InvalidData("invalid Stop query scope".into()));
        }
        let rows = sqlx::query(
            "SELECT id, pubkey, created_at, kind, tags, content, sig, received_at, channel_id \
             FROM user_stop_events \
             WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3 \
               AND root_event_id = ANY($4) AND created_at >= $5 \
             ORDER BY created_at DESC, id LIMIT $6",
        )
        .bind(community.as_uuid())
        .bind(channel)
        .bind(author.as_slice())
        .bind(roots)
        .bind(since)
        .bind(i64::from(limit))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                crate::event::row_to_stored_event(row)?
                    .ok_or_else(|| DbError::InvalidData("invalid retained Stop event".into()))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests;

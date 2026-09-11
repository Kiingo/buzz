//! Writer-only commit-ordered channel input reads. A cursor is relay metadata,
//! not signed author data, an acknowledgement, or permission to execute work.

use buzz_core::{CommunityId, StoredEvent};
use sqlx::Row;
use uuid::Uuid;

use crate::{Db, DbError, Result};

/// One original event with its exact, channel-scoped committed input position.
pub struct SequencedChannelEvent {
    /// Positive decimal integer; never convert a lifetime cursor to a float.
    pub sequence: String,
    /// The original signed event, unchanged by sequence assignment.
    pub stored: StoredEvent,
}

/// Canonical nonnegative decimal cursor. Input/body limits apply at transport;
/// this parser does not impose an artificial event-count ceiling.
pub fn valid_channel_sequence(value: &str) -> bool {
    value == "0"
        || (value.starts_with(|c: char| matches!(c, '1'..='9'))
            && value.bytes().all(|c| c.is_ascii_digit()))
}

impl Db {
    /// Read a bounded prefix after one channel's durable cursor on the writer.
    ///
    /// Callers must authorize current channel access and durably accept each
    /// event before saving its sequence. A crash/ambiguous acknowledgement must
    /// retry the original event identity. Deletions retain normal visibility;
    /// history predating this sequence contract is not newly submitted input.
    pub async fn query_channel_event_sequence(
        &self,
        community: CommunityId,
        channel: Uuid,
        after: &str,
        limit: u16,
    ) -> Result<Vec<SequencedChannelEvent>> {
        if !valid_channel_sequence(after) || !(1..=64).contains(&limit) {
            return Err(DbError::InvalidData(
                "invalid channel sequence query".into(),
            ));
        }
        let rows = sqlx::query(
            "SELECT id, pubkey, created_at, kind, tags, content, sig, received_at, channel_id, \
                    channel_sequence::text AS input_sequence \
             FROM events WHERE community_id = $1 AND channel_id = $2 AND kind = 9 \
               AND channel_sequence > $3::text::numeric AND deleted_at IS NULL \
             ORDER BY channel_sequence LIMIT $4",
        )
        .bind(community.as_uuid())
        .bind(channel)
        .bind(after)
        .bind(i64::from(limit))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                let sequence: String = row.try_get("input_sequence")?;
                let stored = crate::event::row_to_stored_event(row)?
                    .ok_or_else(|| DbError::InvalidData("invalid sequenced event".into()))?;
                Ok(SequencedChannelEvent { sequence, stored })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests;

//! Reads and writes for creator-admitted huddle backing channels.
//!
//! A backing channel is creator-admitted when the kind:9007 that created it
//! carries the admission mark. The mark lives on that stored creation event,
//! so it can never change after creation; these helpers only read it, plus the
//! membership facts creator-only admission depends on.

use buzz_core::CommunityId;
use buzz_datastore_tracing::datastore_span;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::Result;
use crate::Db;

/// kind:9007, the event whose tags carry the admission mark.
const KIND_CREATE_GROUP: i32 = 9007;
/// kind:9000, the creator's explicit member put.
const KIND_PUT_USER: i32 = 9000;
/// Upper bound on the creator puts read for one roster snapshot.
const CREATOR_PUT_SCAN_LIMIT: i64 = 1000;

/// Tags of the kind:9007 that `creator` signed to create `channel_id`.
///
/// Soft-deleted rows count too: deleting the creation event must not clear
/// the mark. Returns `None` when no such creation event was stored.
pub async fn creation_event_tags(
    pool: &PgPool,
    community_id: CommunityId,
    channel_id: Uuid,
    creator: &[u8],
) -> Result<Option<serde_json::Value>> {
    let mut connection = crate::observability::acquire_writer(
        pool,
        crate::observability::WriterOperation::Authorization,
    )
    .await?;
    Ok(sqlx::query_scalar(
        "SELECT tags FROM events \
         WHERE community_id = $1 AND channel_id = $2 AND kind = $3 AND pubkey = $4 \
         ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .bind(KIND_CREATE_GROUP)
    .bind(creator)
    .fetch_optional(&mut *connection)
    .await?)
}

/// `invited_by` of `pubkey`'s active membership in `channel_id`.
///
/// `None` when there is no active membership; `Some(None)` when the active
/// row has no recorded inviter.
pub async fn active_member_inviter(
    pool: &PgPool,
    community_id: CommunityId,
    channel_id: Uuid,
    pubkey: &[u8],
) -> Result<Option<Option<Vec<u8>>>> {
    let mut connection = crate::observability::acquire_writer(
        pool,
        crate::observability::WriterOperation::Authorization,
    )
    .await?;
    Ok(sqlx::query_scalar(
        "SELECT invited_by FROM channel_members \
         WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3 AND removed_at IS NULL",
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .bind(pubkey)
    .fetch_optional(&mut *connection)
    .await?)
}

/// Record `inviter` as the inviter of `pubkey`'s active membership.
///
/// The relay calls this with the signer of an accepted creator put, so a
/// reactivated row never keeps an inviter from an earlier, different add.
pub async fn stamp_active_member_inviter(
    pool: &PgPool,
    community_id: CommunityId,
    channel_id: Uuid,
    pubkey: &[u8],
    inviter: &[u8],
) -> Result<bool> {
    let mut connection = crate::observability::acquire_writer(
        pool,
        crate::observability::WriterOperation::EventWrite,
    )
    .await?;
    let result = sqlx::query(
        "UPDATE channel_members SET invited_by = $4 \
         WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3 AND removed_at IS NULL",
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .bind(pubkey)
    .bind(inviter)
    .execute(&mut *connection)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Tags of the live kind:9000 events `creator` signed in `channel_id`, newest
/// first.
pub async fn creator_put_tags(
    pool: &PgPool,
    community_id: CommunityId,
    channel_id: Uuid,
    creator: &[u8],
) -> Result<Vec<serde_json::Value>> {
    let mut connection = crate::observability::acquire_writer(
        pool,
        crate::observability::WriterOperation::Authorization,
    )
    .await?;
    Ok(sqlx::query_scalar(
        "SELECT tags FROM events \
         WHERE community_id = $1 AND channel_id = $2 AND kind = $3 AND pubkey = $4 \
           AND deleted_at IS NULL \
         ORDER BY created_at DESC, id ASC LIMIT $5",
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .bind(KIND_PUT_USER)
    .bind(creator)
    .bind(CREATOR_PUT_SCAN_LIMIT)
    .fetch_all(&mut *connection)
    .await?)
}

impl Db {
    /// See [`creation_event_tags`].
    #[datastore_span(name = "huddle_creation_event_tags", system = "postgresql")]
    pub async fn huddle_creation_event_tags(
        &self,
        community_id: CommunityId,
        channel_id: Uuid,
        creator: &[u8],
    ) -> Result<Option<serde_json::Value>> {
        creation_event_tags(&self.pool, community_id, channel_id, creator).await
    }

    /// See [`active_member_inviter`].
    #[datastore_span(name = "huddle_active_member_inviter", system = "postgresql")]
    pub async fn huddle_active_member_inviter(
        &self,
        community_id: CommunityId,
        channel_id: Uuid,
        pubkey: &[u8],
    ) -> Result<Option<Option<Vec<u8>>>> {
        active_member_inviter(&self.pool, community_id, channel_id, pubkey).await
    }

    /// See [`stamp_active_member_inviter`].
    #[datastore_span(name = "huddle_stamp_active_member_inviter", system = "postgresql")]
    pub async fn huddle_stamp_active_member_inviter(
        &self,
        community_id: CommunityId,
        channel_id: Uuid,
        pubkey: &[u8],
        inviter: &[u8],
    ) -> Result<bool> {
        stamp_active_member_inviter(&self.pool, community_id, channel_id, pubkey, inviter).await
    }

    /// See [`creator_put_tags`].
    #[datastore_span(name = "huddle_creator_put_tags", system = "postgresql")]
    pub async fn huddle_creator_put_tags(
        &self,
        community_id: CommunityId,
        channel_id: Uuid,
        creator: &[u8],
    ) -> Result<Vec<serde_json::Value>> {
        creator_put_tags(&self.pool, community_id, channel_id, creator).await
    }
}

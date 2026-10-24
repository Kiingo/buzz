//! Reads and writes for creator-admitted huddle backing channels.
//!
//! A backing channel is creator-admitted when the kind:9007 that created it
//! carries the admission mark. The mark lives on that stored creation event,
//! so it can never change after creation; these helpers only read it, plus the
//! membership facts creator-only admission depends on.
//!
//! The writes serve huddle service identities, which run creator-admitted
//! huddles without being channel members: creating a backing channel with no
//! member row, putting and removing members on channels the service created,
//! and counting its huddle start and end notices.

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

/// Count of `service`'s kind `kind` huddle lifecycle events in
/// `parent_channel_id` that name `backing_channel_id`, soft-deleted or not.
pub async fn service_lifecycle_count(
    pool: &PgPool,
    community_id: CommunityId,
    parent_channel_id: Uuid,
    backing_channel_id: Uuid,
    kind: i32,
    service: &[u8],
) -> Result<i64> {
    let mut connection = crate::observability::acquire_writer(
        pool,
        crate::observability::WriterOperation::Authorization,
    )
    .await?;
    Ok(sqlx::query_scalar(
        "SELECT COUNT(*) FROM events \
         WHERE community_id = $1 AND channel_id = $2 AND kind = $3 AND pubkey = $4 \
           AND content ILIKE $5",
    )
    .bind(community_id.as_uuid())
    .bind(parent_channel_id)
    .bind(kind)
    .bind(service)
    .bind(format!("%{backing_channel_id}%"))
    .fetch_one(&mut *connection)
    .await?)
}

/// Create a huddle service's backing channel: the channel row only, with no
/// member row for the service. Returns whether it was created.
#[allow(clippy::too_many_arguments)]
pub async fn create_service_channel(
    pool: &PgPool,
    community_id: CommunityId,
    channel_id: Uuid,
    name: &str,
    channel_type: &str,
    visibility: &str,
    service: &[u8],
    ttl_seconds: i32,
) -> Result<bool> {
    let name = buzz_core::channel::canonical_channel_name(name);
    if name.trim().is_empty() || channel_id.is_nil() {
        return Err(crate::error::DbError::InvalidData(
            "a backing channel needs a name and an id".into(),
        ));
    }
    let mut connection = crate::observability::acquire_writer(
        pool,
        crate::observability::WriterOperation::EventWrite,
    )
    .await?;
    let created = sqlx::query(
        "INSERT INTO channels \
           (id, community_id, name, channel_type, visibility, created_by, ttl_seconds, ttl_deadline) \
         VALUES ($1, $2, $3, $4::channel_type, $5::channel_visibility, $6, $7, \
                 NOW() + ($7 || ' seconds')::interval) \
         ON CONFLICT (community_id, id) DO NOTHING",
    )
    .bind(channel_id)
    .bind(community_id.as_uuid())
    .bind(name)
    .bind(channel_type)
    .bind(visibility)
    .bind(service)
    .bind(ttl_seconds)
    .execute(&mut *connection)
    .await?
    .rows_affected();
    Ok(created > 0)
}

/// A huddle service's put: make `pubkey` an active ordinary member of the
/// service's backing channel with the service as its inviter, under the
/// channel's membership lock. Clears any earlier removal.
pub async fn service_put_member(
    pool: &PgPool,
    community_id: CommunityId,
    channel_id: Uuid,
    pubkey: &[u8],
    service: &[u8],
) -> Result<()> {
    let mut tx = crate::begin_community_write_transaction(
        pool,
        community_id,
        crate::observability::WriterOperation::EventWrite,
    )
    .await?;
    crate::channel_members::acquire_channel_membership_lock(tx.conn(), community_id, channel_id)
        .await?;
    sqlx::query(
        "INSERT INTO channel_members (community_id, channel_id, pubkey, role, invited_by) \
         VALUES ($1, $2, $3, 'member'::member_role, $4) \
         ON CONFLICT (community_id, channel_id, pubkey) DO UPDATE SET \
           removed_at = NULL, removed_by = NULL, role = EXCLUDED.role, \
           invited_by = EXCLUDED.invited_by",
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .bind(pubkey)
    .bind(service)
    .execute(tx.conn())
    .await?;
    tx.commit().await?;
    Ok(())
}

/// A huddle service's removal of `pubkey` from its backing channel, under the
/// channel's membership lock. Returns whether an active row was removed.
pub async fn service_remove_member(
    pool: &PgPool,
    community_id: CommunityId,
    channel_id: Uuid,
    pubkey: &[u8],
    service: &[u8],
) -> Result<bool> {
    let mut tx = crate::begin_community_write_transaction(
        pool,
        community_id,
        crate::observability::WriterOperation::EventWrite,
    )
    .await?;
    crate::channel_members::acquire_channel_membership_lock(tx.conn(), community_id, channel_id)
        .await?;
    let removed = sqlx::query(
        "UPDATE channel_members SET removed_at = NOW(), removed_by = $4 \
         WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3 AND removed_at IS NULL",
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .bind(pubkey)
    .bind(service)
    .execute(tx.conn())
    .await?
    .rows_affected();
    tx.commit().await?;
    Ok(removed > 0)
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

    /// See [`service_lifecycle_count`].
    #[datastore_span(name = "huddle_service_lifecycle_count", system = "postgresql")]
    pub async fn huddle_service_lifecycle_count(
        &self,
        community_id: CommunityId,
        parent_channel_id: Uuid,
        backing_channel_id: Uuid,
        kind: i32,
        service: &[u8],
    ) -> Result<i64> {
        service_lifecycle_count(
            &self.pool,
            community_id,
            parent_channel_id,
            backing_channel_id,
            kind,
            service,
        )
        .await
    }

    /// See [`create_service_channel`].
    #[allow(clippy::too_many_arguments)]
    #[datastore_span(name = "huddle_create_service_channel", system = "postgresql")]
    pub async fn huddle_create_service_channel(
        &self,
        community_id: CommunityId,
        channel_id: Uuid,
        name: &str,
        channel_type: &str,
        visibility: &str,
        service: &[u8],
        ttl_seconds: i32,
    ) -> Result<bool> {
        create_service_channel(
            &self.pool,
            community_id,
            channel_id,
            name,
            channel_type,
            visibility,
            service,
            ttl_seconds,
        )
        .await
    }

    /// See [`service_put_member`].
    #[datastore_span(name = "huddle_service_put_member", system = "postgresql")]
    pub async fn huddle_service_put_member(
        &self,
        community_id: CommunityId,
        channel_id: Uuid,
        pubkey: &[u8],
        service: &[u8],
    ) -> Result<()> {
        service_put_member(&self.pool, community_id, channel_id, pubkey, service).await
    }

    /// See [`service_remove_member`].
    #[datastore_span(name = "huddle_service_remove_member", system = "postgresql")]
    pub async fn huddle_service_remove_member(
        &self,
        community_id: CommunityId,
        channel_id: Uuid,
        pubkey: &[u8],
        service: &[u8],
    ) -> Result<bool> {
        service_remove_member(&self.pool, community_id, channel_id, pubkey, service).await
    }
}

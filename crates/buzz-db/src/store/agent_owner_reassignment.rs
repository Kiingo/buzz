//! Guarded reassignment of an agent's recorded owner after an owner-key
//! rotation.
//!
//! `users.agent_owner_pubkey` is first-write-wins: a NIP-OA owner link is
//! recorded once and never overwritten by an ordinary authentication. When a
//! human rotates their key, their agents keep pointing at the retired key, so
//! every owner-gated relay feature (observer frames, owner removal rights, the
//! ban cascade, live revocation) stays with a key nobody uses any more.
//!
//! This module moves the link from the stored owner (`previous`) to a new
//! owner only when all of these hold, checked under row locks in one
//! community write transaction:
//!
//! 1. the caller verified a NIP-OA `auth` tag for the agent signed by `new`
//!    (the relay does this before calling; this module never sees the tag);
//! 2. `new` is a current relay member;
//! 3. `previous` is no longer a relay member;
//! 4. the relay holds signed rotation evidence linking `previous` to `new`:
//!    a NIP-IA archive of `previous` with `replaced-by = new`, either signed by
//!    `previous` itself (`consent_path = 'self'`, `actor = previous`) or by a
//!    relay owner/admin the relay already trusts for this community
//!    (`consent_path = 'admin'`). An archive authorized only through NIP-OA
//!    (`'owner'`) is not evidence about a human key and is refused.
//!
//! Membership alone never moves an owner. Every reassignment writes an
//! `agent_owner_reassignments` row (agent, both keys, evidence) in the same
//! transaction as the update, so the record and the change commit together.
//!
//! A concurrent re-admission of `previous` after the check is not a safety
//! problem: the transfer rests on the signed statement that `previous` was
//! replaced by `new`, which re-admission does not withdraw. `new`'s membership
//! row and the archive row are locked `FOR SHARE`, so neither can be removed
//! while the decision is being made.

use buzz_core::CommunityId;
use buzz_datastore_tracing::datastore_span;
use chrono::{DateTime, Utc};
use sqlx::Row as _;
use uuid::Uuid;

use crate::error::{DbError, Result};
use crate::Db;

/// Which signed record proved that the previous owner key was rotated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerRotationEvidence {
    /// NIP-IA archive of the previous key signed by that key itself.
    SelfSignedArchive,
    /// NIP-IA archive of the previous key signed by a relay owner or admin.
    AdminArchive,
}

impl OwnerRotationEvidence {
    /// Stable value stored in `agent_owner_reassignments.evidence`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SelfSignedArchive => "nip_ia_self",
            Self::AdminArchive => "nip_ia_admin",
        }
    }
}

/// One committed owner reassignment and the evidence it rests on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentOwnerReassignment {
    /// Audit row id.
    pub id: Uuid,
    /// Agent whose owner changed (32 bytes).
    pub agent_pubkey: Vec<u8>,
    /// Owner recorded before the change (32 bytes).
    pub previous_owner_pubkey: Vec<u8>,
    /// Owner recorded now (32 bytes).
    pub new_owner_pubkey: Vec<u8>,
    /// Kind of rotation evidence.
    pub evidence: OwnerRotationEvidence,
    /// Hex signer of the archive request.
    pub archive_actor: String,
    /// Hex id of the archive request event.
    pub archive_request_event_id: String,
    /// When the previous key was archived.
    pub archived_at: DateTime<Utc>,
}

/// Why a reassignment was refused. Nothing was written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerReassignmentRefusal {
    /// The agent has no recorded owner; the first-write path applies instead.
    NoRecordedOwner,
    /// The agent is already recorded under the new owner.
    AlreadyOwned,
    /// The new owner is the agent itself.
    SelfOwnership,
    /// The new owner is not a current relay member.
    NewOwnerNotMember,
    /// The recorded owner is still a relay member.
    PreviousOwnerStillMember,
    /// No signed rotation evidence links the recorded owner to the new one.
    NoRotationEvidence,
}

/// Outcome of [`Db::reassign_agent_owner_after_rotation`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnerReassignmentOutcome {
    /// The owner moved; the audit row was written in the same transaction.
    Reassigned(AgentOwnerReassignment),
    /// The owner did not move.
    Refused(OwnerReassignmentRefusal),
}

/// Classify one archive row as rotation evidence for `previous_hex`.
fn rotation_evidence(
    consent_path: &str,
    actor: &str,
    previous_hex: &str,
) -> Option<OwnerRotationEvidence> {
    match consent_path {
        "self" if actor == previous_hex => Some(OwnerRotationEvidence::SelfSignedArchive),
        "admin" => Some(OwnerRotationEvidence::AdminArchive),
        _ => None,
    }
}

/// See the module documentation. `agent_pubkey` and `new_owner_pubkey` are
/// 32 raw bytes; the caller has already verified a NIP-OA tag from the new
/// owner for this agent.
pub async fn reassign_agent_owner_after_rotation(
    pool: &sqlx::PgPool,
    community_id: CommunityId,
    agent_pubkey: &[u8],
    new_owner_pubkey: &[u8],
) -> Result<OwnerReassignmentOutcome> {
    if agent_pubkey.len() != 32 || new_owner_pubkey.len() != 32 {
        return Err(DbError::InvalidData(
            "agent and owner pubkeys must be 32 bytes".into(),
        ));
    }
    if agent_pubkey == new_owner_pubkey {
        return Ok(OwnerReassignmentOutcome::Refused(
            OwnerReassignmentRefusal::SelfOwnership,
        ));
    }
    let mut tx = crate::begin_community_write_transaction(
        pool,
        community_id,
        crate::observability::WriterOperation::Authorization,
    )
    .await?;
    let community = community_id.as_uuid();

    let row = sqlx::query(
        "SELECT agent_owner_pubkey FROM users \
         WHERE community_id = $1 AND pubkey = $2 FOR UPDATE",
    )
    .bind(community)
    .bind(agent_pubkey)
    .fetch_optional(tx.conn())
    .await?
    .ok_or_else(|| DbError::NotFound("agent pubkey not found in users table".into()))?;
    let previous: Option<Vec<u8>> = row.try_get("agent_owner_pubkey")?;
    let Some(previous) = previous else {
        return Ok(OwnerReassignmentOutcome::Refused(
            OwnerReassignmentRefusal::NoRecordedOwner,
        ));
    };
    if previous == new_owner_pubkey {
        return Ok(OwnerReassignmentOutcome::Refused(
            OwnerReassignmentRefusal::AlreadyOwned,
        ));
    }
    let previous_hex = hex::encode(&previous);
    let new_hex = hex::encode(new_owner_pubkey);

    let new_is_member = sqlx::query(
        "SELECT 1 FROM relay_members WHERE community_id = $1 AND pubkey = $2 FOR SHARE",
    )
    .bind(community)
    .bind(&new_hex)
    .fetch_optional(tx.conn())
    .await?
    .is_some();
    if !new_is_member {
        return Ok(OwnerReassignmentOutcome::Refused(
            OwnerReassignmentRefusal::NewOwnerNotMember,
        ));
    }

    let previous_is_member =
        sqlx::query("SELECT 1 FROM relay_members WHERE community_id = $1 AND pubkey = $2")
            .bind(community)
            .bind(&previous_hex)
            .fetch_optional(tx.conn())
            .await?
            .is_some();
    if previous_is_member {
        return Ok(OwnerReassignmentOutcome::Refused(
            OwnerReassignmentRefusal::PreviousOwnerStillMember,
        ));
    }

    let archive = sqlx::query(
        "SELECT consent_path, actor, request_event_id, archived_at \
         FROM archived_identities \
         WHERE community_id = $1 AND pubkey = $2 AND replaced_by = $3 FOR SHARE",
    )
    .bind(community)
    .bind(&previous_hex)
    .bind(&new_hex)
    .fetch_optional(tx.conn())
    .await?;
    let Some(archive) = archive else {
        return Ok(OwnerReassignmentOutcome::Refused(
            OwnerReassignmentRefusal::NoRotationEvidence,
        ));
    };
    let consent_path: String = archive.try_get("consent_path")?;
    let actor: String = archive.try_get("actor")?;
    let request_event_id: String = archive.try_get("request_event_id")?;
    let archived_at: DateTime<Utc> = archive.try_get("archived_at")?;
    let Some(evidence) = rotation_evidence(&consent_path, &actor, &previous_hex) else {
        return Ok(OwnerReassignmentOutcome::Refused(
            OwnerReassignmentRefusal::NoRotationEvidence,
        ));
    };

    let updated = sqlx::query(
        "UPDATE users SET agent_owner_pubkey = $1 \
         WHERE community_id = $2 AND pubkey = $3 AND agent_owner_pubkey = $4",
    )
    .bind(new_owner_pubkey)
    .bind(community)
    .bind(agent_pubkey)
    .bind(&previous)
    .execute(tx.conn())
    .await?;
    if updated.rows_affected() != 1 {
        return Err(DbError::InvalidData(
            "agent owner changed while the row was locked".into(),
        ));
    }
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_owner_reassignments \
         (community_id, agent_pubkey, previous_owner_pubkey, new_owner_pubkey, evidence, \
          archive_actor, archive_request_event_id, archived_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    )
    .bind(community)
    .bind(agent_pubkey)
    .bind(&previous)
    .bind(new_owner_pubkey)
    .bind(evidence.as_str())
    .bind(&actor)
    .bind(&request_event_id)
    .bind(archived_at)
    .fetch_one(tx.conn())
    .await?;
    tx.commit().await?;

    Ok(OwnerReassignmentOutcome::Reassigned(
        AgentOwnerReassignment {
            id,
            agent_pubkey: agent_pubkey.to_vec(),
            previous_owner_pubkey: previous,
            new_owner_pubkey: new_owner_pubkey.to_vec(),
            evidence,
            archive_actor: actor,
            archive_request_event_id: request_event_id,
            archived_at,
        },
    ))
}

impl Db {
    /// Move an agent's recorded owner to `new_owner_pubkey` after a verified
    /// owner-key rotation. See [`reassign_agent_owner_after_rotation`].
    #[datastore_span(name = "reassign_agent_owner_after_rotation", system = "postgresql")]
    pub async fn reassign_agent_owner_after_rotation(
        &self,
        community_id: CommunityId,
        agent_pubkey: &[u8],
        new_owner_pubkey: &[u8],
    ) -> Result<OwnerReassignmentOutcome> {
        reassign_agent_owner_after_rotation(
            &self.pool,
            community_id,
            agent_pubkey,
            new_owner_pubkey,
        )
        .await
    }
}

#[cfg(test)]
mod tests;

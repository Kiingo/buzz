//! Move an agent's recorded owner after its owner rotated keys.
//!
//! [`super::relay_members::materialize_nip_oa_owner`] records the NIP-OA owner
//! of an agent once (first write wins). When the agent later proves a
//! *different* owner, the relay asks the store to reassign it; the store moves
//! the owner only with signed rotation evidence (see
//! `buzz_db::agent_owner_reassignment`) and writes its durable audit row in the
//! same transaction. This module then refreshes the pod-local caches that
//! assumed the owner never changes and appends the hash-chain audit entry.
//!
//! Live sockets are not closed. Every owner-gated decision re-reads
//! `users.agent_owner_pubkey` (directly or through the caches handled here),
//! and revoking the new owner still reaches sockets admitted under the old
//! one through the owned-agent sweep in `AppState::revoke_live_access`.
//! Closing them would also close the socket being admitted right now once
//! the cluster-wide disconnect echoes back to this pod.

use buzz_db::agent_owner_reassignment::{
    AgentOwnerReassignment, OwnerReassignmentOutcome, OwnerReassignmentRefusal,
};

use crate::state::AppState;
use buzz_core::TenantContext;

fn refusal_label(reason: OwnerReassignmentRefusal) -> &'static str {
    match reason {
        OwnerReassignmentRefusal::NoRecordedOwner => "no_recorded_owner",
        OwnerReassignmentRefusal::AlreadyOwned => "already_owned",
        OwnerReassignmentRefusal::SelfOwnership => "self_ownership",
        OwnerReassignmentRefusal::NewOwnerNotMember => "new_owner_not_member",
        OwnerReassignmentRefusal::PreviousOwnerStillMember => "previous_owner_still_member",
        OwnerReassignmentRefusal::NoRotationEvidence => "no_rotation_evidence",
    }
}

/// Try to move `agent`'s recorded owner to `new_owner`, whose NIP-OA tag the
/// caller has verified. Returns `true` only when the owner moved.
pub(crate) async fn reassign_rotated_owner(
    state: &AppState,
    tenant: &TenantContext,
    agent: &nostr::PublicKey,
    new_owner: &nostr::PublicKey,
) -> bool {
    let outcome = match state
        .db
        .reassign_agent_owner_after_rotation(
            tenant.community(),
            agent.as_bytes(),
            new_owner.as_bytes(),
        )
        .await
    {
        Ok(outcome) => outcome,
        Err(e) => {
            tracing::warn!(
                agent = %agent.to_hex(),
                new_owner = %new_owner.to_hex(),
                error = %e,
                "agent owner reassignment failed"
            );
            return false;
        }
    };
    match outcome {
        OwnerReassignmentOutcome::Reassigned(record) => {
            apply_reassignment(state, tenant, &record).await;
            true
        }
        OwnerReassignmentOutcome::Refused(reason) => {
            let label = refusal_label(reason);
            tracing::info!(
                agent = %agent.to_hex(),
                new_owner = %new_owner.to_hex(),
                reason = label,
                "agent owner reassignment refused"
            );
            metrics::counter!(
                "buzz_agent_owner_reassignments_refused_total",
                "reason" => label
            )
            .increment(1);
            false
        }
    }
}

async fn apply_reassignment(
    state: &AppState,
    tenant: &TenantContext,
    record: &AgentOwnerReassignment,
) {
    let community = tenant.community();
    // The observer cache is keyed by (agent, owner); drop the old owner's
    // entry and any cached refusal for the new one. Other pods age out within
    // the cache TTL; only the new owner's frames can be briefly refused there.
    state.observer_owner_cache.invalidate(&(
        community,
        record.agent_pubkey.clone(),
        record.previous_owner_pubkey.clone(),
    ));
    state.observer_owner_cache.invalidate(&(
        community,
        record.agent_pubkey.clone(),
        record.new_owner_pubkey.clone(),
    ));
    // The agent's cached restriction may carry the old owner's ban cascade.
    state.invalidate_restriction_cache(community, &record.agent_pubkey);

    tracing::info!(
        agent = %hex::encode(&record.agent_pubkey),
        previous_owner = %hex::encode(&record.previous_owner_pubkey),
        new_owner = %hex::encode(&record.new_owner_pubkey),
        evidence = record.evidence.as_str(),
        archive_request = %record.archive_request_event_id,
        "agent owner reassigned after owner-key rotation"
    );
    metrics::counter!(
        "buzz_agent_owner_reassignments_total",
        "evidence" => record.evidence.as_str()
    )
    .increment(1);

    // The durable record is the row committed with the change; this adds it
    // to the tamper-evident hash chain where that is enabled.
    let Some(audit_tx) = &state.audit_tx else {
        return;
    };
    let entry = buzz_audit::NewAuditEntry {
        community_id: community,
        action: buzz_audit::AuditAction::AgentOwnerReassigned,
        actor_pubkey: Some(record.new_owner_pubkey.clone()),
        object_id: Some(hex::encode(&record.agent_pubkey)),
        detail: serde_json::json!({
            "reassignment_id": record.id,
            "previous_owner_pubkey": hex::encode(&record.previous_owner_pubkey),
            "new_owner_pubkey": hex::encode(&record.new_owner_pubkey),
            "evidence": record.evidence.as_str(),
            "archive_actor": record.archive_actor,
            "archive_request_event_id": record.archive_request_event_id,
            "archived_at": record.archived_at,
        }),
    };
    if let Err(e) = audit_tx.send(entry).await {
        tracing::error!("Agent owner audit channel closed — entry lost: {e}");
        metrics::counter!("buzz_audit_send_errors_total").increment(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_refusal_has_a_distinct_metric_label() {
        let labels = [
            OwnerReassignmentRefusal::NoRecordedOwner,
            OwnerReassignmentRefusal::AlreadyOwned,
            OwnerReassignmentRefusal::SelfOwnership,
            OwnerReassignmentRefusal::NewOwnerNotMember,
            OwnerReassignmentRefusal::PreviousOwnerStillMember,
            OwnerReassignmentRefusal::NoRotationEvidence,
        ]
        .map(refusal_label);
        let unique: std::collections::BTreeSet<_> = labels.iter().collect();
        assert_eq!(unique.len(), labels.len());
    }

    use buzz_core::tenant::CommunityId;
    use nostr::Keys;
    use std::sync::Arc;

    async fn test_state(pool: sqlx::PgPool) -> Arc<AppState> {
        let db = buzz_db::Db::from_pool(pool.clone());
        let config = crate::config::Config::for_test();
        let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .expect("redis pool");
        let pubsub = Arc::new(
            buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
                .await
                .expect("pubsub"),
        );
        let audit = buzz_audit::AuditService::new(pool.clone());
        let auth = buzz_auth::AuthService::new(config.auth.clone());
        let search = buzz_search::SearchService::new(pool.clone());
        let workflow_engine = Arc::new(buzz_workflow::WorkflowEngine::new(
            db.clone(),
            buzz_workflow::WorkflowConfig::default(),
        ));
        let media_storage = buzz_media::MediaStorage::new(&config.media).expect("media");
        let (state, _audit_shutdown) = AppState::new(
            config,
            db,
            redis_pool,
            audit,
            pubsub,
            auth,
            search,
            workflow_engine,
            Keys::generate(),
            media_storage,
        );
        Arc::new(state)
    }

    /// Who the old owner's self-signed archive names as its successor.
    enum Successor {
        None,
        NewOwner,
        Someone,
    }

    /// A community where `agent` is recorded under `old`, `new` is a relay
    /// member and `old` is not, with `old` archived by itself as configured.
    async fn rotated_scene(
        successor: Successor,
    ) -> (
        Arc<AppState>,
        TenantContext,
        nostr::PublicKey,
        nostr::PublicKey,
        nostr::PublicKey,
    ) {
        let pool = sqlx::PgPool::connect(&crate::test_support::database_url())
            .await
            .expect("connect to test DB");
        let id = uuid::Uuid::new_v4();
        let host = format!("owner-rotation-{}.example", id.simple());
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(id)
            .bind(&host)
            .execute(&pool)
            .await
            .expect("insert test community");
        let tenant = TenantContext::resolved(CommunityId::from_uuid(id), host);
        let state = test_state(pool).await;
        let (agent, old, new) = (
            Keys::generate().public_key(),
            Keys::generate().public_key(),
            Keys::generate().public_key(),
        );
        assert!(
            crate::api::relay_members::materialize_nip_oa_owner(&state, &tenant, &agent, &old)
                .await,
            "first owner write"
        );
        state
            .db
            .add_relay_member(tenant.community(), &new.to_hex(), "member", None)
            .await
            .expect("admit new owner");
        let replaced_by = match successor {
            Successor::None => None,
            Successor::NewOwner => Some(new.to_hex()),
            Successor::Someone => Some(Keys::generate().public_key().to_hex()),
        };
        if let Some(replaced_by) = replaced_by {
            state
                .db
                .archive(
                    tenant.community(),
                    &old.to_hex(),
                    "self",
                    &old.to_hex(),
                    Some("rotated"),
                    Some(&replaced_by),
                    &"ef".repeat(32),
                )
                .await
                .expect("archive old owner");
        }
        (state, tenant, agent, old, new)
    }

    /// The production NIP-OA materialization seam moves the owner after a
    /// signed rotation and drops the old owner's cached authorization.
    #[tokio::test]
    #[ignore = "requires Postgres and Redis"]
    async fn materialization_reassigns_after_signed_rotation() {
        let (state, tenant, agent, old, new) = rotated_scene(Successor::NewOwner).await;
        let old_key = (
            tenant.community(),
            agent.to_bytes().to_vec(),
            old.to_bytes().to_vec(),
        );
        assert_eq!(state.observer_owner_cache.get(&old_key), Some(true));

        assert!(
            crate::api::relay_members::materialize_nip_oa_owner(&state, &tenant, &agent, &new)
                .await
        );
        assert!(state
            .db
            .is_agent_owner(tenant.community(), agent.as_bytes(), new.as_bytes())
            .await
            .expect("owner check"));
        assert_eq!(
            state.observer_owner_cache.get(&old_key),
            None,
            "the old owner's cached authorization must be dropped"
        );
        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM agent_owner_reassignments \
             WHERE community_id = $1 AND agent_pubkey = $2 AND evidence = 'nip_ia_self'",
        )
        .bind(tenant.community().as_uuid())
        .bind(agent.to_bytes().to_vec())
        .fetch_one(state.db.pool())
        .await
        .expect("count audit rows");
        assert_eq!(rows, 1);
    }

    /// Without rotation evidence a different owner is still refused, exactly
    /// as before this hook existed.
    #[tokio::test]
    #[ignore = "requires Postgres and Redis"]
    async fn materialization_refuses_new_owner_without_rotation_evidence() {
        let (state, tenant, agent, old, new) = rotated_scene(Successor::None).await;
        assert!(
            !crate::api::relay_members::materialize_nip_oa_owner(&state, &tenant, &agent, &new)
                .await
        );
        assert!(state
            .db
            .is_agent_owner(tenant.community(), agent.as_bytes(), old.as_bytes())
            .await
            .expect("owner check"));
    }

    #[tokio::test]
    #[ignore = "requires Postgres and Redis"]
    async fn materialization_refuses_archive_naming_someone_else() {
        let (state, tenant, agent, old, new) = rotated_scene(Successor::Someone).await;
        assert!(
            !crate::api::relay_members::materialize_nip_oa_owner(&state, &tenant, &agent, &new)
                .await
        );
        assert!(state
            .db
            .is_agent_owner(tenant.community(), agent.as_bytes(), old.as_bytes())
            .await
            .expect("owner check"));
    }
}

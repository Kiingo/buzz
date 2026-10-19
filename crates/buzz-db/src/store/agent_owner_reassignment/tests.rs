//! Postgres-backed tests for the guarded owner reassignment. Each guard has a
//! test that leaves every other condition satisfied, so removing that guard
//! turns its test red.

use super::*;
use crate::{archived_identities, relay_members, user};
use nostr::Keys;
use sqlx::{PgPool, Row};

async fn setup_db() -> Db {
    let pool = PgPool::connect(&crate::test_support::database_url())
        .await
        .expect("connect to test DB");
    Db::from_pool(pool)
}

fn key() -> Vec<u8> {
    Keys::generate().public_key().to_bytes().to_vec()
}

async fn make_community(pool: &PgPool) -> CommunityId {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(id)
        .bind(format!("owner-reassign-{}.example", id.simple()))
        .execute(pool)
        .await
        .expect("insert test community");
    CommunityId::from_uuid(id)
}

/// A rotation scene: `agent` owned by `old`, `new` a relay member, `old` not a
/// member, and `old` archived with `replaced-by = new` by its own key. Each
/// test then breaks exactly one condition.
struct Scene {
    db: Db,
    community: CommunityId,
    agent: Vec<u8>,
    old: Vec<u8>,
    new: Vec<u8>,
}

impl Scene {
    async fn new() -> Self {
        let db = setup_db().await;
        let community = make_community(&db.pool).await;
        let (agent, old, new) = (key(), key(), key());
        for pubkey in [&agent, &old, &new] {
            user::ensure_user(&db.pool, community, pubkey)
                .await
                .expect("ensure user");
        }
        assert!(user::set_agent_owner(&db.pool, community, &agent, &old)
            .await
            .expect("record old owner"));
        Self {
            db,
            community,
            agent,
            old,
            new,
        }
    }

    async fn admit(&self, pubkey: &[u8]) {
        relay_members::add_relay_member(
            &self.db.pool,
            self.community,
            &hex::encode(pubkey),
            "member",
            None,
        )
        .await
        .expect("add relay member");
    }

    async fn archive_old(&self, consent: &str, actor: &[u8], replaced_by: &[u8]) {
        archived_identities::archive(
            &self.db.pool,
            self.community,
            &hex::encode(&self.old),
            consent,
            &hex::encode(actor),
            Some("rotated"),
            Some(&hex::encode(replaced_by)),
            &"ab".repeat(32),
        )
        .await
        .expect("archive old owner");
    }

    /// The standard rotation: new admitted, old archived by itself.
    async fn rotated() -> Self {
        let scene = Self::new().await;
        scene.admit(&scene.new).await;
        let old = scene.old.clone();
        let new = scene.new.clone();
        scene.archive_old("self", &old, &new).await;
        scene
    }

    async fn reassign(&self) -> OwnerReassignmentOutcome {
        self.db
            .reassign_agent_owner_after_rotation(self.community, &self.agent, &self.new)
            .await
            .expect("reassignment should not error")
    }

    async fn stored_owner(&self) -> Option<Vec<u8>> {
        user::get_agent_channel_policy(&self.db.pool, self.community, &self.agent)
            .await
            .expect("read owner")
            .expect("agent row")
            .1
    }

    async fn audit_rows(&self) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM agent_owner_reassignments \
             WHERE community_id = $1 AND agent_pubkey = $2",
        )
        .bind(self.community.as_uuid())
        .bind(&self.agent)
        .fetch_one(&self.db.pool)
        .await
        .expect("count audit rows")
    }

    async fn assert_refused(&self, reason: OwnerReassignmentRefusal) {
        assert_eq!(
            self.reassign().await,
            OwnerReassignmentOutcome::Refused(reason)
        );
        assert_eq!(
            self.stored_owner().await,
            Some(self.old.clone()),
            "a refused reassignment must leave the old owner in place"
        );
        assert_eq!(self.audit_rows().await, 0, "a refusal writes no audit row");
    }
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn self_signed_rotation_moves_owner_and_writes_audit() {
    let scene = Scene::rotated().await;
    let OwnerReassignmentOutcome::Reassigned(record) = scene.reassign().await else {
        panic!("self-signed rotation must reassign");
    };
    assert_eq!(record.agent_pubkey, scene.agent);
    assert_eq!(record.previous_owner_pubkey, scene.old);
    assert_eq!(record.new_owner_pubkey, scene.new);
    assert_eq!(record.evidence, OwnerRotationEvidence::SelfSignedArchive);
    assert_eq!(record.archive_actor, hex::encode(&scene.old));
    assert_eq!(record.archive_request_event_id, "ab".repeat(32));
    assert_eq!(scene.stored_owner().await, Some(scene.new.clone()));

    let row = sqlx::query(
        "SELECT previous_owner_pubkey, new_owner_pubkey, evidence, archive_actor, \
                archive_request_event_id \
         FROM agent_owner_reassignments WHERE community_id = $1 AND id = $2",
    )
    .bind(scene.community.as_uuid())
    .bind(record.id)
    .fetch_one(&scene.db.pool)
    .await
    .expect("audit row");
    assert_eq!(
        row.get::<Vec<u8>, _>("previous_owner_pubkey"),
        scene.old,
        "audit names the old key"
    );
    assert_eq!(row.get::<Vec<u8>, _>("new_owner_pubkey"), scene.new);
    assert_eq!(row.get::<String, _>("evidence"), "nip_ia_self");
    assert_eq!(
        row.get::<String, _>("archive_actor"),
        hex::encode(&scene.old)
    );
    assert_eq!(
        row.get::<String, _>("archive_request_event_id"),
        "ab".repeat(32)
    );
    assert!(
        user::is_agent_owner(&scene.db.pool, scene.community, &scene.agent, &scene.new)
            .await
            .expect("owner check")
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn admin_attested_rotation_moves_owner() {
    let scene = Scene::new().await;
    scene.admit(&scene.new).await;
    let admin = key();
    let new = scene.new.clone();
    scene.archive_old("admin", &admin, &new).await;
    let OwnerReassignmentOutcome::Reassigned(record) = scene.reassign().await else {
        panic!("admin-attested rotation must reassign");
    };
    assert_eq!(record.evidence, OwnerRotationEvidence::AdminArchive);
    assert_eq!(record.archive_actor, hex::encode(&admin));
    assert_eq!(scene.stored_owner().await, Some(scene.new.clone()));
    assert_eq!(scene.audit_rows().await, 1);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn refuses_when_new_owner_is_not_a_member() {
    let scene = Scene::new().await;
    let old = scene.old.clone();
    let new = scene.new.clone();
    scene.archive_old("self", &old, &new).await;
    scene
        .assert_refused(OwnerReassignmentRefusal::NewOwnerNotMember)
        .await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn refuses_while_old_owner_is_still_a_member() {
    let scene = Scene::rotated().await;
    scene.admit(&scene.old).await;
    scene
        .assert_refused(OwnerReassignmentRefusal::PreviousOwnerStillMember)
        .await;
}

/// Membership alone (new admitted, old gone) never moves an owner.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn refuses_membership_change_without_archive() {
    let scene = Scene::new().await;
    scene.admit(&scene.new).await;
    scene
        .assert_refused(OwnerReassignmentRefusal::NoRotationEvidence)
        .await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn refuses_archive_naming_a_different_successor() {
    let scene = Scene::new().await;
    scene.admit(&scene.new).await;
    let old = scene.old.clone();
    scene.archive_old("self", &old, &key()).await;
    scene
        .assert_refused(OwnerReassignmentRefusal::NoRotationEvidence)
        .await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn refuses_archive_without_successor() {
    let scene = Scene::new().await;
    scene.admit(&scene.new).await;
    archived_identities::archive(
        &scene.db.pool,
        scene.community,
        &hex::encode(&scene.old),
        "self",
        &hex::encode(&scene.old),
        None,
        None,
        &"cd".repeat(32),
    )
    .await
    .expect("archive without successor");
    scene
        .assert_refused(OwnerReassignmentRefusal::NoRotationEvidence)
        .await;
}

/// A NIP-OA "owner" consent archive says nothing about a human key rotation.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn refuses_owner_consent_archive() {
    let scene = Scene::new().await;
    scene.admit(&scene.new).await;
    let new = scene.new.clone();
    scene.archive_old("owner", &key(), &new).await;
    scene
        .assert_refused(OwnerReassignmentRefusal::NoRotationEvidence)
        .await;
}

/// `self` consent must be signed by the old key itself.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn refuses_self_consent_signed_by_another_key() {
    let scene = Scene::new().await;
    scene.admit(&scene.new).await;
    let new = scene.new.clone();
    scene.archive_old("self", &key(), &new).await;
    scene
        .assert_refused(OwnerReassignmentRefusal::NoRotationEvidence)
        .await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn refuses_when_new_owner_already_owns_the_agent() {
    let scene = Scene::rotated().await;
    let outcome = scene
        .db
        .reassign_agent_owner_after_rotation(scene.community, &scene.agent, &scene.old)
        .await
        .expect("reassignment should not error");
    assert_eq!(
        outcome,
        OwnerReassignmentOutcome::Refused(OwnerReassignmentRefusal::AlreadyOwned)
    );
    assert_eq!(scene.audit_rows().await, 0);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn refuses_self_ownership() {
    let scene = Scene::rotated().await;
    let outcome = scene
        .db
        .reassign_agent_owner_after_rotation(scene.community, &scene.agent, &scene.agent)
        .await
        .expect("reassignment should not error");
    assert_eq!(
        outcome,
        OwnerReassignmentOutcome::Refused(OwnerReassignmentRefusal::SelfOwnership)
    );
    assert_eq!(scene.stored_owner().await, Some(scene.old.clone()));
}

/// An agent with no recorded owner is left to the first-write path.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn refuses_unowned_agent_and_first_write_still_wins() {
    let db = setup_db().await;
    let community = make_community(&db.pool).await;
    let (agent, owner) = (key(), key());
    for pubkey in [&agent, &owner] {
        user::ensure_user(&db.pool, community, pubkey)
            .await
            .expect("ensure user");
    }
    let outcome = db
        .reassign_agent_owner_after_rotation(community, &agent, &owner)
        .await
        .expect("reassignment should not error");
    assert_eq!(
        outcome,
        OwnerReassignmentOutcome::Refused(OwnerReassignmentRefusal::NoRecordedOwner)
    );
    assert!(user::set_agent_owner(&db.pool, community, &agent, &owner)
        .await
        .expect("first write"));
    assert!(!user::set_agent_owner(&db.pool, community, &agent, &key())
        .await
        .expect("second write"));
}

/// The ordinary owner write stays first-write-wins even with full rotation
/// evidence present; only the guarded path can move the owner.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn ordinary_owner_write_cannot_overwrite_even_after_rotation() {
    let scene = Scene::rotated().await;
    assert!(
        !user::set_agent_owner(&scene.db.pool, scene.community, &scene.agent, &scene.new)
            .await
            .expect("second write")
    );
    assert_eq!(scene.stored_owner().await, Some(scene.old.clone()));
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn missing_agent_is_an_error() {
    let scene = Scene::rotated().await;
    let result = scene
        .db
        .reassign_agent_owner_after_rotation(scene.community, &key(), &scene.new)
        .await;
    assert!(matches!(result, Err(DbError::NotFound(_))));
}

#[test]
fn evidence_classification_requires_self_signer_or_admin() {
    let old = "11".repeat(32);
    assert_eq!(
        rotation_evidence("self", &old, &old),
        Some(OwnerRotationEvidence::SelfSignedArchive)
    );
    assert_eq!(rotation_evidence("self", &"22".repeat(32), &old), None);
    assert_eq!(
        rotation_evidence("admin", &"22".repeat(32), &old),
        Some(OwnerRotationEvidence::AdminArchive)
    );
    assert_eq!(rotation_evidence("owner", &old, &old), None);
    assert_eq!(rotation_evidence("", &old, &old), None);
}

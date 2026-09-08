use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;
use std::str::FromStr;
use std::time::Duration;

struct Fixture {
    community: CommunityId,
    channel: Uuid,
    claims: Claims,
    runtime: SigningKey,
    agent: Keys,
    timestamp: Timestamp,
}

impl Fixture {
    fn encode(&self, claims: Claims) -> String {
        let signature = self.runtime.sign(&claims.signing_bytes().unwrap());
        let auth = Authorization {
            claims,
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        };
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&auth).unwrap())
    }

    fn publication(&self, mut claims: Claims, content: &str) -> Event {
        let Operation::Publish { fence_id, .. } = &claims.action else {
            panic!("publish fixture")
        };
        let tags = vec![
            Tag::parse(["h", &self.channel.to_string()]).unwrap(),
            Tag::parse(["d", &format!("buzz-local-publication:{fence_id}")]).unwrap(),
        ];
        let template = EventBuilder::new(Kind::Custom(9), content)
            .tags(tags.clone())
            .custom_created_at(self.timestamp)
            .sign_with_keys(&self.agent)
            .unwrap();
        let Operation::Publish {
            event_template_hash,
            ..
        } = &mut claims.action
        else {
            unreachable!()
        };
        *event_template_hash = template.id.to_hex();
        let mut tags = tags;
        tags.push(Tag::parse([AUTHORIZATION_TAG, &self.encode(claims)]).unwrap());
        EventBuilder::new(Kind::Custom(9), content)
            .tags(tags)
            .custom_created_at(self.timestamp)
            .sign_with_keys(&self.agent)
            .unwrap()
    }

    fn cancellation(&self) -> Event {
        let mut claims = self.claims.clone();
        claims.action = Operation::Cancel {
            user_request_event_id: "c".repeat(64),
        };
        EventBuilder::new(
            Kind::Custom(KIND_AGENT_CANCELLATION as u16),
            self.encode(claims),
        )
        .tags([
            Tag::parse(["h", &self.channel.to_string()]).unwrap(),
            Tag::parse([
                "d",
                &format!("buzz-user-cancellation:{}", self.claims.scope_id),
            ])
            .unwrap(),
        ])
        .sign_with_keys(&self.agent)
        .unwrap()
    }
}

async fn setup() -> (PgPool, Fixture) {
    // No production/default DATABASE_URL fallback. This test creates fixtures
    // and applies guarded migrations only in an explicitly isolated local DB.
    let url = std::env::var("BUZZ_MANAGED_PUBLICATION_TEST_DATABASE_URL")
        .expect("explicit isolated publication test database required");
    let options = PgConnectOptions::from_str(&url).unwrap();
    assert_eq!(options.get_host(), "127.0.0.1");
    assert!(options
        .get_database()
        .unwrap()
        .starts_with("buzz_managed_publication_test"));
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options.application_name("buzz-managed-publication-tests"))
        .await
        .unwrap();
    crate::migration::run_migrations(&pool).await.unwrap();
    crate::Db::from_pool(pool.clone())
        .validate_deletion_catalog()
        .await
        .expect("new scoped tables must satisfy the live community fence/purge catalog");
    let community = CommunityId::from_uuid(Uuid::new_v4());
    let channel = Uuid::new_v4();
    let audience = format!("runtime-{}.example", community.as_uuid());
    let runtime = SigningKey::from_bytes(&[19; 32]); // test-only key
    let agent = Keys::generate();
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(community.as_uuid())
        .bind(&audience)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO channels (community_id, id, name, created_by) VALUES ($1, $2, 'publication-test', $3)")
        .bind(community.as_uuid()).bind(channel).bind(agent.public_key().to_bytes().as_slice())
        .execute(&pool).await.unwrap();
    crate::Db::from_pool(pool.clone())
        .ensure_managed_runtime_issuer(
            community,
            "runtime-test",
            "key-1",
            &runtime.verifying_key().to_bytes(),
        )
        .await
        .unwrap();
    let claims = Claims {
        domain: buzz_core::managed_publication::DOMAIN.into(),
        issuer: "runtime-test".into(),
        audience,
        key_id: "key-1".into(),
        scope_kind: ScopeKind::Discussion,
        scope_id: Uuid::new_v4().to_string(),
        channel_id: channel.to_string(),
        requester_public_key: "5".repeat(64),
        request_event_id: "a".repeat(64),
        action: Operation::Publish {
            receipt_id: Uuid::new_v4().to_string(),
            fence_id: Uuid::new_v4().to_string(),
            signer_public_key: agent.public_key().to_hex(),
            event_template_hash: "b".repeat(64),
        },
    };
    (
        pool,
        Fixture {
            community,
            channel,
            claims,
            runtime,
            agent,
            timestamp: Timestamp::now(),
        },
    )
}

async fn count(pool: &PgPool, table: &str, community: CommunityId) -> i64 {
    let query = match table {
        "managed_runtime_issuers" => {
            "SELECT count(*) FROM managed_runtime_issuers WHERE community_id = $1"
        }
        "managed_publication_scopes" => {
            "SELECT count(*) FROM managed_publication_scopes WHERE community_id = $1"
        }
        "managed_publication_receipts" => {
            "SELECT count(*) FROM managed_publication_receipts WHERE community_id = $1"
        }
        "managed_publications" => {
            "SELECT count(*) FROM managed_publications WHERE community_id = $1"
        }
        "events" => "SELECT count(*) FROM events WHERE community_id = $1",
        "thread_metadata" => "SELECT count(*) FROM thread_metadata WHERE community_id = $1",
        _ => panic!("unexpected fixture table"),
    };
    sqlx::query_scalar(query)
        .bind(community.as_uuid())
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn assert_blocked(pool: &PgPool, backend: i32, blocker: i32) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let blockers: Vec<i32> = sqlx::query_scalar("SELECT pg_blocking_pids($1)")
                .bind(backend)
                .fetch_one(pool)
                .await
                .unwrap();
            if blockers.contains(&blocker) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("contender must actually block on the held scope transaction");
}

#[tokio::test]
#[ignore = "requires explicit isolated Postgres"]
async fn runtime_issuer_provisioning_is_immutable_concurrent_and_rotation_safe() {
    let (pool, fixture) = setup().await;
    let db = crate::Db::from_pool(pool.clone());
    let key = fixture.runtime.verifying_key().to_bytes();
    let next = SigningKey::from_bytes(&[23; 32]).verifying_key().to_bytes();
    let (first, replay) = tokio::join!(
        db.ensure_managed_runtime_issuer(fixture.community, "runtime-test", "key-2", &next),
        db.ensure_managed_runtime_issuer(fixture.community, "runtime-test", "key-2", &next),
    );
    first.unwrap();
    replay.unwrap();
    assert!(db
        .ensure_managed_runtime_issuer(fixture.community, "runtime-test", "key-1", &next)
        .await
        .is_err());
    assert!(db
        .ensure_managed_runtime_issuer(fixture.community, "invalid issuer", "key-3", &key)
        .await
        .is_err());
    assert_eq!(
        count(&pool, "managed_runtime_issuers", fixture.community).await,
        2
    );
    let stored: Vec<u8> = sqlx::query_scalar(
        "SELECT public_key FROM managed_runtime_issuers WHERE community_id=$1 AND key_id='key-1'",
    )
    .bind(fixture.community.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored, key);
    let event = fixture.publication(fixture.claims.clone(), "still authorized by original key");
    let mut tx = pool.begin().await.unwrap();
    assert!(
        apply_event_tx(&mut tx, fixture.community, &event, Some(fixture.channel))
            .await
            .is_ok()
    );
    tx.rollback().await.unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires explicit isolated Postgres"]
async fn scope_fence_serializes_stop_publication_replay_and_transaction_rollback() {
    let (pool, fixture) = setup().await;
    let community = fixture.community;
    let channel = Some(fixture.channel);
    let event = fixture.publication(fixture.claims.clone(), "original contribution");
    let cancel = fixture.cancellation();

    // Actual event insertion and its journal share the caller-owned transaction.
    let mut tx = pool.begin().await.unwrap();
    let meta = crate::event::ThreadMetadataParams {
        event_id: event.id.as_bytes(),
        event_created_at: DateTime::from_timestamp(event.created_at.as_secs() as i64, 0).unwrap(),
        channel_id: fixture.channel,
        parent_event_id: None,
        parent_event_created_at: None,
        root_event_id: None,
        root_event_created_at: None,
        depth: 0,
        broadcast: false,
    };
    assert!(
        crate::event::insert_event_with_thread_metadata_tx(
            &mut tx,
            community,
            &event,
            channel,
            Some(meta)
        )
        .await
        .unwrap()
        .1
    );
    tx.rollback().await.unwrap();
    for table in [
        "managed_publication_scopes",
        "managed_publication_receipts",
        "managed_publications",
        "events",
        "thread_metadata",
    ] {
        assert_eq!(
            count(&pool, table, community).await,
            0,
            "rolled back {table}"
        );
    }

    // Stop gets the lock first; an in-flight publication really waits for it.
    let mut stop_tx = pool.begin().await.unwrap();
    let stop_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *stop_tx)
        .await
        .unwrap();
    assert!(
        !crate::event::insert_event_in_transaction(&mut stop_tx, community, &cancel, channel)
            .await
            .unwrap()
            .1
    );
    let mut output_tx = pool.begin().await.unwrap();
    let output_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *output_tx)
        .await
        .unwrap();
    let output_event = event.clone();
    let output = tokio::spawn(async move {
        let result = crate::event::insert_event_in_transaction(
            &mut output_tx,
            community,
            &output_event,
            channel,
        )
        .await;
        output_tx.rollback().await.unwrap();
        result
    });
    assert_blocked(&pool, output_pid, stop_pid).await;
    stop_tx.commit().await.unwrap();
    assert!(
        matches!(output.await.unwrap(), Err(DbError::AccessDenied(reason)) if reason.contains("cancelled by user"))
    );
    assert_eq!(count(&pool, "events", community).await, 0);
    assert_eq!(count(&pool, "managed_publications", community).await, 0);
    assert!(
        !crate::event::insert_event(&pool, community, &cancel, channel)
            .await
            .unwrap()
            .1
    );
    assert_eq!(
        count(&pool, "managed_publication_scopes", community).await,
        1
    );

    // Independent discussion: publication commits first, then Stop takes effect.
    let mut second = fixture.claims.clone();
    second.scope_id = Uuid::new_v4().to_string();
    if let Operation::Publish {
        receipt_id,
        fence_id,
        ..
    } = &mut second.action
    {
        *receipt_id = Uuid::new_v4().to_string();
        *fence_id = Uuid::new_v4().to_string();
    }
    let fixture = Fixture {
        claims: second,
        ..fixture
    };
    let event = fixture.publication(fixture.claims.clone(), "accepted before Stop");
    let cancel = fixture.cancellation();
    let mut output_tx = pool.begin().await.unwrap();
    let output_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *output_tx)
        .await
        .unwrap();
    assert!(
        crate::event::insert_event_in_transaction(&mut output_tx, community, &event, channel)
            .await
            .unwrap()
            .1
    );
    let mut stop_tx = pool.begin().await.unwrap();
    let stop_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *stop_tx)
        .await
        .unwrap();
    let stop = tokio::spawn(async move {
        let result =
            crate::event::insert_event_in_transaction(&mut stop_tx, community, &cancel, channel)
                .await
                .unwrap();
        stop_tx.commit().await.unwrap();
        result
    });
    assert_blocked(&pool, stop_pid, output_pid).await;
    output_tx.commit().await.unwrap();
    assert!(!stop.await.unwrap().1);
    assert!(
        !crate::event::insert_event(&pool, community, &event, channel)
            .await
            .unwrap()
            .1
    );
    assert_eq!(count(&pool, "events", community).await, 1);
    assert_eq!(count(&pool, "managed_publications", community).await, 1);

    let changed = fixture.publication(fixture.claims.clone(), "changed under same fence");
    assert!(
        matches!(crate::event::insert_event(&pool, community, &changed, channel).await,
        Err(DbError::AccessDenied(reason)) if reason.contains("fence changed"))
    );
    let mut later = fixture.claims.clone();
    if let Operation::Publish { fence_id, .. } = &mut later.action {
        *fence_id = Uuid::new_v4().to_string();
    }
    let later = fixture.publication(later, "late contribution");
    assert!(
        matches!(crate::event::insert_event(&pool, community, &later, channel).await,
        Err(DbError::AccessDenied(reason)) if reason.contains("cancelled by user"))
    );
    let mut moved = fixture.claims.clone();
    moved.scope_id = Uuid::new_v4().to_string();
    let moved = fixture.publication(moved, "same receipt moved to another discussion");
    assert!(
        matches!(crate::event::insert_event(&pool, community, &moved, channel).await,
        Err(DbError::AccessDenied(reason)) if reason.contains("receipt identity changed"))
    );

    // Retention/deletion does not erase acceptance and replay never resurrects.
    sqlx::query("DELETE FROM events WHERE community_id = $1 AND id = $2")
        .bind(community.as_uuid())
        .bind(event.id.as_bytes().as_slice())
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        !crate::event::insert_event(&pool, community, &event, channel)
            .await
            .unwrap()
            .1
    );
    assert_eq!(count(&pool, "events", community).await, 0);
    assert_eq!(count(&pool, "managed_publications", community).await, 1);
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires explicit isolated Postgres"]
async fn runtime_authority_rejects_foreign_scope_untrusted_keys_and_missing_permits() {
    let (pool, fixture) = setup().await;
    let community = fixture.community;
    let channel = Some(fixture.channel);
    let event = fixture.publication(fixture.claims.clone(), "authorized");
    assert!(crate::event::insert_event(
        &pool,
        CommunityId::from_uuid(Uuid::new_v4()),
        &event,
        channel
    )
    .await
    .is_err());
    let db = crate::Db::from_pool(pool.clone());
    assert!(matches!(
        db.replace_addressable_event(community, &event, channel)
            .await,
        Err(DbError::InvalidData(_))
    ));
    assert!(matches!(
        db.replace_parameterized_event(community, &event, "attempted-bypass", channel)
            .await,
        Err(DbError::InvalidData(_))
    ));
    assert!(matches!(
        crate::event::insert_event(&pool, community, &event, Some(Uuid::new_v4())).await,
        Err(DbError::AccessDenied(_))
    ));
    let mut wrong_host = fixture.claims.clone();
    wrong_host.audience = "other.example".into();
    let wrong_host = fixture.publication(wrong_host, "wrong host");
    assert!(matches!(
        crate::event::insert_event(&pool, community, &wrong_host, channel).await,
        Err(DbError::AccessDenied(_))
    ));
    let mut wrong_key = fixture.claims.clone();
    wrong_key.key_id = "not-trusted".into();
    let wrong_key = fixture.publication(wrong_key, "unknown key");
    assert!(matches!(
        crate::event::insert_event(&pool, community, &wrong_key, channel).await,
        Err(DbError::AccessDenied(_))
    ));
    let missing = EventBuilder::new(Kind::Custom(9), "no permit")
        .tags(
            event
                .tags
                .iter()
                .filter(|t| t.as_slice()[0] != AUTHORIZATION_TAG)
                .cloned(),
        )
        .sign_with_keys(&fixture.agent)
        .unwrap();
    assert!(matches!(
        crate::event::insert_event(&pool, community, &missing, channel).await,
        Err(DbError::AccessDenied(_))
    ));
    let status = EventBuilder::new(
        Kind::Custom(KIND_AGENT_STATUS as u16),
        "operational status is not authority",
    )
    .tags(event.tags.clone())
    .sign_with_keys(&fixture.agent)
    .unwrap();
    assert!(matches!(
        crate::event::insert_event(&pool, community, &status, channel).await,
        Err(DbError::AccessDenied(_))
    ));
    for table in [
        "managed_publication_scopes",
        "managed_publication_receipts",
        "managed_publications",
        "events",
    ] {
        assert_eq!(
            count(&pool, table, community).await,
            0,
            "rejected before mutating {table}"
        );
    }
    pool.close().await;
}

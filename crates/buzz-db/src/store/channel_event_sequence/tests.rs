use super::*;
use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::{str::FromStr, time::Duration};

fn signed(keys: &Keys, channel: Uuid, content: &str, timestamp: u64) -> Event {
    EventBuilder::new(Kind::Custom(9), content)
        .tag(Tag::parse(["h", &channel.to_string()]).unwrap())
        .custom_created_at(Timestamp::from(timestamp))
        .sign_with_keys(keys)
        .unwrap()
}

#[test]
fn channel_sequence_decimals_do_not_round_or_accept_numeric_syntax() {
    for value in [
        "0",
        "1",
        "9007199254740993",
        "18446744073709551616000000000001",
    ] {
        assert!(valid_channel_sequence(value));
    }
    for value in ["", "00", "01", "+1", "-1", "1.0", "1e3", " 1", "1 ", "١"] {
        assert!(!valid_channel_sequence(value));
    }
}

/// Runs real concurrent transactions against a fresh explicitly isolated DB.
/// This is a commit-order proof, not a timestamp/single-connection simulation.
#[tokio::test]
#[ignore = "requires fresh isolated BUZZ_CHANNEL_SEQUENCE_TEST_DATABASE_URL"]
async fn channel_sequence_survives_late_commit_rollback_replacement_and_exact_large_cursors() {
    let url = std::env::var("BUZZ_CHANNEL_SEQUENCE_TEST_DATABASE_URL").unwrap();
    let options = PgConnectOptions::from_str(&url).unwrap();
    assert_eq!(options.get_host(), "127.0.0.1");
    assert!(options
        .get_database()
        .unwrap()
        .starts_with("buzz_channel_sequence_test"));
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options.application_name("buzz-channel-sequence-tests"))
        .await
        .unwrap();
    let existing: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('_sqlx_migrations')::text")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(existing.is_none(), "use a fresh isolated database");
    crate::migration::run_migrations_through(&pool, 43)
        .await
        .unwrap();
    let db = Db::from_pool(pool.clone());
    let community = CommunityId::from_uuid(Uuid::new_v4());
    let other = CommunityId::from_uuid(Uuid::new_v4());
    let channel = Uuid::new_v4();
    let second = Uuid::new_v4();
    let keys = Keys::generate();
    for (tenant, ch) in [(community, channel), (community, second), (other, channel)] {
        sqlx::query("INSERT INTO communities(id,host) VALUES ($1,$2) ON CONFLICT DO NOTHING")
            .bind(tenant.as_uuid())
            .bind(format!("sequence-{}.test", tenant.as_uuid()))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channels(community_id,id,name,created_by) VALUES($1,$2,'sequence-test',$3)")
            .bind(tenant.as_uuid()).bind(ch).bind(keys.public_key().to_bytes().as_slice())
            .execute(&pool).await.unwrap();
    }
    let legacy = signed(&keys, channel, "old input", 1789010000);
    db.insert_event(community, &legacy, Some(channel))
        .await
        .unwrap();
    crate::migration::run_migrations(&pool).await.unwrap();
    db.validate_deletion_catalog().await.unwrap();
    assert_eq!(
        db.get_event_by_id(community, legacy.id.as_bytes())
            .await
            .unwrap()
            .unwrap()
            .event,
        legacy
    );
    assert!(db
        .query_channel_event_sequence(community, channel, "0", 64)
        .await
        .unwrap()
        .is_empty());

    let late = signed(&keys, channel, "late old authored timestamp", 1789000000);
    let newer = signed(&keys, channel, "newer transaction", 1789010001);
    let mut first = pool.begin().await.unwrap();
    crate::event::insert_event_in_transaction(&mut first, community, &late, Some(channel))
        .await
        .unwrap();
    let other_db = Db::from_pool(pool.clone());
    let newer_copy = newer.clone();
    let mut blocked = tokio::spawn(async move {
        other_db
            .insert_event(community, &newer_copy, Some(channel))
            .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut blocked)
            .await
            .is_err()
    );
    assert!(db
        .query_channel_event_sequence(community, channel, "0", 64)
        .await
        .unwrap()
        .is_empty());
    // Unrelated channel/tenant writes do not wait on the blocked channel head.
    for (tenant, ch) in [(other, channel), (community, second)] {
        let event = signed(&keys, ch, "independent input", 1789010002);
        tokio::time::timeout(
            Duration::from_secs(2),
            db.insert_event(tenant, &event, Some(ch)),
        )
        .await
        .unwrap()
        .unwrap();
    }
    first.commit().await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), blocked)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let first_page = db
        .query_channel_event_sequence(community, channel, "0", 1)
        .await
        .unwrap();
    assert_eq!(first_page[0].sequence, "1");
    assert_eq!(first_page[0].stored.event, late);
    first_page[0].stored.event.verify().unwrap();
    // A replacement client with only the last acknowledged cursor obtains the
    // next exact original event; no process-local seen set or timestamp needed.
    let replacement = Db::from_pool(pool.clone());
    let next = replacement
        .query_channel_event_sequence(community, channel, "1", 64)
        .await
        .unwrap();
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].sequence, "2");
    assert_eq!(next[0].stored.event, newer);
    db.insert_event(community, &late, Some(channel))
        .await
        .unwrap();
    assert_eq!(
        db.query_channel_event_sequence(community, channel, "0", 64)
            .await
            .unwrap()
            .len(),
        2
    );

    let rolled_back = signed(&keys, channel, "not accepted", 1789010003);
    let mut tx = pool.begin().await.unwrap();
    crate::event::insert_event_in_transaction(&mut tx, community, &rolled_back, Some(channel))
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(
        db.query_channel_event_sequence(community, channel, "2", 64)
            .await
            .unwrap()
            .len(),
        0
    );
    // A genuine deletion stays deleted; the transport does not resurrect chat.
    db.soft_delete_event(community, newer.id.as_bytes())
        .await
        .unwrap();
    assert!(db
        .query_channel_event_sequence(community, channel, "1", 64)
        .await
        .unwrap()
        .is_empty());

    sqlx::query("UPDATE channel_event_heads SET sequence = 18446744073709551616000000000000 WHERE community_id=$1 AND channel_id=$2")
        .bind(community.as_uuid()).bind(channel).execute(&pool).await.unwrap();
    let large = signed(&keys, channel, "large exact input", 1789010004);
    db.insert_event(community, &large, Some(channel))
        .await
        .unwrap();
    let large_page = db
        .query_channel_event_sequence(community, channel, "18446744073709551616000000000000", 64)
        .await
        .unwrap();
    assert_eq!(large_page.len(), 1);
    assert_eq!(large_page[0].sequence, "18446744073709551616000000000001");
    assert_eq!(large_page[0].stored.event, large);
    assert!(db
        .query_channel_event_sequence(community, channel, "1e3", 64)
        .await
        .is_err());
    assert!(db
        .query_channel_event_sequence(community, channel, "0", 65)
        .await
        .is_err());
    pool.close().await;
}

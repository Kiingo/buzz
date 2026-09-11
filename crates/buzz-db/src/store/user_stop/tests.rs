use super::*;
use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp};
use serde_json::json;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;
use std::str::FromStr;

fn signed(keys: &Keys, channel: Uuid, root: &str, content: &str, timestamp: u64) -> Event {
    EventBuilder::new(Kind::Custom(9), content)
        .tags([
            Tag::parse(["h", &channel.to_string()]).unwrap(),
            Tag::parse(["e", root, "", "reply"]).unwrap(),
        ])
        .custom_created_at(Timestamp::from(timestamp))
        .sign_with_keys(keys)
        .unwrap()
}

async fn root_for(
    pool: &PgPool,
    channel: Uuid,
    content: &str,
    tags: serde_json::Value,
) -> Option<Vec<u8>> {
    sqlx::query_scalar("SELECT user_stop_event_root(9, $1, $2, $3)")
        .bind(tags)
        .bind(content)
        .bind(channel)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// A fresh explicitly named local database lets this test exercise the actual
/// 0042 -> 0043 migration with original historical rows, then the live trigger.
/// It never falls back to DATABASE_URL or modifies a pre-existing application DB.
#[tokio::test]
#[ignore = "requires a fresh isolated BUZZ_USER_STOP_TEST_DATABASE_URL"]
async fn migration_and_atomic_stop_index_preserve_signed_evidence_without_chat_replay() {
    let url = std::env::var("BUZZ_USER_STOP_TEST_DATABASE_URL")
        .expect("explicit isolated Stop test database required");
    let options = PgConnectOptions::from_str(&url).unwrap();
    assert_eq!(options.get_host(), "127.0.0.1");
    assert!(options
        .get_database()
        .unwrap()
        .starts_with("buzz_user_stop_test"));
    let pool = PgPoolOptions::new()
        .max_connections(3)
        .connect_with(options.application_name("buzz-user-stop-tests"))
        .await
        .unwrap();
    let existing: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('_sqlx_migrations')::text")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        existing.is_none(),
        "use a fresh isolated test database; never downgrade an existing schema"
    );
    crate::migration::run_migrations_through(&pool, 42)
        .await
        .unwrap();
    let db = Db::from_pool(pool.clone());
    let community = CommunityId::from_uuid(Uuid::new_v4());
    let other_community = CommunityId::from_uuid(Uuid::new_v4());
    let channel = Uuid::new_v4();
    let other_channel = Uuid::new_v4();
    let keys = Keys::generate();
    let author = keys.public_key().to_bytes();
    let root = "a".repeat(64);
    let roots = vec![vec![0xaa; 32]];
    let since = DateTime::from_timestamp(1788968083, 0).unwrap();
    for (community, channel) in [
        (community, channel),
        (other_community, channel),
        (community, other_channel),
    ] {
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(community.as_uuid())
            .bind(format!("stop-{}.test", community.as_uuid()))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channels (community_id, id, name, created_by) VALUES ($1, $2, 'stop-test', $3)")
            .bind(community.as_uuid()).bind(channel).bind(author.as_slice())
            .execute(&pool).await.unwrap();
    }
    let old_stop = signed(&keys, channel, &root, "!cancel", 1788968182);
    let chat = signed(
        &keys,
        channel,
        &root,
        "We discussed !cancel; this is not a Stop.",
        1788968183,
    );
    db.insert_event(community, &old_stop, Some(channel))
        .await
        .unwrap();
    db.insert_event(community, &chat, Some(channel))
        .await
        .unwrap();
    db.soft_delete_event(community, old_stop.id.as_bytes())
        .await
        .unwrap();
    let before: Vec<serde_json::Value> =
        sqlx::query_scalar("SELECT to_jsonb(e) FROM events e WHERE community_id = $1 ORDER BY id")
            .bind(community.as_uuid())
            .fetch_all(&pool)
            .await
            .unwrap();

    crate::migration::run_migrations_through(&pool, 43)
        .await
        .unwrap();
    let after: Vec<serde_json::Value> =
        sqlx::query_scalar("SELECT to_jsonb(e) FROM events e WHERE community_id = $1 ORDER BY id")
            .bind(community.as_uuid())
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        before, after,
        "migration must not rewrite historical signed/chat rows"
    );
    let found = db
        .query_user_stop_events(community, channel, &author, &roots, since, 16)
        .await
        .unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].event, old_stop);
    found[0].event.verify().unwrap();

    // Exact retries cannot resurrect the tombstone or duplicate control evidence.
    db.insert_event(community, &old_stop, Some(channel))
        .await
        .unwrap();
    let tombstoned: bool = sqlx::query_scalar(
        "SELECT deleted_at IS NOT NULL FROM events WHERE community_id = $1 AND id = $2",
    )
    .bind(community.as_uuid())
    .bind(old_stop.id.as_bytes().as_slice())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(tombstoned);
    assert!(db
        .get_event_by_id(community, old_stop.id.as_bytes())
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        db.query_user_stop_events(community, channel, &author, &roots, since, 16)
            .await
            .unwrap()
            .len(),
        1
    );

    // An insert rolled back before acceptance leaves no recovery evidence.
    let rolled_back = signed(&keys, channel, &root, "nostr:npub1abc !cancel", 1788968184);
    let mut tx = pool.begin().await.unwrap();
    crate::event::insert_event_in_transaction(&mut tx, community, &rolled_back, Some(channel))
        .await
        .unwrap();
    let visible: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM user_stop_events WHERE community_id = $1 AND id = $2",
    )
    .bind(community.as_uuid())
    .bind(rolled_back.id.as_bytes().as_slice())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(visible, 0);
    tx.rollback().await.unwrap();

    // Later committed, older-authored Stops remain directly queryable. There is
    // no timestamp/high-water checkpoint capable of skipping their transaction.
    let late = signed(&keys, channel, &root, "!cancel nostr:npub1abc", 1788968100);
    let mut delayed_tx = pool.begin().await.unwrap();
    crate::event::insert_event_in_transaction(&mut delayed_tx, community, &late, Some(channel))
        .await
        .unwrap();
    let fresh = signed(&keys, channel, &root, "\t!cancel\n", 1788968200);
    db.insert_event(community, &fresh, Some(channel))
        .await
        .unwrap();
    assert_eq!(
        db.query_user_stop_events(community, channel, &author, &roots, since, 16)
            .await
            .unwrap()
            .len(),
        2
    );
    delayed_tx.commit().await.unwrap();
    assert_eq!(
        db.query_user_stop_events(community, channel, &author, &roots, since, 16)
            .await
            .unwrap()
            .len(),
        3
    );

    // Same signed event in another tenant, another channel, a non-requester,
    // another effective root, and a Stop predating this run cannot cross scope.
    db.insert_event(other_community, &old_stop, Some(channel))
        .await
        .unwrap();
    let other_keys = Keys::generate();
    for event in [
        signed(&keys, other_channel, &root, "!cancel", 1788968201),
        signed(&other_keys, channel, &root, "!cancel", 1788968202),
        signed(&keys, channel, &"b".repeat(64), "!cancel", 1788968203),
        signed(&keys, channel, &root, "!cancel", 1788968082),
    ] {
        let event_channel = if event.created_at.as_secs() == 1788968201 {
            other_channel
        } else {
            channel
        };
        db.insert_event(community, &event, Some(event_channel))
            .await
            .unwrap();
    }
    assert_eq!(
        db.query_user_stop_events(community, channel, &author, &roots, since, 16)
            .await
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        db.query_user_stop_events(other_community, channel, &author, &roots, since, 16)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        db.query_user_stop_events(community, channel, &author, &roots, since, 1)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(db
        .query_user_stop_events(community, channel, &author, &roots, since, 0)
        .await
        .is_err());

    // Use exactly the public parser's Unicode/mention boundary, not a broader
    // language-specific whitespace class or natural-language substring match.
    let tags = json!([["h", channel.to_string()], ["e", root, "", "reply"]]);
    for ch in [
        '\u{0009}', '\u{000a}', '\u{000b}', '\u{000c}', '\u{000d}', ' ', '\u{00a0}', '\u{1680}',
        '\u{2000}', '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}',
        '\u{2007}', '\u{2008}', '\u{2009}', '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}',
        '\u{205f}', '\u{3000}', '\u{feff}',
    ] {
        assert_eq!(
            root_for(
                &pool,
                channel,
                &format!("{ch}nostr:npub1ABC{ch}!cancel{ch}nostr:abc{ch}"),
                tags.clone()
            )
            .await,
            Some(vec![0xaa; 32])
        );
    }
    for content in [
        "\u{0085}!cancel",
        "\u{001c}!cancel",
        "!Cancel",
        "!cancel please",
        "x !cancel",
        "nostr: !cancel",
        "nostr:é !cancel",
    ] {
        assert!(
            root_for(&pool, channel, content, tags.clone())
                .await
                .is_none(),
            "{content:?}"
        );
    }
    let upper_channel = json!([
        ["h", channel.to_string().to_uppercase()],
        ["e", root.to_uppercase(), "", "reply"]
    ]);
    assert_eq!(
        root_for(&pool, channel, "!cancel", upper_channel).await,
        Some(vec![0xaa; 32])
    );
    for invalid in [
        json!([["h", channel.to_string()], ["e", root, "", "root"]]),
        json!([
            ["h", channel.to_string()],
            ["h", channel.to_string()],
            ["e", root, "", "reply"]
        ]),
        json!([["h", other_channel.to_string()], ["e", root, "", "reply"]]),
        json!([
            ["h", channel.simple().to_string()],
            ["e", root, "", "reply"]
        ]),
        json!([["h", channel.to_string()], ["e", "bad", "", "reply"]]),
        json!([["h", channel.to_string()], 12]),
    ] {
        assert!(root_for(&pool, channel, "!cancel", invalid).await.is_none());
    }
    let duplicate_roots = json!([
        ["h", channel.to_string()],
        ["e", root, "", "root"],
        ["e", "b".repeat(64), "", "root"],
        ["e", "bad", "", "root"],
        ["e", root, "", "reply"]
    ]);
    assert_eq!(
        root_for(&pool, channel, "!cancel", duplicate_roots).await,
        Some(vec![0xbb; 32])
    );

    // Reading original Stop evidence does not itself execute cancellation or
    // manufacture the delivery/acknowledgement state that belongs to the API.
    let automatic_controls: i64 =
        sqlx::query_scalar("SELECT count(*) FROM managed_publication_scopes")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(automatic_controls, 0);

    // Physical chat retention cannot erase original cancellation authority.
    // It must not restore a deleted Stop to ordinary event reads either.
    sqlx::query("DELETE FROM events WHERE community_id = $1 AND id = $2")
        .bind(community.as_uuid())
        .bind(old_stop.id.as_bytes().as_slice())
        .execute(&pool)
        .await
        .unwrap();
    assert!(db
        .get_event_by_id_including_deleted(community, old_stop.id.as_bytes())
        .await
        .unwrap()
        .is_none());
    let retained = db
        .query_user_stop_events(community, channel, &author, &roots, since, 16)
        .await
        .unwrap();
    assert_eq!(retained.len(), 3);
    let original = retained
        .iter()
        .find(|stored| stored.event.id == old_stop.id)
        .unwrap();
    assert_eq!(original.event, old_stop);
    original.event.verify().unwrap();
    // The original Stop migration/history proof above remains scoped to 0043.
    // Validate the complete current deletion inventory after later migrations.
    crate::migration::run_migrations(&pool).await.unwrap();
    db.validate_deletion_catalog().await.unwrap();
    pool.close().await;
}

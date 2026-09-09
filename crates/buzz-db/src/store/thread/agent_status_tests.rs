use super::*;
use crate::event::{
    insert_event_with_thread_metadata, soft_delete_event_and_update_thread, ThreadMetadataParams,
};
use nostr::{EventBuilder, Keys, Kind};

#[tokio::test]
#[ignore = "requires Postgres"]
async fn operational_status_is_thread_evidence_not_reply_activity() {
    // The test requires an explicitly selected isolated database; never inherit
    // the production DATABASE_URL by accident.
    let url = std::env::var("BUZZ_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .expect("isolated test database");
    let options: sqlx::postgres::PgConnectOptions = url.parse().expect("test database options");
    assert!(
        matches!(
            options.get_host(),
            "localhost" | "127.0.0.1" | "::1" | "postgres" | "buzz-postgres"
        ),
        "test database must be local"
    );
    let pool = PgPool::connect_with(options)
        .await
        .expect("connect test database");
    let community = CommunityId::from_uuid(Uuid::new_v4());
    let channel = Uuid::new_v4();
    let author = Keys::generate();
    let operator = Keys::generate();
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(community.as_uuid())
        .bind(format!("status-{}.example", channel))
        .execute(&pool)
        .await
        .expect("community");
    sqlx::query("INSERT INTO channels (id, community_id, name, channel_type, visibility, created_by) VALUES ($1, $2, 'status-test', 'stream', 'open', $3)")
        .bind(channel).bind(community.as_uuid()).bind(author.public_key().to_bytes().as_slice())
        .execute(&pool).await.expect("channel");
    let root = EventBuilder::new(Kind::Custom(9), "root")
        .sign_with_keys(&author)
        .expect("root");
    let root_at = DateTime::from_timestamp(root.created_at.as_secs() as i64, 0).expect("timestamp");
    insert_event_with_thread_metadata(&pool, community, &root, Some(channel), None)
        .await
        .expect("store root");
    let reply = EventBuilder::new(Kind::Custom(9), "contribution")
        .sign_with_keys(&author)
        .expect("reply");
    let status = EventBuilder::new(Kind::Custom(40098), "operational evidence")
        .sign_with_keys(&operator)
        .expect("status");
    for event in [&reply, &status, &status] {
        insert_event_with_thread_metadata(
            &pool,
            community,
            event,
            Some(channel),
            Some(ThreadMetadataParams {
                event_id: event.id.as_bytes(),
                event_created_at: DateTime::from_timestamp(event.created_at.as_secs() as i64, 0)
                    .expect("timestamp"),
                channel_id: channel,
                parent_event_id: Some(root.id.as_bytes()),
                parent_event_created_at: Some(root_at),
                root_event_id: Some(root.id.as_bytes()),
                root_event_created_at: Some(root_at),
                depth: 1,
                broadcast: false,
            }),
        )
        .await
        .expect("insert reply or status, including replay");
    }
    let summary = get_thread_summary(&pool, community, root.id.as_bytes())
        .await
        .expect("summary")
        .expect("root metadata");
    assert_eq!((summary.reply_count, summary.descendant_count), (1, 1));
    assert_eq!(
        summary.participants,
        vec![author.public_key().to_bytes().to_vec()]
    );
    let replies = get_thread_replies(&pool, community, root.id.as_bytes(), Some(64), 100, None)
        .await
        .expect("thread");
    assert_eq!(
        replies.len(),
        2,
        "status stays readable, duplicates do not multiply it"
    );
    let window = get_channel_window(&pool, community, channel, 100, None, Some(&[9]))
        .await
        .expect("channel window");
    let root_row = window
        .rows
        .iter()
        .find(|row| row.stored_event.event.id == root.id)
        .expect("root row");
    assert_eq!(
        root_row
            .thread_summary
            .as_ref()
            .expect("summary")
            .participants,
        summary.participants
    );

    // Reproduce historical inflation and verify the migration repairs only
    // derived counters while preserving the operational event.
    sqlx::query("UPDATE thread_metadata SET reply_count = 2, descendant_count = 2 WHERE community_id = $1 AND event_id = $2")
        .bind(community.as_uuid()).bind(root.id.as_bytes().as_slice()).execute(&pool).await.expect("historical counters");
    sqlx::raw_sql(include_str!(
        "../../../../../migrations/0042_agent_status_thread_counters.sql"
    ))
    .execute(&pool)
    .await
    .expect("repair migration");
    let repaired = get_thread_summary(&pool, community, root.id.as_bytes())
        .await
        .expect("summary")
        .expect("metadata");
    assert_eq!((repaired.reply_count, repaired.descendant_count), (1, 1));
    for expected in [true, false] {
        assert_eq!(
            soft_delete_event_and_update_thread(
                &pool,
                community,
                status.id.as_bytes(),
                Some(root.id.as_bytes()),
                Some(root.id.as_bytes())
            )
            .await
            .expect("status delete"),
            expected
        );
        let current = get_thread_summary(&pool, community, root.id.as_bytes())
            .await
            .expect("summary")
            .expect("metadata");
        assert_eq!((current.reply_count, current.descendant_count), (1, 1));
    }
}

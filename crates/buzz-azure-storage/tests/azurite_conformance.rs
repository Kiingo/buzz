//! Conformance test for the Azure primitives required by Buzz.
//!
//! Run with a local Azurite blob service and an existing `buzz-conformance`
//! container:
//!
//! ```text
//! BUZZ_AZURITE_TEST=1 cargo test -p buzz-azure-storage --test azurite_conformance
//! ```

use std::sync::Arc;

use buzz_azure_storage::{AzureBlobStore, ConditionalWrite};
use bytes::Bytes;
use futures_util::TryStreamExt;
use tokio::sync::Barrier;
use uuid::Uuid;

const CONTAINER: &str = "buzz-conformance";
const RACE_WIDTH: usize = 16;

fn enabled() -> bool {
    std::env::var("BUZZ_AZURITE_TEST").as_deref() == Ok("1")
}

#[tokio::test]
async fn azure_blob_satisfies_buzz_storage_contract() {
    if !enabled() {
        eprintln!("skipping: set BUZZ_AZURITE_TEST=1 and start Azurite");
        return;
    }

    let store = AzureBlobStore::for_azurite(CONTAINER).expect("build Azurite client");
    let prefix = format!("probe/{}", Uuid::new_v4());

    sequential_roundtrip(&store, &prefix).await;
    create_only_race(&store, &prefix).await;
    compare_and_swap_race(&store, &prefix).await;
    media_primitives(&store, &prefix).await;
}

async fn sequential_roundtrip(store: &AzureBlobStore, prefix: &str) {
    let key = format!("{prefix}/sequential");
    let created = store
        .create(&key, Bytes::from_static(b"v1"), "text/plain")
        .await
        .expect("create should complete");
    let ConditionalWrite::Won(created_version) = created else {
        panic!("unique create unexpectedly lost its race");
    };

    let read = store.get(&key).await.expect("read created object");
    assert_eq!(read.bytes, Bytes::from_static(b"v1"));
    assert_eq!(read.version, created_version);

    let updated = store
        .update(&key, Bytes::from_static(b"v2"), "text/plain", read.version)
        .await
        .expect("update should complete");
    let ConditionalWrite::Won(updated_version) = updated else {
        panic!("uncontended update unexpectedly lost its race");
    };
    assert_ne!(updated_version, created_version);

    let read = store.get(&key).await.expect("read updated object");
    assert_eq!(read.bytes, Bytes::from_static(b"v2"));
    assert_eq!(read.version, updated_version);
}

async fn create_only_race(store: &AzureBlobStore, prefix: &str) {
    let key = format!("{prefix}/create-race");
    let barrier = Arc::new(Barrier::new(RACE_WIDTH));
    let mut racers = Vec::with_capacity(RACE_WIDTH);

    for index in 0..RACE_WIDTH {
        let store = store.clone();
        let key = key.clone();
        let barrier = Arc::clone(&barrier);
        racers.push(tokio::spawn(async move {
            barrier.wait().await;
            store
                .create(
                    &key,
                    Bytes::from(format!("candidate-{index}")),
                    "text/plain",
                )
                .await
        }));
    }

    let mut winners = 0;
    let mut losers = 0;
    for racer in racers {
        match racer
            .await
            .expect("racer task should join")
            .expect("Azure response")
        {
            ConditionalWrite::Won(_) => winners += 1,
            ConditionalWrite::LostRace => losers += 1,
        }
    }

    assert_eq!(winners, 1, "If-None-Match race must have one winner");
    assert_eq!(losers, RACE_WIDTH - 1);
}

async fn compare_and_swap_race(store: &AzureBlobStore, prefix: &str) {
    let key = format!("{prefix}/cas-race");
    let created = store
        .create(&key, Bytes::from_static(b"base"), "text/plain")
        .await
        .expect("create CAS base");
    let ConditionalWrite::Won(base_version) = created else {
        panic!("unique CAS base create unexpectedly lost");
    };

    let barrier = Arc::new(Barrier::new(RACE_WIDTH));
    let mut racers = Vec::with_capacity(RACE_WIDTH);
    for index in 0..RACE_WIDTH {
        let store = store.clone();
        let key = key.clone();
        let barrier = Arc::clone(&barrier);
        let version = base_version.clone();
        racers.push(tokio::spawn(async move {
            barrier.wait().await;
            store
                .update(
                    &key,
                    Bytes::from(format!("candidate-{index}")),
                    "text/plain",
                    version,
                )
                .await
        }));
    }

    let mut winner_version = None;
    let mut losers = 0;
    for racer in racers {
        match racer
            .await
            .expect("racer task should join")
            .expect("Azure response")
        {
            ConditionalWrite::Won(version) => {
                assert!(
                    winner_version.replace(version).is_none(),
                    "multiple CAS winners"
                );
            }
            ConditionalWrite::LostRace => losers += 1,
        }
    }

    let winner_version = winner_version.expect("If-Match race must have one winner");
    assert_eq!(losers, RACE_WIDTH - 1);

    let read = store.get(&key).await.expect("read CAS winner");
    assert_eq!(read.version, winner_version);
    let next = store
        .update(
            &key,
            Bytes::from_static(b"next"),
            "text/plain",
            winner_version,
        )
        .await
        .expect("reuse winning response ETag");
    assert!(matches!(next, ConditionalWrite::Won(_)));
}

async fn media_primitives(store: &AzureBlobStore, prefix: &str) {
    let key = format!("{prefix}/media/video.bin");
    let bytes = Bytes::from_static(b"0123456789abcdefghijklmnopqrstuvwxyz");
    store
        .put(&key, bytes.clone(), "application/octet-stream")
        .await
        .expect("put media object");

    let range = store.get_range(&key, 10..16).await.expect("range read");
    assert_eq!(range, Bytes::from_static(b"abcdef"));

    let streamed = store
        .get_stream(&key)
        .await
        .expect("open media stream")
        .try_collect::<Vec<_>>()
        .await
        .expect("stream media chunks")
        .concat();
    assert_eq!(streamed, bytes);

    let head = store
        .head(&key)
        .await
        .expect("head media object")
        .expect("media object exists");
    assert_eq!(head.size, bytes.len() as u64);

    let listed = store
        .list_prefix(&format!("{prefix}/media"))
        .await
        .expect("list media prefix");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].key, key);

    let page = store
        .list_page(Some(&format!("{prefix}/media")), None, 1)
        .await
        .expect("list bounded media page");
    assert_eq!(page.objects.len(), 1);
    assert_eq!(page.objects[0].key, key);

    store.delete(&key).await.expect("delete media object");
    assert!(store
        .head(&key)
        .await
        .expect("head deleted object")
        .is_none());
}

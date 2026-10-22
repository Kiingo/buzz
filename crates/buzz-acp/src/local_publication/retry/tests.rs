use super::super::tests::{authorization_response, intent, receive_http, respond_http, rest};
use super::*;
use crate::relay::RestClient;
use nostr::Keys;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn worker(base: &str, keys: Keys) -> LocalPublicationWorker {
    let community_id = intent(keys.public_key().to_hex()).community_id;
    LocalPublicationWorker {
        rest: rest(keys),
        community_id,
        completion_api_base_url: base.into(),
        internal_token: "failure-test-token".into(),
        reconcile_reactions: false,
        retry_pacing: Default::default(),
    }
}

#[tokio::test(start_paused = true)]
async fn interrupted_retry_keeps_its_fence_deadline_and_attempt_history() {
    let keys = Keys::generate();
    let saved = intent(keys.public_key().to_hex());
    let worker = worker("http://127.0.0.1:9", keys);
    let deadline = {
        let mut pacing = worker.retry_pacing.lock().await;
        assert_eq!(pacing.begin_attempt(&saved.fence_id), 1);
        pacing.not_before(&saved.fence_id).unwrap()
    };
    for _ in 0..2 {
        let future = worker.publish_with_retry(&saved);
        tokio::pin!(future);
        assert!(tokio::time::timeout(Duration::from_millis(30), &mut future)
            .await
            .is_err());
        let pacing = worker.retry_pacing.lock().await;
        assert_eq!(pacing.fences[&saved.fence_id].attempt, 1);
        assert_eq!(pacing.not_before(&saved.fence_id), Some(deadline));
    }
}

#[tokio::test(start_paused = true)]
async fn pacing_is_independent_and_bounded_without_forgetting_recent_fences() {
    let mut pacing = RetryPacing::default();
    pacing.begin_attempt("old");
    for index in 0..RETRY_FENCE_CAPACITY {
        tokio::time::advance(Duration::from_millis(1)).await;
        pacing.begin_attempt(&format!("fence-{index}"));
    }
    assert_eq!(pacing.fences.len(), RETRY_FENCE_CAPACITY);
    assert!(!pacing.fences.contains_key("old"));
    let recent = format!("fence-{}", RETRY_FENCE_CAPACITY - 1);
    let before = pacing.not_before(&recent);
    assert_eq!(pacing.begin_attempt("independent"), 1);
    assert_eq!(pacing.not_before(&recent), before);
    assert_eq!(pacing.begin_attempt(&recent), 2);
    pacing.completed(&recent);
    assert_eq!(pacing.not_before(&recent), None);
    assert!(pacing.not_before("independent").is_some());
}

#[test]
fn failure_phase_never_copies_arbitrary_error_text() {
    for (error, expected) in [
        (
            "publication eligibility unavailable: private detail",
            "authorization_unavailable",
        ),
        (
            "publication eligibility rejected: private detail",
            "authorization_rejected",
        ),
        (
            "publication authorization response invalid: private detail",
            "authorization_response_invalid",
        ),
        (
            "publication reconciliation query timed out",
            "relay_reconciliation_unavailable",
        ),
        (
            "publication relay submission failed: private detail",
            "relay_submission_unavailable",
        ),
        (
            "publication fence completion returned HTTP 503",
            "completion_unavailable",
        ),
        (
            "publication runtime authorization missing",
            "signing_or_authority_invalid",
        ),
        (
            "unrecognized private body and credential",
            "publication_unavailable",
        ),
    ] {
        assert_eq!(failure_code(error), expected);
    }
}

#[test]
fn relay_timestamp_rejection_reports_its_own_phase_with_the_frozen_event() {
    let event_id = "ab".repeat(32);
    let error = super::super::relay_timestamp_rejected_error(
        &event_id,
        r#"HTTP error: POST /events returned HTTP 400 Bad Request: {"error":"invalid: event timestamp too far from server time"}"#,
    );
    assert_eq!(failure_code(&error), "relay_timestamp_rejected");
    assert_eq!(
        relay_timestamp_rejected_event_id(&error),
        Some(event_id.as_str())
    );
    // The status drop path still recognises the rejection inside the phase.
    assert!(error.contains(RELAY_TIMESTAMP_REJECTION));

    // Any other submission failure keeps its phase and names no event.
    let plain = "publication relay submission failed: HTTP error: POST /events returned HTTP 400 Bad Request: {\"error\":\"invalid: bad signature\"}";
    assert_eq!(failure_code(plain), "relay_submission_unavailable");
    assert_eq!(relay_timestamp_rejected_event_id(plain), None);
    for malformed in [
        "AB".repeat(32),
        "ab".repeat(31),
        format!("{}g", "a".repeat(63)),
    ] {
        let error = format!("{RELAY_TIMESTAMP_REJECTED_PHASE}: frozen_event_id={malformed}: x");
        assert_eq!(
            relay_timestamp_rejected_event_id(&error),
            None,
            "{malformed}"
        );
    }

    let keys = Keys::generate();
    let saved = intent(keys.public_key().to_hex());
    let identity = serde_json::json!({
        "fence_id": saved.fence_id, "receipt_id": saved.receipt_id,
        "community_id": saved.community_id,
        "agent_public_key": saved.agent_public_key,
    });
    let mut stale = identity.clone();
    stale["failure_code"] = "relay_timestamp_rejected".into();
    // Byte-for-byte the relay's reason, as the completion API matches it.
    stale["relay_rejection"] = "invalid: event timestamp too far from server time".into();
    stale["frozen_event_id"] = event_id.clone().into();
    stale["frozen_event_created_at"] = saved.event_created_at.into();
    assert_eq!(
        failure_report_body(&saved, "relay_timestamp_rejected", Some(&event_id)),
        stale
    );
    let mut plain_body = identity;
    plain_body["failure_code"] = "relay_submission_unavailable".into();
    assert_eq!(
        failure_report_body(&saved, "relay_submission_unavailable", None),
        plain_body
    );
}

#[tokio::test]
async fn diagnostic_reporting_is_one_bounded_attempt_with_identity_and_phase_only() {
    tokio::time::timeout(Duration::from_secs(4), async {
        let keys = Keys::generate();
        let saved = intent(keys.public_key().to_hex());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let worker = worker(&base, keys);
        let expected = saved.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let (headers, body) = receive_http(&mut stream).await;
            assert!(headers.starts_with(&format!(
                "POST /api/buzz-bridge/publications/{}/failure ",
                expected.fence_id
            )));
            assert!(headers
                .to_lowercase()
                .contains("authorization: bearer failure-test-token"));
            assert_eq!(
                body,
                serde_json::json!({
                    "fence_id": expected.fence_id, "receipt_id": expected.receipt_id,
                    "community_id": expected.community_id,
                    "agent_public_key": expected.agent_public_key,
                    "failure_code": "authorization_unavailable",
                })
            );
            respond_http(
                &mut stream,
                503,
                serde_json::json!({"error": "unavailable"}),
            )
            .await;
            assert!(
                tokio::time::timeout(Duration::from_millis(150), listener.accept())
                    .await
                    .is_err()
            );
        });
        worker
            .report_failure(&saved, "authorization_unavailable", None)
            .await;
        server.await.unwrap();
        assert!(worker.retry_pacing.lock().await.fences.is_empty());
    })
    .await
    .expect("bounded failure report");
}

#[tokio::test]
async fn ordinary_recovery_poll_does_not_abort_an_inflight_completion() {
    tokio::time::timeout(Duration::from_secs(12), async {
        let keys = Keys::generate();
        let saved = intent(keys.public_key().to_hex());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let worker = Arc::new(LocalPublicationWorker {
            rest: RestClient {
                base_url: base.clone(),
                ..rest(keys)
            },
            community_id: saved.community_id.clone(),
            completion_api_base_url: base,
            internal_token: "slow-completion-token".into(),
            reconcile_reactions: false,
            retry_pacing: Default::default(),
        });
        let authorizations = Arc::new(AtomicUsize::new(0));
        let publications = Arc::new(AtomicUsize::new(0));
        let completions = Arc::new(AtomicUsize::new(0));
        let recoveries = Arc::new(AtomicUsize::new(0));
        let counts = (
            authorizations.clone(),
            publications.clone(),
            completions.clone(),
            recoveries.clone(),
        );
        let expected = saved.clone();
        let server = tokio::spawn(async move {
            let mut handlers = tokio::task::JoinSet::new();
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let counts = counts.clone();
                let expected = expected.clone();
                handlers.spawn(async move {
                    let (headers, body) = receive_http(&mut stream).await;
                    let path = headers.split_whitespace().nth(1).unwrap();
                    if path.ends_with("/authorize") {
                        counts.0.fetch_add(1, Ordering::SeqCst);
                        respond_http(&mut stream, 200, authorization_response(&body, true)).await;
                    } else if path == "/query" {
                        respond_http(&mut stream, 200, serde_json::json!([])).await;
                    } else if path == "/events" {
                        counts.1.fetch_add(1, Ordering::SeqCst);
                        let event: nostr::Event = serde_json::from_value(body).unwrap();
                        event.verify().unwrap();
                        assert_eq!(event.content, expected.content);
                        assert_eq!(event.created_at.as_secs(), expected.event_created_at);
                        respond_http(&mut stream, 200, serde_json::json!({"accepted": true})).await;
                    } else if path.ends_with("/complete") {
                        if counts.2.fetch_add(1, Ordering::SeqCst) == 0 {
                            // Lose this acknowledgement after the next recovery
                            // poll. The exact same completion can still retry.
                            tokio::time::sleep(Duration::from_secs(6)).await;
                            return;
                        }
                        respond_http(&mut stream, 200, serde_json::json!({"completed": true}))
                            .await;
                    } else if path.ends_with("/recover") {
                        counts.3.fetch_add(1, Ordering::SeqCst);
                        respond_http(
                            &mut stream,
                            200,
                            serde_json::json!({
                                "cancellations": [], "publications": []
                            }),
                        )
                        .await;
                    } else {
                        panic!("unexpected publication request: {path}");
                    }
                });
            }
        });
        let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
        sender.send(saved).await.unwrap();
        drop(sender);
        worker.clone().run(&mut receiver).await;
        server.abort();
        let _ = server.await;
        assert_eq!(authorizations.load(Ordering::SeqCst), 1);
        assert_eq!(publications.load(Ordering::SeqCst), 1);
        assert_eq!(completions.load(Ordering::SeqCst), 2);
        assert!(recoveries.load(Ordering::SeqCst) >= 1);
        assert!(worker.retry_pacing.lock().await.fences.is_empty());
    })
    .await
    .expect("completion continues across a recovery poll");
}

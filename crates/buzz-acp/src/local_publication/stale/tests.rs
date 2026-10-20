use super::super::tests::{authorization_response, intent, receive_http, respond_http, rest};
use super::*;
use nostr::{EventBuilder, Keys, Kind};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[test]
fn only_exact_definitive_old_event_rejection_admits_retirement() {
    let keys = Keys::generate();
    let event = EventBuilder::new(Kind::Custom(9), "frozen answer")
        .custom_created_at(nostr::Timestamp::from(1000))
        .sign_with_keys(&keys)
        .unwrap();
    let exact =
        format!("POST /events returned HTTP 400 Bad Request: {{\"error\":\"{STALE_REASON}\"}}");
    assert!(is_stale_rejection(
        &RelayError::Http(exact.clone()),
        &event,
        1901
    ));
    for now in [999, 1000, 1900] {
        assert!(!is_stale_rejection(
            &RelayError::Http(exact.clone()),
            &event,
            now
        ));
    }
    for message in [
        exact.replace("400 Bad Request", "500 Internal Server Error"),
        exact.replace("POST /events", "POST /query"),
        exact.replace(STALE_REASON, "invalid: another refusal"),
        "transport failed: event timestamp too far from server time".into(),
        "POST /events returned HTTP 400 Bad Request: broken-json".into(),
    ] {
        assert!(!is_stale_rejection(
            &RelayError::Http(message),
            &event,
            1901
        ));
    }
    assert!(!is_stale_rejection(
        &RelayError::UnexpectedMessage(exact),
        &event,
        1901
    ));
}

async fn native_boundary_case(mode: &'static str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        let keys = Keys::generate();
        let saved = intent(keys.public_key().to_hex());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let worker = LocalPublicationWorker {
            rest: crate::relay::RestClient {base_url: base.clone(), ..rest(keys)},
            community_id: saved.community_id.clone(), completion_api_base_url: base,
            internal_token: "stale-fixture-token".into(), reconcile_reactions: false,
            retry_pacing: Default::default(),
        };
        let queries = Arc::new(AtomicUsize::new(0));
        let submissions = Arc::new(AtomicUsize::new(0));
        let retirements = Arc::new(AtomicUsize::new(0));
        let completions = Arc::new(AtomicUsize::new(0));
        let counters = (queries.clone(), submissions.clone(), retirements.clone(), completions.clone());
        let expected = saved.clone();
        let server = tokio::spawn(async move {
            let mut frozen: Option<nostr::Event> = None;
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let (headers, body) = receive_http(&mut stream).await;
                let path = headers.split_whitespace().nth(1).unwrap();
                if path.ends_with("/authorize") {
                    respond_http(&mut stream, 200, authorization_response(&body, true)).await;
                } else if path == "/query" {
                    let ordinal = counters.0.fetch_add(1, Ordering::SeqCst);
                    if ordinal > 0 {
                        let event = frozen.as_ref().unwrap();
                        assert_eq!(body[0]["ids"][0], event.id.to_hex());
                        assert_eq!(body[0]["authors"][0], event.pubkey.to_hex());
                        assert_eq!(body[0]["#h"][0], expected.channel_id);
                        if mode == "query_failed" {
                            respond_http(&mut stream, 403, serde_json::json!({"error":"read denied"})).await;
                            continue;
                        }
                        if mode == "found" {
                            respond_http(&mut stream, 200, serde_json::json!([event])).await;
                            continue;
                        }
                    }
                    respond_http(&mut stream, 200, serde_json::json!([])).await;
                } else if path == "/events" {
                    counters.1.fetch_add(1, Ordering::SeqCst);
                    let event: nostr::Event = serde_json::from_value(body).unwrap();
                    event.verify().unwrap();
                    assert_eq!(event.created_at.as_secs(), expected.event_created_at);
                    assert_eq!(event.content, expected.content);
                    frozen = Some(event);
                    let reason = if mode == "other_refusal" {"invalid: other refusal"} else {STALE_REASON};
                    respond_http(&mut stream, 400, serde_json::json!({"error":reason})).await;
                } else if path.ends_with("/failure") {
                    counters.2.fetch_add(1, Ordering::SeqCst);
                    assert!(headers.to_lowercase().contains("authorization: bearer stale-fixture-token"));
                    assert_eq!(body, serde_json::json!({
                        "fence_id":expected.fence_id, "receipt_id":expected.receipt_id,
                        "community_id":expected.community_id, "agent_public_key":expected.agent_public_key,
                        "failure_code":"relay_timestamp_rejected", "frozen_event_id":frozen.as_ref().unwrap().id.to_hex(),
                        "frozen_event_created_at":expected.event_created_at, "relay_rejection":STALE_REASON
                    }));
                    if mode == "lost_retirement_result" {
                        // The API may have committed. No fresh local identity is signed.
                        respond_http(&mut stream, 503, serde_json::json!({"error":"result unavailable"})).await;
                    } else {
                        respond_http(&mut stream, 200, serde_json::json!({"refreshed":mode != "parked", "parked":mode == "parked"})).await;
                    }
                } else if path.ends_with("/complete") {
                    counters.3.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(body["buzz_event_id"], frozen.as_ref().unwrap().id.to_hex());
                    respond_http(&mut stream, 200, serde_json::json!({})).await;
                } else {
                    panic!("unexpected boundary {path}");
                }
            }
        });
        let result = worker.publish(&saved).await;
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
        assert_eq!(submissions.load(Ordering::SeqCst), 1);
        match mode {
            "absent" | "parked" => {
                assert_eq!(result.unwrap(), None);
                assert_eq!(queries.load(Ordering::SeqCst), 2);
                assert_eq!(retirements.load(Ordering::SeqCst), 1);
                assert_eq!(completions.load(Ordering::SeqCst), 0);
            }
            "found" => {
                assert!(result.unwrap().is_some());
                assert_eq!(queries.load(Ordering::SeqCst), 2);
                assert_eq!(retirements.load(Ordering::SeqCst), 0);
                assert_eq!(completions.load(Ordering::SeqCst), 1);
            }
            _ => {
                assert!(result.is_err());
                assert_eq!(completions.load(Ordering::SeqCst), 0);
                assert_eq!(retirements.load(Ordering::SeqCst), usize::from(mode == "lost_retirement_result"));
                assert_eq!(queries.load(Ordering::SeqCst), if mode == "other_refusal" {1} else {2});
            }
        }
    }).await.expect("bounded native stale publication fixture");
}

#[tokio::test]
async fn exact_stale_refusal_and_absence_refreshes_only_through_durable_api() {
    native_boundary_case("absent").await;
}
#[tokio::test]
async fn found_original_event_completes_original_id_without_refresh() {
    native_boundary_case("found").await;
}
#[tokio::test]
async fn failed_absence_read_keeps_frozen_identity() {
    native_boundary_case("query_failed").await;
}
#[tokio::test]
async fn other_relay_refusal_never_refreshes() {
    native_boundary_case("other_refusal").await;
}
#[tokio::test]
async fn lost_retirement_result_never_signs_a_local_replacement() {
    native_boundary_case("lost_retirement_result").await;
}
#[tokio::test]
async fn durable_park_does_not_claim_delivery_or_loop() {
    native_boundary_case("parked").await;
}

use super::*;
use nostr::{Keys, Kind};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn authorization_response(intent: &serde_json::Value, should_publish: bool) -> serde_json::Value {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use buzz_core::managed_publication::{Authorization, Claims, DOMAIN};
    use ed25519_dalek::{Signer, SigningKey};
    use sha2::{Digest, Sha256};
    if !should_publish
        || !matches!(
            intent["publication_kind"].as_str(),
            Some("final" | "action")
        )
    {
        return serde_json::json!({"should_publish": should_publish});
    }
    let root = intent["thread_root_event_id"]
        .as_str()
        .or_else(|| intent["reply_to_event_id"].as_str())
        .unwrap();
    let template = serde_json::json!([
        0,
        intent["agent_public_key"],
        intent["event_created_at"],
        9,
        [
            ["h", intent["channel_id"].as_str().unwrap()],
            ["e", root, "", "reply"],
            [
                "d",
                &format!(
                    "buzz-local-publication:{}",
                    intent["fence_id"].as_str().unwrap()
                )
            ]
        ],
        intent["content"]
    ]);
    let claims: Claims = serde_json::from_value(serde_json::json!({
        "domain": DOMAIN, "issuer": intent["community_id"], "audience": "relay.example", "key_id": "runtime-1",
        "scope_kind": "discussion", "scope_id": intent["fence_id"], "channel_id": intent["channel_id"],
        "requester_public_key": "5".repeat(64), "request_event_id": root,
        "action": { "operation": "publish", "receipt_id": intent["receipt_id"], "fence_id": intent["fence_id"],
            "signer_public_key": intent["agent_public_key"],
            "event_template_hash": hex::encode(Sha256::digest(serde_json::to_vec(&template).unwrap())) }
    })).unwrap();
    // Public RFC 8032 seed, never a production runtime credential.
    let seed: [u8; 32] =
        hex::decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
            .unwrap()
            .try_into()
            .unwrap();
    let signature = SigningKey::from_bytes(&seed).sign(&claims.signing_bytes().unwrap());
    let authority = Authorization {
        claims,
        signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
    };
    serde_json::json!({ "should_publish": true,
        "runtime_authorization": URL_SAFE_NO_PAD.encode(serde_json::to_vec(&authority).unwrap()) })
}

fn rest(keys: Keys) -> RestClient {
    RestClient {
        http: reqwest::Client::new(),
        base_url: "http://127.0.0.1:3000".to_string(),
        keys,
        auth_tag_json: None,
    }
}

fn intent(agent_public_key: String) -> LocalPublicationIntent {
    LocalPublicationIntent {
        session_update: "buzz_local_publication".to_string(),
        community_id: "example-community".to_string(),
        agent_public_key,
        receipt_id: Uuid::new_v4().to_string(),
        fence_id: Uuid::new_v4().to_string(),
        event_created_at: 1_788_811_000,
        channel_id: Uuid::new_v4().to_string(),
        thread_root_event_id: None,
        reply_to_event_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_string(),
        publication_kind: "final".to_string(),
        content: "Done".to_string(),
    }
}

#[tokio::test]
async fn idle_publisher_polls_the_durable_outbox_without_a_prompt_or_enqueue() {
    tokio::time::timeout(Duration::from_secs(7), async {
        let keys = Keys::generate();
        let public_key = keys.public_key().to_hex();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let expected_public_key = public_key.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let (headers, body) = receive_http(&mut stream).await;
            assert!(headers.starts_with("POST /api/buzz-bridge/publications/recover HTTP/1.1"));
            assert!(headers
                .to_lowercase()
                .contains("authorization: bearer idle-recovery-test-token"));
            assert_eq!(
                body,
                serde_json::json!({
                    "community_id": "example-community",
                    "agent_public_key": expected_public_key,
                })
            );
            respond_http(
                &mut stream,
                200,
                serde_json::json!({"cancellations": [], "publications": []}),
            )
            .await;
        });
        let publisher = LocalPublicationPublisher::start(
            RestClient {
                base_url: base.clone(),
                ..rest(keys)
            },
            "example-community".into(),
            base,
            "idle-recovery-test-token".into(),
        );
        server.await.unwrap();
        drop(publisher);
    })
    .await
    .expect("idle durable recovery poll");
}

#[test]
fn accepts_intent_only_for_the_local_signer() {
    let keys = Keys::generate();
    let rest = rest(keys.clone());
    assert!(validate_intent(&intent(keys.public_key().to_hex()), &rest).is_ok());
    let other = Keys::generate();
    assert!(validate_intent(&intent(other.public_key().to_hex()), &rest).is_err());
}

#[test]
fn retries_sign_the_same_event_without_using_the_wall_clock() {
    let keys = Keys::generate();
    for kind in [9, buzz_sdk::kind::KIND_AGENT_STATUS as u16] {
        let build = || EventBuilder::new(Kind::Custom(kind), "the same contribution");
        let first = sign_publication_event(build(), &keys, 1_788_811_000).unwrap();
        let retry = sign_publication_event(build(), &keys, 1_788_811_000).unwrap();
        assert_eq!(first.id, retry.id);
        assert_eq!(first.created_at.as_secs(), 1_788_811_000);
        first.verify().unwrap();
        retry.verify().unwrap();
        assert_ne!(
            first.id,
            sign_publication_event(build(), &keys, 1_788_811_001)
                .unwrap()
                .id
        );
    }
    let mut invalid = intent(keys.public_key().to_hex());
    let client = rest(keys);
    for timestamp in [0, u64::MAX] {
        invalid.event_created_at = timestamp;
        assert!(validate_intent(&invalid, &client).is_err());
    }
    let mut missing = serde_json::to_value(&invalid).unwrap();
    missing.as_object_mut().unwrap().remove("event_created_at");
    assert!(serde_json::from_value::<LocalPublicationIntent>(missing).is_err());
}

#[test]
fn recovered_output_is_bounded_and_bound_to_this_signer_and_community() {
    let keys = Keys::generate();
    let saved = intent(keys.public_key().to_hex());
    let worker = LocalPublicationWorker {
        rest: rest(keys),
        community_id: saved.community_id.clone(),
        completion_api_base_url: "http://127.0.0.1".into(),
        internal_token: "test-token".into(),
    };
    let decoded = worker
        .parse_recovered_publications(serde_json::json!({"publications": [saved]}))
        .unwrap();
    assert_eq!(decoded[0].content, saved.content);
    assert_eq!(decoded[0].fence_id, saved.fence_id);
    assert_eq!(decoded[0].event_created_at, saved.event_created_at);
    let mut foreign = saved.clone();
    foreign.community_id = "other-community".into();
    assert!(worker
        .parse_recovered_publications(serde_json::json!({"publications": [foreign]}))
        .is_err());
    foreign = saved.clone();
    foreign.agent_public_key = Keys::generate().public_key().to_hex();
    assert!(worker
        .parse_recovered_publications(serde_json::json!({"publications": [foreign]}))
        .is_err());
    assert!(worker
        .parse_recovered_publications(serde_json::json!({"publications": vec![saved; 5]}))
        .is_err());
}

#[test]
fn rejects_unknown_publication_fields_and_kinds() {
    let keys = Keys::generate();
    let mut value = serde_json::to_value(intent(keys.public_key().to_hex())).unwrap();
    value["private_key"] = serde_json::json!("must-not-cross-boundary");
    assert!(serde_json::from_value::<LocalPublicationIntent>(value).is_err());

    let mut invalid = intent(keys.public_key().to_hex());
    invalid.publication_kind = "arbitrary_write".to_string();
    assert!(validate_intent(&invalid, &rest(keys)).is_err());
}

#[test]
fn operational_status_is_never_chat_or_deletion() {
    let keys = Keys::generate();
    for kind in ["receipt", "progress", "capacity", "error", "cancelled"] {
        let mut status = intent(keys.public_key().to_hex());
        status.publication_kind = kind.into();
        assert_eq!(publication_event_kind(&status), 40098);
        assert_eq!(publication_event_kind(&status), 40098);
    }
    assert_eq!(
        publication_event_kind(&intent(keys.public_key().to_hex())),
        9
    );
}

#[test]
fn accepts_scoped_action_publications_claimed_by_the_bridge() {
    let keys = Keys::generate();
    let rest = rest(keys.clone());
    let mut action = intent(keys.public_key().to_hex());
    action.publication_kind = "action".to_string();

    assert!(validate_intent(&action, &rest).is_ok());
}

#[test]
fn coalesces_queued_progress_per_receipt_without_cross_receipt_loss() {
    let keys = Keys::generate();
    let mut first = intent(keys.public_key().to_hex());
    first.receipt_id = "receipt-one".to_string();
    first.publication_kind = "progress".to_string();
    first.content = "Preparing capacity...".to_string();
    let mut latest = first.clone();
    latest.fence_id = Uuid::new_v4().to_string();
    latest.content = "Starting Codex...".to_string();
    let mut other = first.clone();
    other.receipt_id = "receipt-two".to_string();
    other.fence_id = Uuid::new_v4().to_string();
    other.content = "Preparing another turn...".to_string();

    let mut state = LocalPublicationQueueState::default();
    state.accept(first);
    state.accept(latest.clone());
    state.accept(other.clone());

    assert_eq!(state.pending.len(), 2);
    assert_eq!(
        state.take_next().map(|item| item.content),
        Some(latest.content)
    );
    assert_eq!(
        state.take_next().map(|item| item.content),
        Some(other.content)
    );
}

#[test]
fn terminal_output_discards_pending_and_late_progress_for_its_receipt() {
    let keys = Keys::generate();
    let mut progress = intent(keys.public_key().to_hex());
    progress.receipt_id = "terminal-receipt".to_string();
    progress.publication_kind = "progress".to_string();
    let mut terminal = progress.clone();
    terminal.fence_id = Uuid::new_v4().to_string();
    terminal.publication_kind = "final".to_string();
    terminal.content = "Finished".to_string();
    let mut late_progress = progress.clone();
    late_progress.fence_id = Uuid::new_v4().to_string();

    let mut state = LocalPublicationQueueState::default();
    state.accept(progress);
    state.accept(terminal.clone());
    state.accept(late_progress);

    assert_eq!(
        state.take_next().map(|item| item.fence_id),
        Some(terminal.fence_id)
    );
    assert!(state.take_next().is_none());
    assert!(state.terminal_receipts.contains_key("terminal-receipt"));
}

#[test]
fn terminal_preempts_status_but_not_same_turn_action_creation() {
    let keys = Keys::generate();
    let mut receipt = intent(keys.public_key().to_hex());
    receipt.publication_kind = "receipt".to_string();
    receipt.fence_id = "surface-fence".to_string();
    let mut progress = receipt.clone();
    progress.publication_kind = "progress".to_string();
    progress.fence_id = "progress-fence".to_string();
    let mut terminal = progress.clone();
    terminal.publication_kind = "final".to_string();
    terminal.fence_id = "terminal-fence".to_string();
    let mut action = progress.clone();
    action.publication_kind = "action".to_string();
    action.fence_id = "action-fence".to_string();
    let mut unrelated_action = action.clone();
    unrelated_action.receipt_id = "another-receipt".to_string();

    let state = LocalPublicationQueueState::default();
    assert!(!state.should_preempt(&progress, &progress));
    assert!(state.should_preempt(&progress, &terminal));
    assert!(state.should_preempt(&receipt, &terminal));
    assert!(!state.should_preempt(&action, &terminal));
    assert!(state.should_preempt(&unrelated_action, &terminal));
    let mut cancelled = terminal.clone();
    cancelled.publication_kind = "cancelled".into();
    cancelled.fence_id = "cancelled-fence".into();
    assert!(state.should_preempt(&action, &cancelled));
    assert!(state.should_preempt(&terminal, &cancelled));
    let mut queued = LocalPublicationQueueState::default();
    queued.accept(cancelled.clone());
    queued.requeue_preempted(terminal);
    assert_eq!(queued.take_next().unwrap().fence_id, cancelled.fence_id);
    assert_eq!(queued.take_next().unwrap().publication_kind, "final");
}

#[test]
fn publication_retry_backoff_is_fast_then_bounded() {
    assert_eq!(publication_retry_delay(1), Duration::from_millis(100));
    assert_eq!(publication_retry_delay(4), Duration::from_secs(1));
    assert_eq!(publication_retry_delay(9), Duration::from_secs(30));
    assert_eq!(publication_retry_delay(10_000), Duration::from_secs(30));

    let keys = Keys::generate();
    let mut status = intent(keys.public_key().to_hex());
    status.publication_kind = "progress".to_string();
    assert_eq!(
        publication_retry_max_elapsed(&status),
        STATUS_PUBLISH_RETRY_MAX_ELAPSED
    );
    status.publication_kind = "final".to_string();
    assert_eq!(
        publication_retry_max_elapsed(&status),
        PUBLISH_RETRY_MAX_ELAPSED
    );
}

#[test]
fn local_caches_are_bounded_without_a_discussion_turn_limit() {
    let keys = Keys::generate();
    let template = intent(keys.public_key().to_hex());
    let mut state = LocalPublicationQueueState::default();
    for index in 0..10_000 {
        let mut next = template.clone();
        next.receipt_id = format!("receipt-{index}");
        next.fence_id = format!("fence-{index}");
        state.accept(next);
        assert!(state.pending.len() <= PUBLICATION_QUEUE_CAPACITY);
        assert!(state.terminal_receipts.len() <= TERMINAL_RECEIPT_CACHE_CAPACITY);
    }
    state.pending.clear();
    state.accept(template.clone());
    state.accept(template.clone());
    assert_eq!(state.pending.len(), 1);
    state.terminal_receipts.insert(
        "expired".into(),
        Instant::now() - TERMINAL_RECEIPT_RETENTION,
    );
    state.prune_terminal_receipts();
    assert!(!state.terminal_receipts.contains_key("expired"));
    assert_eq!(state.take_next().unwrap().fence_id, template.fence_id);
}

#[tokio::test]
async fn deferred_delivery_never_submits_or_completes_an_event() {
    tokio::time::timeout(Duration::from_secs(3), async {
        let keys = Keys::generate();
        let saved = intent(keys.public_key().to_hex());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let worker = LocalPublicationWorker {
            rest: RestClient {
                base_url: base.clone(),
                ..rest(keys)
            },
            community_id: saved.community_id.clone(),
            completion_api_base_url: base,
            internal_token: "test-token".into(),
        };
        let fence = saved.fence_id.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let (headers, _) = receive_http(&mut stream).await;
            assert!(headers.starts_with(&format!(
                "POST /api/buzz-bridge/publications/{fence}/authorize "
            )));
            respond_http(
                &mut stream,
                200,
                serde_json::json!({"should_publish": false}),
            )
            .await;
            assert!(
                tokio::time::timeout(Duration::from_millis(100), listener.accept())
                    .await
                    .is_err()
            );
        });
        assert!(worker.publish_with_retry(&saved).await.is_none());
        server.await.unwrap();
    })
    .await
    .unwrap();
}

#[test]
fn batched_answer_never_overtakes_its_queued_actions() {
    let keys = Keys::generate();
    let answer = intent(keys.public_key().to_hex());
    let mut first = answer.clone();
    first.fence_id = Uuid::new_v4().to_string();
    first.publication_kind = "action".into();
    let mut second = first.clone();
    second.fence_id = Uuid::new_v4().to_string();
    let mut state = LocalPublicationQueueState::default();
    state.accept(first.clone());
    state.accept(second.clone());
    state.accept(answer.clone());
    assert_eq!(state.take_next().unwrap().fence_id, first.fence_id);
    assert_eq!(state.take_next().unwrap().fence_id, second.fence_id);
    assert_eq!(state.take_next().unwrap().fence_id, answer.fence_id);
}

async fn receive_http(stream: &mut tokio::net::TcpStream) -> (String, serde_json::Value) {
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0; 4096];
        let read = stream.read(&mut chunk).await.unwrap();
        assert!(read > 0, "HTTP request closed before its body");
        bytes.extend_from_slice(&chunk[..read]);
        assert!(bytes.len() <= 128 * 1024);
        let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") else {
            continue;
        };
        let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
        let size: usize = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse().unwrap())
            })
            .unwrap();
        if bytes.len() >= end + 4 + size {
            return (
                headers,
                serde_json::from_slice(&bytes[end + 4..end + 4 + size]).unwrap(),
            );
        }
    }
}

async fn respond_http(stream: &mut tokio::net::TcpStream, status: u16, value: serde_json::Value) {
    let body = value.to_string();
    let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    stream.write_all(response.as_bytes()).await.unwrap();
}

fn cancellation_batch(saved: &LocalPublicationIntent) -> serde_json::Value {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use buzz_core::managed_publication::{Authorization, Operation};
    use ed25519_dalek::{Signer, SigningKey};
    let response = authorization_response(&serde_json::to_value(saved).unwrap(), true);
    let mut authorization =
        Authorization::decode(response["runtime_authorization"].as_str().unwrap()).unwrap();
    authorization.claims.action = Operation::Cancel {
        user_request_event_id: "c".repeat(64),
    };
    let seed: [u8; 32] =
        hex::decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
            .unwrap()
            .try_into()
            .unwrap();
    authorization.signature = URL_SAFE_NO_PAD.encode(
        SigningKey::from_bytes(&seed)
            .sign(&authorization.claims.signing_bytes().unwrap())
            .to_bytes(),
    );
    serde_json::json!({ "publications": [], "cancellations": [{
        "cancellation_id": Uuid::new_v4().to_string(), "community_id": saved.community_id,
        "agent_public_key": saved.agent_public_key, "scope_kind": "discussion", "scope_id": saved.fence_id,
        "channel_id": saved.channel_id, "event_created_at": saved.event_created_at,
        "runtime_authorization": URL_SAFE_NO_PAD.encode(serde_json::to_vec(&authorization).unwrap())
    }] })
}

#[tokio::test]
async fn explicit_stop_control_recovers_exactly_without_chat_lookup_or_deletion() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let keys = Keys::generate();
        let saved = intent(keys.public_key().to_hex());
        let batch = cancellation_batch(&saved);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let worker = LocalPublicationWorker {
            rest: RestClient {
                base_url: base.clone(),
                ..rest(keys)
            },
            community_id: saved.community_id.clone(),
            completion_api_base_url: base,
            internal_token: "stop-recovery-token".into(),
        };
        let server = tokio::spawn(async move {
            let cancellation = &batch["cancellations"][0];
            let mut event_ids = Vec::new();
            for step in 0..6 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let (headers, body) = receive_http(&mut stream).await;
                let path = match step % 3 {
                    0 => "/api/buzz-bridge/publications/recover".to_string(),
                    1 => "/events".to_string(),
                    _ => format!(
                        "/api/buzz-bridge/cancellations/{}/complete",
                        cancellation["cancellation_id"].as_str().unwrap()
                    ),
                };
                assert!(
                    headers.starts_with(&format!("POST {path} ")),
                    "no chat/deletion operation belongs in this flow: {headers}"
                );
                match step % 3 {
                    0 => respond_http(&mut stream, 200, batch.clone()).await,
                    1 => {
                        let event: nostr::Event = serde_json::from_value(body).unwrap();
                        event.verify().unwrap();
                        assert_eq!(event.kind.as_u16(), 40097);
                        assert_eq!(event.created_at.as_secs(), saved.event_created_at);
                        assert_eq!(event.content, cancellation["runtime_authorization"]);
                        let expected_tags = vec![
                            vec!["h".to_string(), saved.channel_id.clone()],
                            vec![
                                "d".to_string(),
                                format!("buzz-user-cancellation:{}", saved.fence_id),
                            ],
                        ];
                        assert_eq!(
                            event
                                .tags
                                .iter()
                                .map(|tag| tag.as_slice().to_vec())
                                .collect::<Vec<_>>(),
                            expected_tags
                        );
                        use buzz_core::managed_publication::{
                            TrustedIssuer, VerifiedAuthorization,
                        };
                        let public_key: [u8; 32] = hex::decode(
                            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
                        )
                        .unwrap()
                        .try_into()
                        .unwrap();
                        VerifiedAuthorization::cancellation(
                            &event.content,
                            TrustedIssuer {
                                community: buzz_core::CommunityId::from_uuid(Uuid::new_v4()),
                                audience: "relay.example",
                                issuer: &saved.community_id,
                                key_id: "runtime-1",
                                public_key: &public_key,
                            },
                        )
                        .unwrap();
                        event_ids.push(event.id.to_hex());
                        respond_http(&mut stream, 200, serde_json::json!({"accepted": true})).await;
                    }
                    _ => {
                        assert_eq!(body["buzz_event_id"], event_ids.last().unwrap().as_str());
                        assert_eq!(body["community_id"], saved.community_id);
                        // First acknowledgement is lost; next recovery carries
                        // the exact same signed non-chat event and token.
                        respond_http(
                            &mut stream,
                            if step == 2 { 503 } else { 200 },
                            serde_json::json!({"status": "confirmed"}),
                        )
                        .await;
                    }
                }
            }
            assert_eq!(event_ids.len(), 2);
            assert_eq!(event_ids[0], event_ids[1]);
            assert!(
                tokio::time::timeout(Duration::from_millis(100), listener.accept())
                    .await
                    .is_err()
            );
        });
        assert!(worker
            .recover_saved_publications()
            .await
            .unwrap()
            .is_empty());
        assert!(worker
            .recover_saved_publications()
            .await
            .unwrap()
            .is_empty());
        server.await.unwrap();
    })
    .await
    .expect("bounded explicit Stop recovery regression");
}

#[tokio::test]
async fn control_batch_rejects_foreign_identity_and_ordinary_publication_authority_before_any_write(
) {
    let keys = Keys::generate();
    let saved = intent(keys.public_key().to_hex());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let worker = LocalPublicationWorker {
        rest: RestClient {
            base_url: base.clone(),
            ..rest(keys)
        },
        community_id: saved.community_id.clone(),
        completion_api_base_url: base,
        internal_token: "control-validation-token".into(),
    };
    for field in [
        "community_id",
        "agent_public_key",
        "scope_id",
        "channel_id",
        "runtime_authorization",
    ] {
        let mut batch = cancellation_batch(&saved);
        batch["cancellations"][0][field] = if field == "runtime_authorization" {
            authorization_response(&serde_json::to_value(&saved).unwrap(), true)
                ["runtime_authorization"]
                .clone()
        } else {
            serde_json::json!("foreign")
        };
        assert!(worker.deliver_runtime_cancellations(&batch).await.is_err());
    }
    assert!(worker
        .deliver_runtime_cancellations(&serde_json::json!({"publications": []}))
        .await
        .is_err());
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn missing_or_substituted_runtime_authority_never_reaches_relay_or_completion() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use buzz_core::managed_publication::{Authorization, Operation};
    tokio::time::timeout(Duration::from_secs(5), async {
        let keys = Keys::generate();
        let saved = intent(keys.public_key().to_hex());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let worker = LocalPublicationWorker {
            rest: RestClient {
                base_url: base.clone(),
                ..rest(keys)
            },
            community_id: saved.community_id.clone(),
            completion_api_base_url: base,
            internal_token: "authority-rejection-test".into(),
        };
        let server = tokio::spawn(async move {
            for variant in [
                "missing",
                "malformed",
                "community",
                "receipt",
                "fence",
                "signer",
                "channel",
                "content",
                "cancel",
            ] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let (headers, body) = receive_http(&mut stream).await;
                assert!(
                    headers.contains("/authorize HTTP/1.1"),
                    "rejected authority must not cause another operation: {headers}"
                );
                let mut response = authorization_response(&body, true);
                let mut authority =
                    Authorization::decode(response["runtime_authorization"].as_str().unwrap())
                        .unwrap();
                match variant {
                    "community" => authority.claims.issuer = "foreign-community".into(),
                    "receipt" => {
                        if let Operation::Publish { receipt_id, .. } = &mut authority.claims.action
                        {
                            *receipt_id = Uuid::new_v4().to_string();
                        }
                    }
                    "fence" => {
                        if let Operation::Publish { fence_id, .. } = &mut authority.claims.action {
                            *fence_id = Uuid::new_v4().to_string();
                        }
                    }
                    "signer" => {
                        if let Operation::Publish {
                            signer_public_key, ..
                        } = &mut authority.claims.action
                        {
                            *signer_public_key = "f".repeat(64);
                        }
                    }
                    "channel" => authority.claims.channel_id = Uuid::new_v4().to_string(),
                    "content" => {
                        if let Operation::Publish {
                            event_template_hash,
                            ..
                        } = &mut authority.claims.action
                        {
                            *event_template_hash = "f".repeat(64);
                        }
                    }
                    "cancel" => {
                        authority.claims.action = Operation::Cancel {
                            user_request_event_id: "c".repeat(64),
                        }
                    }
                    _ => {}
                }
                response["runtime_authorization"] = serde_json::json!(
                    URL_SAFE_NO_PAD.encode(serde_json::to_vec(&authority).unwrap())
                );
                if variant == "missing" {
                    response
                        .as_object_mut()
                        .unwrap()
                        .remove("runtime_authorization");
                }
                if variant == "malformed" {
                    response["runtime_authorization"] = serde_json::json!("invalid");
                }
                respond_http(&mut stream, 200, response).await;
            }
            assert!(
                tokio::time::timeout(Duration::from_millis(100), listener.accept())
                    .await
                    .is_err()
            );
        });
        for _ in 0..9 {
            assert!(worker.publish(&saved).await.is_err());
        }
        server.await.unwrap();
    })
    .await
    .expect("bounded runtime-authority rejection test");
}

#[tokio::test]
async fn cancellation_observation_preempts_a_stalled_answer_but_cannot_cancel_it_by_itself() {
    tokio::time::timeout(Duration::from_secs(8), async {
        for final_still_authorized in [false, true] {
            let keys = Keys::generate();
            let answer = intent(keys.public_key().to_hex());
            let mut cancelled = answer.clone();
            cancelled.fence_id = Uuid::new_v4().to_string();
            cancelled.publication_kind = "cancelled".into();
            cancelled.content = "Cancellation observed.".into();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let worker = Arc::new(LocalPublicationWorker {
                rest: RestClient {
                    base_url: base.clone(),
                    ..rest(keys)
                },
                community_id: answer.community_id.clone(),
                completion_api_base_url: base,
                internal_token: "preemption-test-token".into(),
            });
            let (sender, mut receiver) = mpsc::channel(4);
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let answer_fence = answer.fence_id.clone();
            let cancel_fence = cancelled.fence_id.clone();
            let server = tokio::spawn(async move {
                let mut started_tx = Some(started_tx);
                let mut stalled_request = None;
                let mut published_kinds = Vec::new();
                for step in 0..if final_still_authorized { 9 } else { 6 } {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let (headers, body) = receive_http(&mut stream).await;
                    let path = match step {
                        0 | 5 => format!("/api/buzz-bridge/publications/{answer_fence}/authorize"),
                        1 => format!("/api/buzz-bridge/publications/{cancel_fence}/authorize"),
                        2 | 6 => "/query".into(),
                        3 | 7 => "/events".into(),
                        4 => format!("/api/buzz-bridge/publications/{cancel_fence}/complete"),
                        _ => format!("/api/buzz-bridge/publications/{answer_fence}/complete"),
                    };
                    assert!(
                        headers.starts_with(&format!("POST {path} ")),
                        "step {step}: {headers}"
                    );
                    match step {
                        0 => {
                            // Keep the original request unresolved until the test ends.
                            stalled_request = Some(stream);
                            started_tx.take().unwrap().send(()).unwrap();
                        }
                        1 | 5 => {
                            respond_http(
                                &mut stream,
                                200,
                                authorization_response(&body, step == 1 || final_still_authorized),
                            )
                            .await
                        }
                        2 | 6 => respond_http(&mut stream, 200, serde_json::json!([])).await,
                        3 | 7 => {
                            let event: nostr::Event = serde_json::from_value(body).unwrap();
                            event.verify().unwrap();
                            published_kinds.push(event.kind.as_u16());
                            respond_http(&mut stream, 200, serde_json::json!({"accepted": true}))
                                .await;
                        }
                        _ => {
                            respond_http(&mut stream, 200, serde_json::json!({"completed": true}))
                                .await
                        }
                    }
                }
                assert_eq!(
                    published_kinds,
                    if final_still_authorized {
                        vec![40098, 9]
                    } else {
                        vec![40098]
                    }
                );
                assert!(
                    tokio::time::timeout(Duration::from_millis(100), listener.accept())
                        .await
                        .is_err()
                );
                drop(stalled_request);
            });
            sender.send(answer).await.unwrap();
            let running = tokio::spawn(async move { worker.run(&mut receiver).await });
            started_rx.await.unwrap();
            sender.send(cancelled).await.unwrap();
            drop(sender);
            running.await.unwrap();
            server.await.unwrap();
        }
    })
    .await
    .expect("bounded cancellation preemption regression");
}

#[tokio::test]
async fn continuous_live_delivery_does_not_reset_durable_recovery_deadline() {
    tokio::time::timeout(Duration::from_secs(9), async {
        let keys = Keys::generate();
        let mut progress = intent(keys.public_key().to_hex());
        progress.publication_kind = "progress".into();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let worker = Arc::new(LocalPublicationWorker {
            rest: RestClient {
                base_url: base.clone(),
                ..rest(keys)
            },
            community_id: progress.community_id.clone(),
            completion_api_base_url: base,
            internal_token: "fairness-test-token".into(),
        });
        let (sender, mut receiver) = mpsc::channel(4);
        let (recovered_tx, mut recovered_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut recovered_tx = Some(recovered_tx);
            let mut live_requests = 0;
            loop {
                let connection =
                    tokio::time::timeout(Duration::from_millis(200), listener.accept()).await;
                let Ok(Ok((mut stream, _))) = connection else {
                    assert!(
                        recovered_tx.is_none(),
                        "continuous input hid the recovery deadline"
                    );
                    break;
                };
                let (headers, _) = receive_http(&mut stream).await;
                if headers.starts_with("POST /api/buzz-bridge/publications/recover ") {
                    assert!(live_requests > 20);
                    respond_http(
                        &mut stream,
                        200,
                        serde_json::json!({"cancellations": [], "publications": []}),
                    )
                    .await;
                    if let Some(tx) = recovered_tx.take() {
                        tx.send(()).unwrap();
                    }
                } else {
                    assert!(headers.contains("/authorize HTTP/1.1"));
                    live_requests += 1;
                    respond_http(
                        &mut stream,
                        200,
                        serde_json::json!({"should_publish": false}),
                    )
                    .await;
                }
            }
        });
        let running = tokio::spawn(async move { worker.run(&mut receiver).await });
        let mut sent = 0;
        loop {
            tokio::select! {
                _ = &mut recovered_rx => break,
                _ = tokio::time::sleep(Duration::from_millis(5)) => {
                    sender.send(progress.clone()).await.unwrap();
                    sent += 1;
                }
            }
        }
        assert!(sent > 20);
        drop(sender);
        running.await.unwrap();
        server.await.unwrap();
    })
    .await
    .expect("durable recovery during continuous live delivery");
}

#[tokio::test]
async fn http_reconciliation_acknowledges_only_the_exact_verified_event() {
    tokio::time::timeout(Duration::from_secs(10), async {
        for publication_kind in ["final", "cancelled"] {
            // Public test vector shared with the API's canonical hash verifier.
            let keys = Keys::parse(&format!("{}1", "0".repeat(63))).unwrap();
            let mut saved = intent(keys.public_key().to_hex());
            saved.fence_id = "11111111-1111-4111-8111-111111111111".into();
            saved.receipt_id = "22222222-2222-4222-8222-222222222222".into();
            saved.channel_id = "33333333-3333-4333-8333-333333333333".into();
            saved.community_id = "kiingo-prod".into();
            saved.publication_kind = publication_kind.into();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let worker = LocalPublicationWorker {
                rest: RestClient {
                    base_url: base.clone(),
                    ..rest(keys.clone())
                },
                community_id: saved.community_id.clone(),
                completion_api_base_url: base,
                internal_token: "reconciliation-test-token".into(),
            };
            let server_saved = saved.clone();
            let server = tokio::spawn(async move {
                let mut published: Option<nostr::Event> = None;
                for variant in [
                    "initial",
                    "exact",
                    "content",
                    "signature",
                    "substitute",
                    "malformed",
                    "non-array",
                    "extra",
                ] {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let (headers, body) = receive_http(&mut stream).await;
                    assert!(headers.starts_with(&format!(
                        "POST /api/buzz-bridge/publications/{}/authorize ",
                        server_saved.fence_id
                    )));
                    assert_eq!(body, serde_json::to_value(&server_saved).unwrap());
                    respond_http(&mut stream, 200, authorization_response(&body, true)).await;

                    let (mut stream, _) = listener.accept().await.unwrap();
                    let (headers, body) = receive_http(&mut stream).await;
                    assert!(headers.starts_with("POST /query "));
                    let filter = &body[0];
                    assert_eq!(
                        filter["kinds"],
                        serde_json::json!([publication_event_kind(&server_saved)])
                    );
                    assert_eq!(
                        filter["authors"],
                        serde_json::json!([server_saved.agent_public_key])
                    );
                    assert_eq!(filter["#h"], serde_json::json!([server_saved.channel_id]));
                    assert_eq!(
                        filter["#d"],
                        serde_json::json!([format!(
                            "buzz-local-publication:{}",
                            server_saved.fence_id
                        )])
                    );
                    assert_eq!(filter["limit"], 1);
                    let response = if let Some(event) = &published {
                        assert_eq!(filter["ids"], serde_json::json!([event.id.to_hex()]));
                        let mut value = serde_json::to_value(event).unwrap();
                        match variant {
                            "content" => {
                                value["content"] =
                                    serde_json::json!("forged output with unchanged id")
                            }
                            "signature" => value["sig"] = serde_json::json!("00".repeat(64)),
                            "substitute" => {
                                let other = sign_publication_event(
                                    EventBuilder::new(event.kind, "different signed output")
                                        .tags(event.tags.clone()),
                                    &keys,
                                    server_saved.event_created_at,
                                )
                                .unwrap();
                                other.verify().unwrap();
                                value = serde_json::to_value(other).unwrap();
                            }
                            "malformed" => value = serde_json::json!({"id": event.id.to_hex()}),
                            _ => {}
                        }
                        match variant {
                            "non-array" => serde_json::json!({"error": "not an event list"}),
                            "extra" => serde_json::json!([value.clone(), value]),
                            _ => serde_json::json!([value]),
                        }
                    } else {
                        serde_json::json!([])
                    };
                    respond_http(&mut stream, 200, response).await;
                    if variant == "initial" {
                        let (mut stream, _) = listener.accept().await.unwrap();
                        let (headers, body) = receive_http(&mut stream).await;
                        assert!(headers.starts_with("POST /events "));
                        let event: nostr::Event = serde_json::from_value(body).unwrap();
                        event.verify().unwrap();
                        assert_eq!(filter["ids"], serde_json::json!([event.id.to_hex()]));
                        published = Some(event);
                        respond_http(&mut stream, 200, serde_json::json!({"accepted": true})).await;
                    }
                    if matches!(variant, "initial" | "exact") {
                        let (mut stream, _) = listener.accept().await.unwrap();
                        let (headers, body) = receive_http(&mut stream).await;
                        assert!(headers.starts_with(&format!(
                            "POST /api/buzz-bridge/publications/{}/complete ",
                            server_saved.fence_id
                        )));
                        assert_eq!(
                            body["buzz_event_id"],
                            published.as_ref().unwrap().id.to_hex()
                        );
                        respond_http(&mut stream, 200, serde_json::json!({"status": "published"}))
                            .await;
                    }
                }
                // No corrupt lookup may submit or acknowledge output, including the last case.
                assert!(
                    tokio::time::timeout(Duration::from_millis(100), listener.accept())
                        .await
                        .is_err()
                );
            });
            let initial_id = worker.publish(&saved).await.unwrap();
            if publication_kind == "final" {
                assert_eq!(
                    initial_id.as_deref(),
                    Some("31fb6eb2c36dd3d28f11c570e68003eef98ca1f375090dc8d0de59ed156a0579")
                );
            } else {
                assert_eq!(
                    initial_id.as_deref(),
                    Some("f336c91cc5312ff9de1027e6e6c7e8bdf9bac28cd5640e0ad5bd8a704efeb7a1")
                );
            }
            assert_eq!(worker.publish(&saved).await.unwrap(), initial_id);
            for _ in 0..6 {
                assert!(worker
                    .publish(&saved)
                    .await
                    .unwrap_err()
                    .contains("publication reconciliation"));
            }
            server.await.unwrap();
        }
    })
    .await
    .expect("bounded exact-event reconciliation regression");
}

#[tokio::test]
async fn http_recovery_preserves_event_identity_after_publisher_and_acknowledgement_loss() {
    tokio::time::timeout(Duration::from_secs(12), async {
        let keys = Keys::generate();
        let saved = intent(keys.public_key().to_hex());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let worker = || LocalPublicationWorker {
            rest: RestClient { base_url: base.clone(), ..rest(keys.clone()) },
            community_id: saved.community_id.clone(),
            completion_api_base_url: base.clone(),
            internal_token: "local-recovery-test-token".into(),
        };
        let response_saved = saved.clone();
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let (lost_tx, lost_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut accepted_tx = Some(accepted_tx);
            let mut lost_rx = Some(lost_rx);
            let mut submitted = Vec::new();
            let mut completions = Vec::new();
            for step in 0..11 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let (headers, body) = receive_http(&mut stream).await;
                let expected_path = match step {
                    0 | 1 | 5 => "/api/buzz-bridge/publications/recover".to_string(),
                    2 | 6 => format!("/api/buzz-bridge/publications/{}/authorize", response_saved.fence_id),
                    3 | 7 => "/query".into(),
                    4 | 8 => "/events".into(),
                    _ => format!("/api/buzz-bridge/publications/{}/complete", response_saved.fence_id),
                };
                assert!(headers.starts_with(&format!("POST {expected_path} HTTP/1.1")), "step {step}: {headers}");
                if expected_path.starts_with("/api/") {
                    assert!(headers.to_lowercase().contains("authorization: bearer local-recovery-test-token"));
                } else {
                    assert!(headers.to_lowercase().contains("authorization: nostr "));
                    assert!(!headers.contains("local-recovery-test-token"));
                }
                match step {
                    0 => respond_http(&mut stream, 503, serde_json::json!({"error": "temporarily unavailable"})).await,
                    1 | 5 => {
                        assert_eq!(body, serde_json::json!({"community_id": response_saved.community_id, "agent_public_key": response_saved.agent_public_key}));
                        respond_http(&mut stream, 200, serde_json::json!({"cancellations": [], "publications": [response_saved]})).await;
                    }
                    // Deliberately emulate delayed lookup visibility after relay acceptance.
                    2 | 6 => {
                        assert_eq!(body, serde_json::to_value(&response_saved).unwrap());
                        respond_http(&mut stream, 200, authorization_response(&body, true)).await;
                    }
                    3 | 7 => respond_http(&mut stream, 200, serde_json::json!([])).await,
                    4 | 8 => {
                        let event: nostr::Event = serde_json::from_value(body).unwrap();
                        event.verify().unwrap();
                        assert_eq!(event.content, response_saved.content);
                        assert_eq!(event.created_at.as_secs(), response_saved.event_created_at);
                        submitted.push(event.id.to_hex());
                        if step == 4 {
                            accepted_tx.take().unwrap().send(()).unwrap();
                            lost_rx.take().unwrap().await.unwrap();
                            // Acceptance had no response; all first-publisher memory is now gone.
                        } else { respond_http(&mut stream, 200, serde_json::json!({"accepted": true})).await; }
                    }
                    _ => {
                        completions.push(body);
                        // Lose the first completion acknowledgement as well.
                        if step == 10 { respond_http(&mut stream, 200, serde_json::json!({"status": "published"})).await; }
                    }
                }
            }
            (submitted, completions)
        });
        assert!(worker().recover_saved_publications().await.is_err());
        let initial = worker();
        let admitted = initial.recover_saved_publications().await.unwrap().remove(0);
        let publishing = tokio::spawn(async move { initial.publish(&admitted).await });
        accepted_rx.await.unwrap();
        publishing.abort();
        assert!(publishing.await.unwrap_err().is_cancelled());
        lost_tx.send(()).unwrap();
        let replacement = worker();
        let recovered = replacement.recover_saved_publications().await.unwrap().remove(0);
        let final_id = replacement.publish_with_retry(&recovered).await.unwrap();
        let (submitted, completions) = server.await.unwrap();
        assert_eq!(submitted, vec![final_id.clone(), final_id.clone()]);
        assert_eq!(completions.len(), 2);
        assert_eq!(completions[0], completions[1]);
        assert_eq!(completions[0]["buzz_event_id"], final_id);
        assert_eq!(completions[0]["receipt_id"], saved.receipt_id);
    }).await.expect("bounded HTTP recovery regression");
}

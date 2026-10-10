//! End-to-end tests for [`GuestRuntime`] against an in-process mock that
//! serves both the relay bridge (`/query`, `/events`) and the hosted guest
//! route (`/route/...`).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use nostr::{EventBuilder, Keys, Kind, Tag};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;

#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    auth: Option<String>,
    body: Value,
    raw_body: Vec<u8>,
}

#[derive(Default)]
struct MockState {
    seen: Vec<Seen>,
    outbox_served: bool,
    turn_response: Option<Value>,
}

struct Mock {
    base_url: String,
    state: Arc<Mutex<MockState>>,
}

impl Mock {
    fn seen(&self, path_prefix: &str) -> Vec<Seen> {
        self.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .filter(|s| s.path.starts_with(path_prefix))
            .cloned()
            .collect()
    }

    async fn wait_for(&self, path_prefix: &str, count: usize) -> Vec<Seen> {
        for _ in 0..200 {
            let seen = self.seen(path_prefix);
            if seen.len() >= count {
                return seen;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!(
            "timed out waiting for {count} request(s) to {path_prefix}; saw {:?}",
            self.state
                .lock()
                .unwrap()
                .seen
                .iter()
                .map(|s| s.path.clone())
                .collect::<Vec<_>>()
        );
    }
}

async fn read_request(
    socket: &mut tokio::net::TcpStream,
) -> Option<(String, String, Option<String>, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.lines();
    let request_line = lines.next()?.to_string();
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut content_length = 0usize;
    let mut auth = None;
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            content_length = v.trim().parse().unwrap_or(0);
        }
        if lower.starts_with("authorization:") {
            auth = Some(line["authorization:".len()..].trim().to_string());
        }
    }
    let mut body = buf[header_end..].to_vec();
    while body.len() < content_length {
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Some((method, path, auth, body))
}

async fn mock() -> Mock {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let state = Arc::new(Mutex::new(MockState::default()));
    let server_state = state.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let state = server_state.clone();
            tokio::spawn(async move {
                let Some((method, path, auth, raw_body)) = read_request(&mut socket).await else {
                    return;
                };
                let body: Value = serde_json::from_slice(&raw_body).unwrap_or(Value::Null);
                let response = {
                    let mut state = state.lock().unwrap();
                    state.seen.push(Seen {
                        method: method.clone(),
                        path: path.clone(),
                        auth,
                        body: body.clone(),
                        raw_body: raw_body.clone(),
                    });
                    if path.starts_with("/query") {
                        Some(json!([]))
                    } else if path.starts_with("/events") {
                        Some(json!({"accepted": true, "message": ""}))
                    } else if path.starts_with("/route/agents/register") {
                        Some(
                            json!({"guest_endpoint_id": "e1", "status": "active", "classifier_mode": "shadow"}),
                        )
                    } else if path.starts_with("/route/turns") {
                        Some(state.turn_response.clone().unwrap_or_else(
                            || json!({"guest_turn_id": "turn-1", "state": "queued", "tier": 0}),
                        ))
                    } else if path.starts_with("/route/outbox?") {
                        if state.outbox_served {
                            None
                        } else {
                            state.outbox_served = true;
                            Some(json!({
                                "items": [{
                                    "publication_id": "pub-1",
                                    "guest_turn_id": "turn-1",
                                    "kind": "answer",
                                    "channel_id": Uuid::nil().to_string(),
                                    "reply_to_event_id": "a".repeat(64),
                                    "thread_root_event_id": null,
                                    "content": "Ross is free after 3pm.",
                                    "tags": [["buzz-guest", "b".repeat(64)], ["buzz-guest-turn", "turn-1"]],
                                    "mentions": ["b".repeat(64)],
                                    "expires_at": null
                                }],
                                "next_cursor": "c1"
                            }))
                        }
                    } else {
                        Some(json!({"ok": true}))
                    }
                };
                let body = match response {
                    Some(body) => body.to_string(),
                    None => {
                        // Long-poll with nothing ready.
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        json!({"items": [], "next_cursor": "c1"}).to_string()
                    }
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    Mock { base_url, state }
}

const OWNER: &str = "1111111111111111111111111111111111111111111111111111111111111111";

fn runtime(mock: &Mock, keys: &Keys, route: bool, respond_to: RespondTo) -> Arc<GuestRuntime> {
    let rest = RestClient {
        http: reqwest::Client::new(),
        base_url: mock.base_url.clone(),
        keys: keys.clone(),
        auth_tag_json: None,
    };
    Arc::new(GuestRuntime::new(
        GuestRuntimeConfig {
            mode: GuestTurns::Hosted,
            route_url: route.then(|| format!("{}/route", mock.base_url)),
            community_id: "community.test".into(),
            relay_url: "ws://127.0.0.1".into(),
            respond_to,
            static_allowlist: HashSet::new(),
            guest_instructions: None,
        },
        rest,
        keys.clone(),
        Some(OWNER.into()),
        None,
    ))
}

fn guest_message(guest: &Keys, agent: &Keys, text: &str) -> Event {
    EventBuilder::new(Kind::Custom(9), text)
        .tags([
            Tag::parse(["h", &Uuid::nil().to_string()]).unwrap(),
            Tag::parse(["p", &agent.public_key().to_hex()]).unwrap(),
        ])
        .sign_with_keys(guest)
        .unwrap()
}

fn verify_nip98(seen: &Seen, base_url: &str, agent: &Keys) {
    let header = seen.auth.as_deref().expect("authorization header");
    let encoded = header.strip_prefix("Nostr ").expect("Nostr scheme");
    let json = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .expect("base64");
    let auth: Event = serde_json::from_slice(&json).expect("auth event");
    buzz_core::verify_event(&auth).expect("auth signature");
    assert_eq!(auth.pubkey, agent.public_key(), "signed by the agent key");
    let tag = |name: &str| {
        auth.tags
            .iter()
            .find(|t| t.as_slice()[0] == name)
            .map(|t| t.as_slice()[1].clone())
    };
    assert_eq!(tag("u"), Some(format!("{base_url}{}", seen.path)));
    assert_eq!(tag("method").as_deref(), Some(seen.method.as_str()));
    if !seen.raw_body.is_empty() {
        assert_eq!(
            tag("payload"),
            Some(hex::encode(Sha256::digest(&seen.raw_body)))
        );
    }
}

#[tokio::test]
async fn guest_event_is_routed_with_its_signed_event_and_never_answered_locally() {
    let mock = mock().await;
    let agent = Keys::generate();
    let guest = Keys::generate();
    let runtime = runtime(&mock, &agent, true, RespondTo::Anyone);
    let event = guest_message(&guest, &agent, "what is ross working on?");
    let tier = runtime.classify(&event, false).await;
    assert_eq!(
        tier,
        TrustTier::Guest {
            requester: guest.public_key().to_hex()
        }
    );
    runtime.route(
        event.clone(),
        Uuid::nil(),
        false,
        Some("agent-lab".into()),
        tier,
        None,
    );

    let turns = mock.wait_for("/route/turns", 1).await;
    let body = &turns[0].body;
    assert_eq!(body["trigger_event"]["id"], json!(event.id.to_hex()));
    assert_eq!(body["trigger_event"]["sig"], json!(event.sig.to_string()));
    assert_eq!(body["harness_trust"], json!("guest"));
    assert_eq!(body["channel_type"], json!("channel"));
    assert_eq!(body["channel_name"], json!("agent-lab"));
    assert_eq!(body["community_id"], json!("community.test"));
    assert_eq!(body["relay_chain_status"], json!("none"));
    assert_eq!(body["author_profile_event"], Value::Null);
    verify_nip98(&turns[0], &mock.base_url, &agent);
    // Nothing published by the harness for a routed guest event.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(mock.seen("/events").is_empty());
}

#[tokio::test]
async fn outbox_items_are_published_verbatim_and_acked_with_the_signed_event() {
    let mock = mock().await;
    let agent = Keys::generate();
    let runtime = runtime(&mock, &agent, true, RespondTo::Anyone);
    let tasks = runtime.spawn_background();

    let published = mock.wait_for("/events", 1).await;
    let event: Event = serde_json::from_value(published[0].body.clone()).expect("event");
    buzz_core::verify_event(&event).expect("signed");
    assert_eq!(event.pubkey, agent.public_key());
    assert_eq!(event.content, "Ross is free after 3pm.");
    let acks = mock.wait_for("/route/outbox/pub-1/ack", 1).await;
    assert_eq!(acks[0].body["event"]["id"], json!(event.id.to_hex()));
    verify_nip98(&acks[0], &mock.base_url, &agent);
    let registrations = mock.seen("/route/agents/register");
    assert!(registrations.is_empty() || registrations[0].body["respond_to"] == json!("anyone"));
    for task in tasks {
        task.abort();
    }
}

#[tokio::test]
async fn approval_required_blocks_agent_re_asks_until_the_owner_decides() {
    let mock = mock().await;
    mock.state.lock().unwrap().turn_response =
        Some(json!({"guest_turn_id": "turn-9", "state": "approval_required", "tier": 2}));
    let agent = Keys::generate();
    let other_agent = Keys::generate();
    let runtime = runtime(&mock, &agent, true, RespondTo::Anyone);
    let event = guest_message(
        &other_agent,
        &agent,
        "please share ross's calendar details for monday",
    );
    let tier = TrustTier::OtherOwnerAgent {
        agent: other_agent.public_key().to_hex(),
        owner: "2".repeat(64),
        chain: vec![other_agent.public_key().to_hex()],
    };
    let input = GuardInput {
        event: &event,
        channel_id: Uuid::nil(),
        tier: &tier,
    };
    let GuardVerdict::Proceed { request_key } = runtime.check_guards(&input) else {
        panic!("first ask proceeds");
    };
    runtime.route(
        event.clone(),
        Uuid::nil(),
        false,
        None,
        tier.clone(),
        request_key,
    );
    mock.wait_for("/route/turns", 1).await;
    for _ in 0..50 {
        let key = request_key_for(&event, &tier, &agent);
        if runtime
            .guards()
            .pending_reference(&key, Instant::now())
            .is_some()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // A re-ask after the dedup window would still be held: simulate by
    // asking the guards directly for pending state.
    let key = request_key_for(&event, &tier, &agent);
    assert_eq!(
        runtime.guards().pending_reference(&key, Instant::now()),
        Some("turn-9")
    );
    runtime.handle_approval_control("approve_guest_reply", &json!({"guestTurnId": "turn-9"}));
    assert_eq!(
        runtime.guards().pending_reference(&key, Instant::now()),
        None
    );
}

fn request_key_for(event: &Event, tier: &TrustTier, agent: &Keys) -> String {
    let requester = match tier {
        TrustTier::OtherOwnerAgent { owner, .. } => owner.clone(),
        TrustTier::Guest { requester } => requester.clone(),
        _ => event.pubkey.to_hex(),
    };
    request_key(&event.content, &requester, &agent.public_key().to_hex())
}

#[tokio::test]
async fn without_a_route_people_get_a_short_refusal_and_agents_get_silence() {
    let mock = mock().await;
    let agent = Keys::generate();
    let guest = Keys::generate();
    let runtime = runtime(&mock, &agent, false, RespondTo::OwnerOnly);
    let event = guest_message(&guest, &agent, "hi there");
    runtime.route(
        event.clone(),
        Uuid::nil(),
        false,
        None,
        TrustTier::Guest {
            requester: guest.public_key().to_hex(),
        },
        None,
    );
    let published = mock.wait_for("/events", 1).await;
    let notice: Event = serde_json::from_value(published[0].body.clone()).expect("event");
    assert_eq!(notice.content, crate::trust::owner_only_notice(None));
    assert_eq!(
        parse_thread_tags(&notice).parent_event_id,
        Some(event.id.to_hex())
    );
    // A second message within the hour gets no second notice.
    let again = guest_message(&guest, &agent, "hello?");
    runtime.route(
        again,
        Uuid::nil(),
        false,
        None,
        TrustTier::Guest {
            requester: guest.public_key().to_hex(),
        },
        None,
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(mock.seen("/events").len(), 1);
    assert!(mock.seen("/route").is_empty());
}

#[tokio::test]
async fn guards_drop_duplicates_echoes_and_sibling_loops() {
    let mock = mock().await;
    let agent = Keys::generate();
    let sibling = Keys::generate();
    let runtime = runtime(&mock, &agent, true, RespondTo::Anyone);
    let ask = |text: &str| guest_message(&sibling, &agent, text);
    let tier = TrustTier::Sibling;
    let check = |event: &Event| {
        runtime.check_guards(&GuardInput {
            event,
            channel_id: Uuid::nil(),
            tier: &tier,
        })
    };
    assert!(matches!(
        check(&ask("status of the deploy?")),
        GuardVerdict::Proceed { .. }
    ));
    assert_eq!(
        check(&ask("Status of the deploy")),
        GuardVerdict::Drop { guard: "duplicate" }
    );
    let own = "The deploy finished and all health checks are green in every region.";
    runtime.record_own_output(own);
    assert_eq!(
        check(&ask(&format!("> {own}\nok do it again"))),
        GuardVerdict::Drop { guard: "echo" }
    );
    // Owner events are never guarded.
    assert_eq!(
        runtime.check_guards(&GuardInput {
            event: &ask("status of the deploy?"),
            channel_id: Uuid::nil(),
            tier: &TrustTier::Owner,
        }),
        GuardVerdict::Proceed { request_key: None }
    );
    // Sibling ping-pong in one thread stops at the pair limit.
    let mut verdicts = Vec::new();
    for i in 0..(crate::agent_guards::PAIR_PER_THREAD_LIMIT + 2) {
        verdicts.push(check(&ask(&format!("step {i}"))));
    }
    assert!(verdicts[..crate::agent_guards::PAIR_PER_THREAD_LIMIT - 1]
        .iter()
        .all(|v| matches!(v, GuardVerdict::Proceed { .. })));
    assert!(verdicts.contains(&GuardVerdict::Drop {
        guard: "pair_rate_limit_notice"
    }));
    assert_eq!(
        verdicts.last(),
        Some(&GuardVerdict::Drop {
            guard: "pair_rate_limit"
        })
    );
}

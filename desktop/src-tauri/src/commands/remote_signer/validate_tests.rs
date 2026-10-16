use super::*;
use serde_json::json;
use sha2::Digest as _;

const CHANNEL: &str = "0b6c9f3e-2d3b-4b8a-9d55-0f3c1d2e3f4a";
const OTHER_CHANNEL: &str = "1c7d0a4f-3e4c-4c9b-8e66-1a4d2e3f4a5b";
const REQUEST: &str = "6f1d2c3b-4a59-4e8d-9c7b-1a2b3c4d5e6f";
const NOW_MS: i64 = 1_790_000_000_000;

fn ctx(keys: &nostr::Keys) -> ValidationContext {
    ValidationContext {
        own_pubkey: keys.public_key().to_hex(),
        events_url: "https://chat.example.com/events".to_string(),
        query_url: "https://chat.example.com/query".to_string(),
        now_ms: NOW_MS,
    }
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap()
        .to_rfc3339()
}

fn event_id(pubkey: &str, created_at: u64, kind: u16, tags: &Value, content: &str) -> String {
    let json = json!([0, pubkey, created_at, kind, tags, content]).to_string();
    hex::encode(sha2::Sha256::digest(json.as_bytes()))
}

fn publish_request(keys: &nostr::Keys, kind: u16, tags: Value, content: &str) -> Value {
    let pubkey = keys.public_key().to_hex();
    let created_at = (NOW_MS / 1000) as u64;
    let action = match kind {
        7 => "react",
        40003 => "edit_message",
        9005 => "delete_message",
        _ => "send_message",
    };
    json!({
        "request_id": REQUEST,
        "method": "publish_event",
        "action": action,
        "channel_id": CHANNEL,
        "params": {
            "event": {
                "pubkey": pubkey,
                "created_at": created_at,
                "kind": kind,
                "tags": tags,
                "content": content,
            },
            "expected_event_id": event_id(&pubkey, created_at, kind, &tags, content),
            "relay_url": "https://chat.example.com/events",
        },
        "summary": {
            "action_label": "Post a message",
            "content_preview": content,
            "requester": { "mcp_client": "Kiingo MCP", "session_id": "s-1", "agent_id": null }
        },
        "signer_public_key": pubkey,
        "created_at": iso(NOW_MS - 1_000),
        "expires_at": iso(NOW_MS + 59_000),
    })
}

fn query_request(keys: &nostr::Keys, filters: Value) -> Value {
    json!({
        "request_id": REQUEST,
        "method": "authorize_query",
        "action": "read_channel",
        "channel_id": CHANNEL,
        "params": { "filters": filters, "relay_url": "https://chat.example.com/query" },
        "summary": { "action_label": "Read recent messages", "requester": {} },
        "signer_public_key": keys.public_key().to_hex(),
        "created_at": iso(NOW_MS - 1_000),
        "expires_at": iso(NOW_MS + 59_000),
    })
}

fn refusal(result: Result<ValidatedRequest, Rejection>) -> &'static str {
    match result {
        Err(Rejection::Refused { reason, .. }) => reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn a_well_formed_message_validates_and_keeps_the_exact_event() {
    let keys = nostr::Keys::generate();
    let tags = json!([["h", CHANNEL], ["p", "a".repeat(64)]]);
    let raw = publish_request(&keys, 9, tags, "hello world");
    let validated = validate_request(&raw, &ctx(&keys)).unwrap();
    assert_eq!(validated.request_id, REQUEST);
    assert_eq!(validated.deadline_ms, NOW_MS + 59_000);
    assert_eq!(
        validated.requester.mcp_client.as_deref(),
        Some("Kiingo MCP")
    );
    let Operation::Publish {
        event,
        expected_event_id,
        channel_id,
        mentions,
        ..
    } = validated.operation
    else {
        panic!("expected publish");
    };
    assert_eq!(channel_id.as_deref(), Some(CHANNEL));
    assert_eq!(mentions, vec!["a".repeat(64)]);
    let signed = event.sign_with_keys(&keys).unwrap();
    assert_eq!(signed.id.to_hex(), expected_event_id);
    assert_eq!(signed.content, "hello world");
}

#[test]
fn every_publish_kind_validates_with_its_action() {
    let keys = nostr::Keys::generate();
    let target = "b".repeat(64);
    for (kind, tags) in [
        (7, json!([["e", target]])),
        (40003, json!([["h", CHANNEL], ["e", target]])),
        (9005, json!([["h", CHANNEL], ["e", target]])),
    ] {
        let raw = publish_request(&keys, kind, tags, "x");
        assert!(validate_request(&raw, &ctx(&keys)).is_ok(), "kind {kind}");
    }
}

#[test]
fn expired_requests_are_skipped_not_signed() {
    let keys = nostr::Keys::generate();
    let mut raw = publish_request(&keys, 9, json!([["h", CHANNEL]]), "hi");
    raw["expires_at"] = json!(iso(NOW_MS - 1));
    assert_eq!(
        validate_request(&raw, &ctx(&keys)).unwrap_err(),
        Rejection::Expired {
            request_id: REQUEST.to_string()
        }
    );
}

#[test]
fn prompts_never_outlive_the_cap() {
    let keys = nostr::Keys::generate();
    let mut raw = publish_request(&keys, 9, json!([["h", CHANNEL]]), "hi");
    raw["expires_at"] = json!(iso(NOW_MS + 3_600_000));
    let validated = validate_request(&raw, &ctx(&keys)).unwrap();
    assert_eq!(validated.deadline_ms, NOW_MS + MAX_PROMPT_MS);
}

#[test]
fn someone_elses_key_is_refused() {
    let keys = nostr::Keys::generate();
    let other = nostr::Keys::generate();
    let raw = publish_request(&other, 9, json!([["h", CHANNEL]]), "hi");
    assert_eq!(
        refusal(validate_request(&raw, &ctx(&keys))),
        "signer_key_mismatch"
    );

    // Signer key right, event author wrong.
    let mut raw = publish_request(&keys, 9, json!([["h", CHANNEL]]), "hi");
    raw["params"]["event"]["pubkey"] = json!(other.public_key().to_hex());
    assert_eq!(
        refusal(validate_request(&raw, &ctx(&keys))),
        "event_pubkey_mismatch"
    );
}

#[test]
fn a_swapped_event_does_not_match_its_expected_id() {
    let keys = nostr::Keys::generate();
    let mut raw = publish_request(&keys, 9, json!([["h", CHANNEL]]), "hi");
    raw["params"]["event"]["content"] = json!("something else");
    assert_eq!(
        refusal(validate_request(&raw, &ctx(&keys))),
        "expected_event_id_mismatch"
    );
}

#[test]
fn relay_urls_must_be_the_connected_relay() {
    let keys = nostr::Keys::generate();
    let mut raw = publish_request(&keys, 9, json!([["h", CHANNEL]]), "hi");
    raw["params"]["relay_url"] = json!("https://evil.example/events");
    assert_eq!(
        refusal(validate_request(&raw, &ctx(&keys))),
        "relay_url_mismatch"
    );
    let mut raw = query_request(&keys, json!([{ "kinds": [9], "#h": [CHANNEL] }]));
    raw["params"]["relay_url"] = json!("https://chat.example.com/events");
    assert_eq!(
        refusal(validate_request(&raw, &ctx(&keys))),
        "relay_url_mismatch"
    );
}

#[test]
fn never_signed_and_unlisted_kinds_are_refused() {
    let keys = nostr::Keys::generate();
    for kind in [
        0, 1, 5, 10100, 30315, 9000, 9001, 9002, 9007, 9008, 9030, 9031, 9032, 27235, 27236, 24243,
        1059, 40002,
    ] {
        let raw = publish_request(&keys, kind, json!([["h", CHANNEL]]), "x");
        assert_eq!(
            refusal(validate_request(&raw, &ctx(&keys))),
            "kind_not_allowed",
            "kind {kind}"
        );
    }
}

#[test]
fn allowlists_never_overlap_the_never_signed_kinds() {
    for kind in PUBLISH_KINDS {
        assert!(!NEVER_SIGN_KINDS.contains(&kind), "{kind}");
    }
}

#[test]
fn hidden_tags_and_attestations_are_refused() {
    let keys = nostr::Keys::generate();
    for tag in [
        json!(["auth", "a".repeat(64), "", "sig"]),
        json!(["imeta", "url https://x"]),
        json!(["broadcast", "1"]),
    ] {
        let raw = publish_request(&keys, 9, json!([["h", CHANNEL], tag]), "x");
        assert_eq!(
            refusal(validate_request(&raw, &ctx(&keys))),
            "event_tag_not_allowed"
        );
    }
}

#[test]
fn the_posted_channel_must_match_the_displayed_channel() {
    let keys = nostr::Keys::generate();
    let raw = publish_request(&keys, 9, json!([["h", OTHER_CHANNEL]]), "x");
    assert_eq!(
        refusal(validate_request(&raw, &ctx(&keys))),
        "event_channel_mismatch"
    );
    let raw = publish_request(&keys, 9, json!([]), "x");
    assert_eq!(
        refusal(validate_request(&raw, &ctx(&keys))),
        "event_channel_missing"
    );
    let raw = publish_request(&keys, 9, json!([["h", CHANNEL], ["h", CHANNEL]]), "x");
    assert_eq!(
        refusal(validate_request(&raw, &ctx(&keys))),
        "event_channel_invalid"
    );
}

#[test]
fn the_action_must_match_the_kind() {
    let keys = nostr::Keys::generate();
    let mut raw = publish_request(
        &keys,
        9005,
        json!([["h", CHANNEL], ["e", "b".repeat(64)]]),
        "",
    );
    raw["action"] = json!("send_message");
    assert_eq!(
        refusal(validate_request(&raw, &ctx(&keys))),
        "action_kind_mismatch"
    );
}

#[test]
fn backdated_or_future_events_are_refused() {
    let keys = nostr::Keys::generate();
    let mut raw = publish_request(&keys, 9, json!([["h", CHANNEL]]), "x");
    raw["params"]["event"]["created_at"] = json!((NOW_MS / 1000) as u64 - 3_600);
    assert_eq!(
        refusal(validate_request(&raw, &ctx(&keys))),
        "event_created_at_out_of_range"
    );
}

#[test]
fn malformed_request_ids_are_refused_without_an_id() {
    let keys = nostr::Keys::generate();
    let mut raw = publish_request(&keys, 9, json!([["h", CHANNEL]]), "x");
    raw["request_id"] = json!("../../owner/approvals");
    assert_eq!(
        validate_request(&raw, &ctx(&keys)).unwrap_err(),
        Rejection::Refused {
            request_id: None,
            reason: "request_id_invalid"
        }
    );
}

#[test]
fn read_filters_must_stay_within_the_read_kinds() {
    let keys = nostr::Keys::generate();
    let ok = query_request(
        &keys,
        json!([
            { "kinds": [9, 40002, 40008, 45001, 45003], "#h": [CHANNEL], "limit": 50 },
            { "kinds": [40003, 9005, 5], "#h": [CHANNEL], "limit": 200 }
        ]),
    );
    let validated = validate_request(&ok, &ctx(&keys)).unwrap();
    let Operation::Query { channel_id, .. } = validated.operation else {
        panic!("expected query");
    };
    assert_eq!(channel_id.as_deref(), Some(CHANNEL));

    for filters in [
        json!([{ "kinds": [1059] }]),
        json!([{ "kinds": [] }]),
        json!([{ "#h": [CHANNEL] }]),
        json!([]),
        json!([{ "kinds": [9] }, { "kinds": [9] }, { "kinds": [9] }, { "kinds": [9] }, { "kinds": [9] }]),
    ] {
        let raw = query_request(&keys, filters.clone());
        assert!(validate_request(&raw, &ctx(&keys)).is_err(), "{filters}");
    }
}

#[test]
fn reads_are_channel_bound_only_when_every_filter_is() {
    let keys = nostr::Keys::generate();
    let thread = query_request(
        &keys,
        json!([
            { "kinds": [9], "ids": ["c".repeat(64)], "limit": 1 },
            { "kinds": [9], "#h": [CHANNEL], "#e": ["c".repeat(64)] }
        ]),
    );
    let Operation::Query { channel_id, .. } =
        validate_request(&thread, &ctx(&keys)).unwrap().operation
    else {
        panic!("expected query");
    };
    assert_eq!(channel_id, None);
}

#[test]
fn relay_bridge_urls_follow_the_relay_host() {
    assert_eq!(
        relay_bridge_url("wss://Chat.Example.com", "/events").as_deref(),
        Some("https://chat.example.com/events")
    );
    assert_eq!(
        relay_bridge_url("wss://chat.example.com:8443/relay", "/query").as_deref(),
        Some("https://chat.example.com:8443/query")
    );
    assert_eq!(
        relay_bridge_url("ws://localhost:3000", "/events").as_deref(),
        Some("http://localhost:3000/events")
    );
    assert_eq!(relay_bridge_url("ws://chat.example.com", "/events"), None);
    assert_eq!(relay_bridge_url("not a url", "/events"), None);
}

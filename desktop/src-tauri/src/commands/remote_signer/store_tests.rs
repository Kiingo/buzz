use super::*;
use crate::commands::remote_signer::validate::{Operation, Requester, ValidatedRequest};
use nostr::{Kind, Tag, Timestamp, UnsignedEvent};
use serde_json::json;

const CHANNEL: &str = "0b6c9f3e-2d3b-4b8a-9d55-0f3c1d2e3f4a";
const OTHER: &str = "1c7d0a4f-3e4c-4c9b-8e66-1a4d2e3f4a5b";
const NOW: i64 = 1_790_000_000_000;

fn publish(kind: u16, channel: Option<&str>) -> ValidatedRequest {
    let keys = nostr::Keys::generate();
    let tags: Vec<Tag> = channel
        .map(|c| vec![Tag::parse(["h", c]).unwrap()])
        .unwrap_or_default();
    let event = UnsignedEvent::new(
        keys.public_key(),
        Timestamp::from(1_790_000_000),
        Kind::from(kind),
        tags,
        "x",
    );
    ValidatedRequest {
        request_id: "6f1d2c3b-4a59-4e8d-9c7b-1a2b3c4d5e6f".to_string(),
        action: "send_message".to_string(),
        reported_channel_id: channel.map(str::to_string),
        server_action_label: None,
        requester: Requester::default(),
        deadline_ms: NOW + 60_000,
        operation: Operation::Publish {
            event: Box::new(event),
            expected_event_id: "0".repeat(64),
            relay_url: "https://chat.example.com/events".to_string(),
            channel_id: channel.map(str::to_string),
            target_event_id: None,
            mentions: Vec::new(),
        },
    }
}

fn read(channel: Option<&str>) -> ValidatedRequest {
    let mut request = publish(9, channel);
    request.operation = Operation::Query {
        filters: vec![json!({ "kinds": [9] })],
        relay_url: "https://chat.example.com/query".to_string(),
        channel_id: channel.map(str::to_string),
    };
    request
}

fn choice(minutes: u32, kinds: &[u16], all_channels: bool) -> ScopeChoice {
    ScopeChoice {
        duration_minutes: minutes,
        kinds: kinds.to_vec(),
        all_channels,
    }
}

#[test]
fn publish_scopes_cover_only_their_kinds_channel_and_lifetime() {
    let scope = scope_for(&publish(9, Some(CHANNEL)), &choice(15, &[], false), NOW).unwrap();
    assert_eq!(scope.kinds, vec![9]);
    assert_eq!(scope.expires_at, NOW + 15 * 60_000);
    assert!(scope.covers(&publish(9, Some(CHANNEL)), NOW + 1));
    assert!(!scope.covers(&publish(7, Some(CHANNEL)), NOW + 1));
    assert!(!scope.covers(&publish(9, Some(OTHER)), NOW + 1));
    assert!(!scope.covers(&publish(9, Some(CHANNEL)), scope.expires_at));
    assert!(!scope.covers(&read(Some(CHANNEL)), NOW + 1));
}

#[test]
fn reactions_without_a_channel_tag_never_match_a_publish_scope() {
    let scope = scope_for(&publish(9, Some(CHANNEL)), &choice(60, &[7, 9], false), NOW).unwrap();
    assert_eq!(scope.kinds, vec![7, 9]);
    assert!(!scope.covers(&publish(7, None), NOW + 1));
    assert_eq!(
        scope_for(&publish(7, None), &choice(60, &[], false), NOW).unwrap_err(),
        "scope_needs_channel"
    );
}

#[test]
fn scope_kinds_are_limited_to_the_publish_allowlist() {
    let scope = scope_for(
        &publish(9, Some(CHANNEL)),
        &choice(60, &[0, 9000, 27235, 40003], false),
        NOW,
    )
    .unwrap();
    assert_eq!(scope.kinds, vec![9, 40003]);
}

#[test]
fn read_scopes_cover_one_channel_or_all_channels() {
    let channel = scope_for(&read(Some(CHANNEL)), &choice(480, &[], false), NOW).unwrap();
    assert!(channel.covers(&read(Some(CHANNEL)), NOW + 1));
    assert!(!channel.covers(&read(Some(OTHER)), NOW + 1));
    assert!(!channel.covers(&read(None), NOW + 1));
    assert!(!channel.covers(&publish(9, Some(CHANNEL)), NOW + 1));

    let all = scope_for(&read(None), &choice(60, &[], true), NOW).unwrap();
    assert_eq!(all.channel_id, None);
    assert!(all.covers(&read(None), NOW + 1));
    assert!(all.covers(&read(Some(OTHER)), NOW + 1));
    assert!(!all.covers(&publish(9, Some(CHANNEL)), NOW + 1));

    assert_eq!(
        scope_for(&read(None), &choice(60, &[], false), NOW).unwrap_err(),
        "scope_needs_channel"
    );
}

#[test]
fn only_offered_durations_are_accepted() {
    for minutes in [0, 1, 30, 1440] {
        assert_eq!(
            scope_for(&read(None), &choice(minutes, &[], true), NOW).unwrap_err(),
            "scope_duration_invalid"
        );
    }
}

#[test]
fn the_store_round_trips_and_drops_expired_scopes() {
    let dir = tempfile::tempdir().unwrap();
    let path = store_path(dir.path());
    let mut store = load(&path);
    assert!(store.profiles.is_empty());

    let key = profile_key("chat.example.com", "ABCDEF");
    let profile = store.profiles.entry(key.clone()).or_default();
    profile.enabled = true;
    profile
        .scopes
        .push(scope_for(&read(None), &choice(15, &[], true), NOW).unwrap());
    profile
        .scopes
        .push(scope_for(&read(None), &choice(15, &[], true), NOW - 3_600_000).unwrap());
    profile.push_log(LogEntry {
        at: NOW,
        request_id: None,
        action: "read_channel".to_string(),
        channel_id: None,
        decision: "prompt".to_string(),
        outcome: "signed".to_string(),
        event_id: None,
        detail: None,
    });
    save(&path, &mut store, NOW).unwrap();

    let reloaded = load(&path);
    let profile = &reloaded.profiles[&key];
    assert!(profile.enabled);
    assert_eq!(profile.scopes.len(), 1);
    assert_eq!(profile.log.len(), 1);
    assert_eq!(key, "chat.example.com|abcdef");
}

#[test]
fn the_log_keeps_the_newest_entries() {
    let mut profile = ProfileState::default();
    for at in 0..250 {
        profile.push_log(LogEntry {
            at,
            request_id: None,
            action: "react".to_string(),
            channel_id: None,
            decision: "prompt".to_string(),
            outcome: "declined".to_string(),
            event_id: None,
            detail: None,
        });
    }
    assert_eq!(profile.log.len(), 200);
    assert_eq!(profile.log[0].at, 249);
}

#[test]
fn a_corrupt_store_reads_as_switched_off() {
    let dir = tempfile::tempdir().unwrap();
    let path = store_path(dir.path());
    std::fs::write(&path, b"{not json").unwrap();
    assert_eq!(load(&path), StoreFile::default());
}

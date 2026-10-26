//! Quiet agent DM markers (`docs/agent-dm-markers.md`): agent-signed history
//! mirrored from other surfaces, session dividers, session listings and
//! question-card state. They are presentation for people, not conversation:
//! in this harness they never enter an agent's prompt context, never start or
//! steer a turn, and never count as relayed provenance, whoever signed them.
//!
//! A requester mirror is signed by the agent's key on the requester's behalf,
//! so nothing the harness feeds a turn may treat such a line as the
//! requester's own words. Either mirror tag alone (`buzz-mirror` or
//! `buzz-mirror-author`, any role) is enough to make an event quiet here, so
//! dropping one tag never turns a mirror into an input; agent-role mirrors
//! are dropped too. The agent's own CLI read tools are a separate path: they
//! use `buzz_core::agent_dm_marker::is_requester_mirror`, which drops
//! requester mirrors but keeps agent-role ones.

use buzz_core::agent_dm_marker::is_quiet_marker_tag_name;

/// Whether a relay event (as JSON) is a quiet agent DM marker.
pub(crate) fn is_quiet_agent_dm_marker(event: &serde_json::Value) -> bool {
    event
        .get("tags")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|tags| {
            tags.iter().any(|tag| {
                tag.as_array()
                    .and_then(|parts| parts.first())
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(is_quiet_marker_tag_name)
            })
        })
}

/// Whether a signed relay event is a quiet agent DM marker. Same rule as
/// [`is_quiet_agent_dm_marker`]: kind and signer do not matter.
pub(crate) fn is_quiet_agent_dm_marker_event(event: &nostr::Event) -> bool {
    event.tags.iter().any(|tag| {
        tag.as_slice()
            .first()
            .is_some_and(|name| is_quiet_marker_tag_name(name))
    })
}

#[cfg(test)]
mod tests {
    use super::{is_quiet_agent_dm_marker, is_quiet_agent_dm_marker_event};
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use serde_json::json;

    fn signed(kind: u16, tags: &[&[&str]], keys: &Keys) -> nostr::Event {
        EventBuilder::new(Kind::Custom(kind), "Can you move my 3pm?")
            .tags(
                tags.iter()
                    .map(|parts| Tag::parse(parts.iter().copied()).unwrap()),
            )
            .sign_with_keys(keys)
            .unwrap()
    }

    #[test]
    fn marks_every_quiet_marker_and_nothing_else() {
        for name in [
            "buzz-mirror",
            "buzz-mirror-author",
            "buzz-session",
            "buzz-sessions",
            "buzz-question-state",
        ] {
            assert!(is_quiet_agent_dm_marker(
                &json!({"tags": [["h", "c"], [name, "x"]]})
            ));
        }
        assert!(!is_quiet_agent_dm_marker(
            &json!({"tags": [["h", "c"], ["buzz-question", "ask"]]})
        ));
        assert!(!is_quiet_agent_dm_marker(&json!({"tags": [["p", "k"]]})));
        assert!(!is_quiet_agent_dm_marker(&json!({"tags": []})));
        assert!(!is_quiet_agent_dm_marker(&json!({})));
    }

    #[test]
    fn dm_context_leaves_quiet_markers_out() {
        let marker = json!({
            "id": "a".repeat(64), "pubkey": "b".repeat(64), "created_at": 2, "kind": 40002,
            "content": "mirrored email", "tags": [["h", "c"], ["buzz-mirror", "email", "m1", "1"]]
        });
        let message = json!({
            "id": "c".repeat(64), "pubkey": "d".repeat(64), "created_at": 1, "kind": 9,
            "content": "hello", "tags": [["h", "c"]]
        });
        let context = crate::pool::parse_nostr_dm_response_for_tests(json!([marker, message]), 20)
            .expect("context");
        let crate::queue::ConversationContext::Dm { messages, .. } = context else {
            panic!("expected a DM context");
        };
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "hello");
    }

    #[test]
    fn dm_context_leaves_requester_mirrors_out_whoever_signed_them() {
        let requester = "d".repeat(64);
        let agent_signed = json!({
            "id": "a".repeat(64), "pubkey": "b".repeat(64), "created_at": 3, "kind": 40002,
            "content": "relayed from Kiingo Tasks", "tags": [
                ["h", "c"], ["buzz-mirror", "tasks", "t1", "3"],
                ["buzz-mirror-author", "requester", requester, ""]
            ]
        });
        let requester_signed_author_only = json!({
            "id": "e".repeat(64), "pubkey": requester, "created_at": 2, "kind": 9,
            "content": "author tag only", "tags": [
                ["h", "c"], ["buzz-mirror-author", "requester", requester, ""]
            ]
        });
        let message = json!({
            "id": "c".repeat(64), "pubkey": requester, "created_at": 1, "kind": 9,
            "content": "hello", "tags": [["h", "c"]]
        });
        let context = crate::pool::parse_nostr_dm_response_for_tests(
            json!([agent_signed, requester_signed_author_only, message]),
            20,
        )
        .expect("context");
        let crate::queue::ConversationContext::Dm { messages, .. } = context else {
            panic!("expected a DM context");
        };
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "hello");
    }

    #[test]
    fn requester_mirror_is_quiet_with_or_without_the_mirror_tag() {
        let requester = "e".repeat(64);
        let both = json!({"kind": 40002, "tags": [
            ["h", "c"],
            ["buzz-mirror", "tasks", "t1", "1"],
            ["buzz-mirror-author", "requester", requester, ""]
        ]});
        assert!(is_quiet_agent_dm_marker(&both));
        // The author tag alone still marks the event: stripping `buzz-mirror`
        // must never turn a relayed line into the requester's own input.
        let author_only = json!({"kind": 40002, "tags": [
            ["h", "c"],
            ["buzz-mirror-author", "requester", requester, ""]
        ]});
        assert!(is_quiet_agent_dm_marker(&author_only));
        let mirror_only = json!({"kind": 40002, "tags": [
            ["h", "c"],
            ["buzz-mirror", "companion", "c1", "1"]
        ]});
        assert!(is_quiet_agent_dm_marker(&mirror_only));
        // Any role, including an unknown one.
        let other_role = json!({"kind": 9, "tags": [
            ["h", "c"],
            ["buzz-mirror-author", "someone", "", ""]
        ]});
        assert!(is_quiet_agent_dm_marker(&other_role));
    }

    #[test]
    fn signed_markers_are_quiet_for_every_kind_and_signer() {
        let agent = Keys::generate();
        let requester = Keys::generate();
        let requester_hex = requester.public_key().to_hex();
        let author: &[&str] = &["buzz-mirror-author", "requester", &requester_hex, ""];
        let mirror: &[&str] = &["buzz-mirror", "tasks", "t1", "1"];
        for keys in [&agent, &requester] {
            for kind in [9u16, 40002] {
                assert!(is_quiet_agent_dm_marker_event(&signed(
                    kind,
                    &[&["h", "c"], mirror, author],
                    keys
                )));
                assert!(is_quiet_agent_dm_marker_event(&signed(
                    kind,
                    &[&["h", "c"], author],
                    keys
                )));
                assert!(is_quiet_agent_dm_marker_event(&signed(
                    kind,
                    &[&["h", "c"], mirror],
                    keys
                )));
                assert!(is_quiet_agent_dm_marker_event(&signed(
                    kind,
                    &[&["h", "c"], &["buzz-session", "new", ""]],
                    keys
                )));
            }
        }
        // An ordinary message, or one that only mentions a marker name in a
        // value position, is not quiet.
        assert!(!is_quiet_agent_dm_marker_event(&signed(
            9,
            &[&["h", "c"]],
            &requester
        )));
        assert!(!is_quiet_agent_dm_marker_event(&signed(
            9,
            &[&["h", "c"], &["t", "buzz-mirror"]],
            &requester
        )));
    }
}

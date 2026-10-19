//! Quiet agent DM markers (`docs/agent-dm-markers.md`): agent-signed history
//! mirrored from other surfaces, session dividers, session listings and
//! question-card state. They are presentation for people, not conversation:
//! they never enter an agent's prompt context.

/// Tag names that mark a quiet agent DM event.
const QUIET_MARKER_TAGS: [&str; 4] = [
    "buzz-mirror",
    "buzz-session",
    "buzz-sessions",
    "buzz-question-state",
];

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
                    .is_some_and(|name| QUIET_MARKER_TAGS.contains(&name))
            })
        })
}

#[cfg(test)]
mod tests {
    use super::is_quiet_agent_dm_marker;
    use serde_json::json;

    #[test]
    fn marks_every_quiet_marker_and_nothing_else() {
        for name in [
            "buzz-mirror",
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
}

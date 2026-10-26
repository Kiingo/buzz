//! Quiet agent DM marker tags (`docs/agent-dm-markers.md`), shared by every
//! agent-side reader: the ACP harness (prompt context, triggers) and the
//! agent CLI's read tools.
//!
//! A requester mirror is signed by the agent's key on the requester's behalf.
//! Agent runtimes hold that key, so nothing an agent reads may treat such a
//! line as the requester's own words.

/// Tag names that mark a quiet agent DM event.
pub const QUIET_MARKER_TAGS: [&str; 5] = [
    "buzz-mirror",
    "buzz-mirror-author",
    "buzz-session",
    "buzz-sessions",
    "buzz-question-state",
];

/// The mirror marker tag.
pub const MIRROR_TAG: &str = "buzz-mirror";

/// The mirror author tag: `["buzz-mirror-author", <role>, <pubkey>, <name>]`.
pub const MIRROR_AUTHOR_TAG: &str = "buzz-mirror-author";

/// The mirror author role for the agent's own message on another surface.
pub const MIRROR_ROLE_AGENT: &str = "agent";

/// Whether `name` is the name of a quiet agent DM marker tag.
pub fn is_quiet_marker_tag_name(name: &str) -> bool {
    QUIET_MARKER_TAGS.contains(&name)
}

/// Whether tags given as `(name, first value)` pairs mark a mirror that an
/// agent must never read back: any `buzz-mirror` or `buzz-mirror-author` tag
/// makes it one, unless the event is plainly the agent's own mirrored message
/// (at least one author tag, and every author tag has role `agent`). It fails
/// closed: a missing, unknown or conflicting role counts as a requester mirror.
pub fn is_requester_mirror<'a>(tags: impl IntoIterator<Item = (&'a str, Option<&'a str>)>) -> bool {
    let mut mirrored = false;
    let mut agent_author = false;
    for (name, role) in tags {
        match name {
            MIRROR_TAG => mirrored = true,
            MIRROR_AUTHOR_TAG => {
                mirrored = true;
                if role != Some(MIRROR_ROLE_AGENT) {
                    return true;
                }
                agent_author = true;
            }
            _ => {}
        }
    }
    mirrored && !agent_author
}

/// [`is_requester_mirror`] for a relay event as JSON.
pub fn is_requester_mirror_json(event: &serde_json::Value) -> bool {
    let Some(tags) = event.get("tags").and_then(serde_json::Value::as_array) else {
        return false;
    };
    is_requester_mirror(tags.iter().filter_map(|tag| {
        let parts = tag.as_array()?;
        let name = parts.first()?.as_str()?;
        Some((name, parts.get(1).and_then(serde_json::Value::as_str)))
    }))
}

/// [`is_requester_mirror`] for a signed event.
pub fn is_requester_mirror_event(event: &nostr::Event) -> bool {
    is_requester_mirror(event.tags.iter().filter_map(|tag| {
        let parts = tag.as_slice();
        let name = parts.first()?;
        Some((name.as_str(), parts.get(1).map(String::as_str)))
    }))
}

#[cfg(test)]
mod tests {
    use super::{is_quiet_marker_tag_name, is_requester_mirror_event, is_requester_mirror_json};
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use serde_json::json;

    #[test]
    fn quiet_tag_names() {
        for name in [
            "buzz-mirror",
            "buzz-mirror-author",
            "buzz-session",
            "buzz-sessions",
            "buzz-question-state",
        ] {
            assert!(is_quiet_marker_tag_name(name));
        }
        assert!(!is_quiet_marker_tag_name("buzz-question"));
        assert!(!is_quiet_marker_tag_name("p"));
    }

    #[test]
    fn requester_mirrors_fail_closed_and_agent_mirrors_stay_readable() {
        let requester = "e".repeat(64);
        let cases = [
            (
                json!([
                    ["buzz-mirror", "tasks", "t", "1"],
                    ["buzz-mirror-author", "requester", requester, ""]
                ]),
                true,
            ),
            (
                json!([["buzz-mirror-author", "requester", requester, ""]]),
                true,
            ),
            (json!([["buzz-mirror", "companion", "c", "1"]]), true),
            (
                json!([
                    ["buzz-mirror", "tasks", "t", "1"],
                    ["buzz-mirror-author", "someone", "", ""]
                ]),
                true,
            ),
            (
                json!([["buzz-mirror", "tasks", "t", "1"], ["buzz-mirror-author"]]),
                true,
            ),
            (
                json!([
                    ["buzz-mirror", "tasks", "t", "1"],
                    ["buzz-mirror-author", "agent", "", ""],
                    ["buzz-mirror-author", "requester", requester, ""]
                ]),
                true,
            ),
            (
                json!([
                    ["buzz-mirror", "teams", "t", "1"],
                    ["buzz-mirror-author", "agent", "", ""]
                ]),
                false,
            ),
            (json!([["buzz-mirror-author", "agent", "", ""]]), false),
            (json!([["h", "c"], ["buzz-session", "new", ""]]), false),
            (json!([["h", "c"]]), false),
        ];
        for (tags, expected) in cases {
            assert_eq!(
                is_requester_mirror_json(&json!({"kind": 40002, "tags": tags.clone()})),
                expected,
                "{tags}"
            );
        }
        assert!(!is_requester_mirror_json(&json!({})));
    }

    #[test]
    fn signed_events_use_the_same_rule() {
        let keys = Keys::generate();
        let sign = |tags: &[&[&str]]| {
            EventBuilder::new(Kind::Custom(40002), "Move my 3pm")
                .tags(
                    tags.iter()
                        .filter_map(|parts| Tag::parse(parts.iter().copied()).ok()),
                )
                .sign_with_keys(&keys)
                .ok()
        };
        let requester = sign(&[
            &["buzz-mirror", "tasks", "t", "1"],
            &["buzz-mirror-author", "requester", "", ""],
        ]);
        let agent = sign(&[
            &["buzz-mirror", "teams", "t", "1"],
            &["buzz-mirror-author", "agent", "", ""],
        ]);
        assert!(requester.as_ref().is_some_and(is_requester_mirror_event));
        assert!(agent
            .as_ref()
            .is_some_and(|event| !is_requester_mirror_event(event)));
    }
}

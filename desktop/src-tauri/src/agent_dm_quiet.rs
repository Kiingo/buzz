//! Quiet agent DM markers (docs/agent-dm-markers.md) for native unread
//! catch-up.
//!
//! Mirrors, session dividers, sessions listings and question-state events are
//! kind 40002 events an agent publishes into a DM. They never make the DM
//! unread. This mirrors the renderer's `isAgentDmQuietEvent`
//! (desktop/src/features/agent-dm/lib/quiet.ts); the relay already limits DM
//! publishing to members, so only the marker shape is checked here.

const KIND_QUIET: u16 = 40002;
const MIRROR_SOURCE_ID_MAX: usize = 256;
const MIRROR_SUBJECT_MAX: usize = 200;

fn first_tag<'a>(tags: &'a [Vec<String>], name: &str) -> Option<&'a [String]> {
    tags.iter()
        .find(|tag| tag.first().is_some_and(|part| part == name))
        .map(Vec::as_slice)
}

fn part(tag: &[String], index: usize) -> &str {
    tag.get(index).map(String::as_str).unwrap_or("")
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_unix_seconds(value: &str) -> bool {
    (1..=12).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_token(value: &str) -> bool {
    (1..=128).contains(&value.len()) && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn is_surface(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=32).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_' || *byte == b'-'
        })
}

fn is_mirror(tags: &[Vec<String>]) -> bool {
    let (Some(mirror), Some(author)) = (
        first_tag(tags, "buzz-mirror"),
        first_tag(tags, "buzz-mirror-author"),
    ) else {
        return false;
    };
    let source_id = part(mirror, 2);
    let role = part(author, 1);
    let pubkey = part(author, 2);
    let subject_ok = first_tag(tags, "subject").is_none_or(|subject| {
        subject
            .get(1)
            .is_some_and(|text| text.chars().count() <= MIRROR_SUBJECT_MAX)
    });
    is_surface(part(mirror, 1))
        && !source_id.trim().is_empty()
        && source_id.chars().count() <= MIRROR_SOURCE_ID_MAX
        && is_unix_seconds(part(mirror, 3))
        && (role == "requester" || role == "agent")
        && (pubkey.is_empty() || is_hex64(pubkey))
        && subject_ok
}

fn is_session_divider(tags: &[Vec<String>]) -> bool {
    first_tag(tags, "buzz-session").is_some_and(|tag| {
        let session_id = part(tag, 2);
        matches!(part(tag, 1), "new" | "load" | "switch")
            && (session_id.is_empty() || is_token(session_id))
    })
}

fn is_sessions_listing(tags: &[Vec<String>]) -> bool {
    first_tag(tags, "buzz-sessions").is_some_and(|tag| {
        let request_id = part(tag, 1);
        request_id.is_empty() || is_hex64(request_id)
    })
}

fn is_question_state(tags: &[Vec<String>]) -> bool {
    first_tag(tags, "buzz-question-state").is_some_and(|tag| is_token(part(tag, 1)))
}

/// Whether a DM event is a quiet agent DM marker that must not count toward
/// unread state.
pub(crate) fn is_quiet_agent_dm_event(kind: u16, tags: &[Vec<String>]) -> bool {
    kind == KIND_QUIET
        && (is_mirror(tags)
            || is_session_divider(tags)
            || is_sessions_listing(tags)
            || is_question_state(tags))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(raw: &[&[&str]]) -> Vec<Vec<String>> {
        raw.iter()
            .map(|tag| tag.iter().map(|part| (*part).to_string()).collect())
            .collect()
    }

    #[test]
    fn quiet_markers_are_recognised_on_kind_40002_only() {
        let mirror = tags(&[
            &["h", "c"],
            &["buzz-mirror", "email", "msg-1", "1760000000"],
            &["buzz-mirror-author", "requester", &"a".repeat(64), "Ross"],
        ]);
        assert!(is_quiet_agent_dm_event(40002, &mirror));
        assert!(!is_quiet_agent_dm_event(9, &mirror));
        assert!(is_quiet_agent_dm_event(
            40002,
            &tags(&[&["buzz-session", "new", ""]])
        ));
        assert!(is_quiet_agent_dm_event(
            40002,
            &tags(&[&["buzz-sessions", ""]])
        ));
        assert!(is_quiet_agent_dm_event(
            40002,
            &tags(&[&["buzz-question-state", "ask-1", "closed"]])
        ));
    }

    #[test]
    fn malformed_markers_stay_ordinary_messages() {
        assert!(!is_quiet_agent_dm_event(40002, &tags(&[&["h", "c"]])));
        assert!(!is_quiet_agent_dm_event(
            40002,
            &tags(&[
                &["buzz-mirror", "Email", "msg-1", "1760000000"],
                &["buzz-mirror-author", "requester", "", ""],
            ])
        ));
        assert!(!is_quiet_agent_dm_event(
            40002,
            &tags(&[&["buzz-mirror", "email", "msg-1", "1760000000"]])
        ));
        assert!(!is_quiet_agent_dm_event(
            40002,
            &tags(&[&["buzz-session", "reset", ""]])
        ));
        assert!(!is_quiet_agent_dm_event(
            40002,
            &tags(&[&["buzz-sessions", "not-hex"]])
        ));
    }
}

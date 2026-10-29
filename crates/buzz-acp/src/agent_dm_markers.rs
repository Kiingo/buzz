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
//!
//! One exception wakes a turn: a [relayed person post](relayed_person_mirror),
//! a plain kind:9 that Kiingo posts into a linked room for a person who wrote
//! in the Kiingo app (conversations-unified §8.4). It is input from someone
//! who is not the owner, never owner-trusted whoever signed it: the listener
//! admits it only as a guest crossing keyed to its signer, its text is wrapped
//! as untrusted, and the claimed author is shown as a claim only. Kind 40002
//! stays the quiet marker in every room.

use buzz_core::agent_dm_marker::{is_quiet_marker_tag_name, MIRROR_AUTHOR_TAG, MIRROR_TAG};

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

/// A Kiingo-relayed person post: the words someone wrote in the Kiingo app,
/// relayed into a linked room by a Kiingo key. Nothing here is verified: the
/// claimed author is what the signer says, so it is a label, never authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RelayedPersonMirror {
    /// The surface the person wrote on (`tasks`, `companion`, ...).
    pub(crate) surface: String,
    /// The pubkey the signer says wrote it (64-hex, not the signer), if any.
    pub(crate) claimed_author: Option<String>,
}

/// The longest fourth element a relayed post's `buzz-mirror-author` tag may
/// carry (Kiingo writes it empty); anything longer is not a relayed post.
const RELAYED_AUTHOR_NOTE_MAX_CHARS: usize = 64;

/// Kiingo card tags (call record, council result) that never ride a relayed
/// person post (Kiingo `buzz-mirror/markers.ts`).
const KIINGO_CARD_TAGS: [&str; 2] = ["buzz-call", "buzz-council"];

fn valid_surface(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && value.len() <= 32
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// The relayed person post an event is, if it is exactly one: kind:9, one
/// well-formed `buzz-mirror` tag, one well-formed requester-role
/// `buzz-mirror-author` tag whose pubkey (if any) is not the signer, and no
/// other quiet marker tag. Anything else carrying a marker tag (any 40002, an
/// agent-role mirror, a malformed or repeated tag, a session divider) stays a
/// quiet marker and never wakes a turn.
pub(crate) fn relayed_person_mirror(event: &nostr::Event) -> Option<RelayedPersonMirror> {
    if event.kind.as_u16() as u32 != buzz_core::kind::KIND_STREAM_MESSAGE {
        return None;
    }
    let mut mirror: Option<&[String]> = None;
    let mut author: Option<&[String]> = None;
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        let Some(name) = parts.first() else { continue };
        match name.as_str() {
            MIRROR_TAG if mirror.is_none() => mirror = Some(parts),
            MIRROR_AUTHOR_TAG if author.is_none() => author = Some(parts),
            // Any other marker (a repeated mirror tag, a session divider, a
            // Kiingo call or council card) keeps it quiet.
            other if is_quiet_marker_tag_name(other) || KIINGO_CARD_TAGS.contains(&other) => {
                return None
            }
            _ => {}
        }
    }
    let (mirror, author) = (mirror?, author?);
    let original_at = mirror.get(3)?;
    if mirror.len() != 4
        || !valid_surface(&mirror[1])
        || mirror[2].is_empty()
        || mirror[2].chars().count() > 256
        || original_at.is_empty()
        || original_at.len() > 12
        || !original_at.bytes().all(|b| b.is_ascii_digit())
        || author.len() != 4
        || author[1] != "requester"
        || author[3].chars().count() > RELAYED_AUTHOR_NOTE_MAX_CHARS
    {
        return None;
    }
    let claimed = author[2].as_str();
    let signer = event.pubkey.to_hex();
    let claimed_author = match claimed {
        "" => None,
        key if is_hex64(key) && key != signer => Some(key.to_string()),
        _ => return None,
    };
    Some(RelayedPersonMirror {
        surface: mirror[1].clone(),
        claimed_author,
    })
}

#[cfg(test)]
mod tests {
    use super::{is_quiet_agent_dm_marker, is_quiet_agent_dm_marker_event, relayed_person_mirror};
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

    #[test]
    fn only_a_well_formed_kind_9_requester_mirror_is_a_relayed_person_post() {
        let signer = Keys::generate();
        let person = Keys::generate().public_key().to_hex();
        let author: &[&str] = &["buzz-mirror-author", "requester", &person, ""];
        let mirror: &[&str] = &["buzz-mirror", "tasks", "m1", "1700000000"];
        let relayed = relayed_person_mirror(&signed(9, &[&["h", "c"], mirror, author], &signer))
            .expect("relayed person post");
        assert_eq!(relayed.surface, "tasks");
        assert_eq!(relayed.claimed_author.as_deref(), Some(person.as_str()));
        // No claimed author is still a relayed post (shown as the signer's).
        let anonymous: &[&str] = &["buzz-mirror-author", "requester", "", ""];
        assert_eq!(
            relayed_person_mirror(&signed(9, &[&["h", "c"], mirror, anonymous], &signer))
                .and_then(|r| r.claimed_author),
            None
        );
        let signer_hex = signer.public_key().to_hex();
        let self_claim: &[&str] = &["buzz-mirror-author", "requester", &signer_hex, ""];
        let agent_role: &[&str] = &["buzz-mirror-author", "agent", "", ""];
        let short: &[&str] = &["buzz-mirror-author", "requester", &person];
        let bad_surface: &[&str] = &["buzz-mirror", "Tasks", "m1", "1"];
        let bad_time: &[&str] = &["buzz-mirror", "tasks", "m1", "x"];
        for tags in [
            // Kind 40002 stays the quiet marker.
            (40002u16, vec![&["h", "c"][..], mirror, author]),
            (9, vec![&["h", "c"][..], mirror]),
            (9, vec![&["h", "c"][..], author]),
            (9, vec![&["h", "c"][..], mirror, agent_role]),
            (9, vec![&["h", "c"][..], mirror, self_claim]),
            (9, vec![&["h", "c"][..], mirror, short]),
            (9, vec![&["h", "c"][..], bad_surface, author]),
            (9, vec![&["h", "c"][..], bad_time, author]),
            (9, vec![&["h", "c"][..], mirror, author, author]),
            (9, vec![&["h", "c"][..], mirror, mirror, author]),
            (
                9,
                vec![
                    &["h", "c"][..],
                    mirror,
                    author,
                    &["buzz-session", "new", ""],
                ],
            ),
        ] {
            let (kind, tags) = tags;
            assert_eq!(
                relayed_person_mirror(&signed(kind, &tags, &signer)),
                None,
                "{kind} {tags:?}"
            );
        }
    }
}

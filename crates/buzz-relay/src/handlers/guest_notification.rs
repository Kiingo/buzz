//! Envelope validation for agent guest access notifications (kinds
//! 46040–46042).
//!
//! These events tell one owner that someone asked their agent something that
//! needs approval (46040), that such a request was resolved (46041), or that
//! something about their agents' guest access needs attention (46042). They
//! are stored, global (no `h` tag) and addressed by exactly one `p` tag; the
//! read path lets only that owner see them, and the push matcher may wake
//! only that owner. Content is a short, non-sensitive line — clients fetch
//! details from the owner-authenticated approvals API, never from the event.

use buzz_core::kind::{
    KIND_AGENT_GUEST_ALERT, KIND_AGENT_GUEST_APPROVAL_REQUESTED, KIND_AGENT_GUEST_APPROVAL_RESOLVED,
};
use nostr::Event;

/// Longest accepted content, in bytes.
pub(crate) const MAX_CONTENT_BYTES: usize = 512;
/// Longest accepted correlation id (approval or alert id).
const MAX_ID_LEN: usize = 128;

const APPROVAL_TAG: &str = "buzz-guest-approval";
const ALERT_TAG: &str = "buzz-guest-alert";
const RESOLVED_STATUSES: &[&str] = &["approved", "denied", "expired", "cancelled"];
const SEVERITIES: &[&str] = &["high", "info"];

fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn single<'a>(event: &'a Event, name: &str) -> Result<Option<&'a str>, String> {
    let mut values = event.tags.iter().filter_map(|tag| {
        let parts = tag.as_slice();
        (parts.first().map(String::as_str) == Some(name)).then(|| parts.get(1).map(String::as_str))
    });
    let first = values.next();
    if values.next().is_some() {
        return Err(format!("exactly one {name} tag allowed"));
    }
    match first {
        None => Ok(None),
        Some(None) => Err(format!("{name} tag has no value")),
        Some(Some(value)) => Ok(Some(value)),
    }
}

fn required<'a>(event: &'a Event, name: &str) -> Result<&'a str, String> {
    single(event, name)?.ok_or_else(|| format!("missing {name} tag"))
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_LEN
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Validate a 46040/46041/46042 envelope. Called only for those kinds.
pub(crate) fn validate(event: &Event) -> Result<(), String> {
    let kind = buzz_core::kind::event_kind_u32(event);
    if event.content.len() > MAX_CONTENT_BYTES {
        return Err(format!("content exceeds {MAX_CONTENT_BYTES} bytes"));
    }
    let owner = required(event, "p")?;
    if !is_hex64(owner) {
        return Err("p tag must be a lowercase 64-hex pubkey".into());
    }
    if owner == event.pubkey.to_hex() {
        return Err("notification must be addressed to someone other than its author".into());
    }
    let agent = required(event, "agent")?;
    if !is_hex64(agent) {
        return Err("agent tag must be a lowercase 64-hex pubkey".into());
    }
    if single(event, "h")?.is_some() {
        return Err("guest notifications are global; h tag not allowed".into());
    }
    match kind {
        KIND_AGENT_GUEST_APPROVAL_REQUESTED | KIND_AGENT_GUEST_APPROVAL_RESOLVED => {
            if !valid_id(required(event, APPROVAL_TAG)?) {
                return Err(format!("invalid {APPROVAL_TAG} id"));
            }
            if kind == KIND_AGENT_GUEST_APPROVAL_RESOLVED {
                let status = required(event, "status")?;
                if !RESOLVED_STATUSES.contains(&status) {
                    return Err(format!("status must be one of {RESOLVED_STATUSES:?}"));
                }
            }
        }
        KIND_AGENT_GUEST_ALERT => {
            if !valid_id(required(event, ALERT_TAG)?) {
                return Err(format!("invalid {ALERT_TAG} id"));
            }
            let severity = required(event, "severity")?;
            if !SEVERITIES.contains(&severity) {
                return Err(format!("severity must be one of {SEVERITIES:?}"));
            }
        }
        _ => return Err("not a guest notification kind".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn event(kind: u32, content: &str, tags: Vec<Vec<String>>) -> Event {
        EventBuilder::new(Kind::Custom(kind as u16), content)
            .tags(tags.into_iter().map(|t| Tag::parse(t).unwrap()))
            .sign_with_keys(&Keys::generate())
            .unwrap()
    }

    fn base(owner: &str) -> Vec<Vec<String>> {
        vec![
            vec!["p".into(), owner.into()],
            vec!["agent".into(), "b".repeat(64)],
        ]
    }

    fn with(mut tags: Vec<Vec<String>>, extra: &[&[&str]]) -> Vec<Vec<String>> {
        for t in extra {
            tags.push(t.iter().map(|s| s.to_string()).collect());
        }
        tags
    }

    #[test]
    fn well_formed_notifications_are_accepted() {
        let owner = "a".repeat(64);
        let requested = event(
            46040,
            "Jess asked Atlas something that needs your approval.",
            with(
                base(&owner),
                &[&[APPROVAL_TAG, "6f1c-uuid"], &["expiration", "1999999999"]],
            ),
        );
        assert_eq!(validate(&requested), Ok(()));
        let resolved = event(
            46041,
            "",
            with(
                base(&owner),
                &[&[APPROVAL_TAG, "6f1c-uuid"], &["status", "approved"]],
            ),
        );
        assert_eq!(validate(&resolved), Ok(()));
        let alert = event(
            46042,
            "Digest ready.",
            with(base(&owner), &[&[ALERT_TAG, "al-1"], &["severity", "info"]]),
        );
        assert_eq!(validate(&alert), Ok(()));
    }

    #[test]
    fn malformed_notifications_are_rejected() {
        let owner = "a".repeat(64);
        let cases = vec![
            // No correlation id.
            event(46040, "x", base(&owner)),
            // Two owners.
            event(
                46040,
                "x",
                with(
                    base(&owner),
                    &[&["p", &"c".repeat(64)], &[APPROVAL_TAG, "id"]],
                ),
            ),
            // Bad owner key.
            event(46040, "x", with(base("nope"), &[&[APPROVAL_TAG, "id"]])),
            // Channel-scoped.
            event(
                46040,
                "x",
                with(base(&owner), &[&[APPROVAL_TAG, "id"], &["h", "chan"]]),
            ),
            // Unknown status.
            event(
                46041,
                "",
                with(base(&owner), &[&[APPROVAL_TAG, "id"], &["status", "maybe"]]),
            ),
            // Missing severity.
            event(46042, "", with(base(&owner), &[&[ALERT_TAG, "id"]])),
            // Oversized content.
            event(
                46040,
                &"x".repeat(MAX_CONTENT_BYTES + 1),
                with(base(&owner), &[&[APPROVAL_TAG, "id"]]),
            ),
            // Id with spaces.
            event(46040, "x", with(base(&owner), &[&[APPROVAL_TAG, "a b"]])),
        ];
        for case in cases {
            assert!(validate(&case).is_err(), "accepted {:?}", case.tags);
        }
    }

    #[test]
    fn self_addressed_notifications_are_rejected() {
        let keys = Keys::generate();
        let tags = with(
            vec![
                vec!["p".into(), keys.public_key().to_hex()],
                vec!["agent".into(), "b".repeat(64)],
            ],
            &[&[APPROVAL_TAG, "id"]],
        );
        let event = EventBuilder::new(Kind::Custom(46040), "x")
            .tags(tags.into_iter().map(|t| Tag::parse(t).unwrap()))
            .sign_with_keys(&keys)
            .unwrap();
        assert!(validate(&event).is_err());
    }
}

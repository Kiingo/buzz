use nostr::Event;

fn has_tag(event: &Event, name: &str, value: &str) -> bool {
    event.tags.iter().any(|tag| {
        let values = tag.as_slice();
        values.first().map(String::as_str) == Some(name)
            && values.get(1).map(String::as_str) == Some(value)
    })
}

/// Verify both authoritative NIP-IA surfaces. Kind 13535 proves the old
/// identity is currently archived; kind 8002 carries the replacement pointer
/// (the snapshot intentionally contains only bare `p` tags).
pub(super) fn verify_archive_lineage(
    events: &[Event],
    old_public_key: &str,
    new_public_key: &str,
    request_event_id: &str,
) -> Result<(), String> {
    let snapshot = events
        .iter()
        .find(|event| event.kind.as_u16() == 13_535 && has_tag(event, "p", old_public_key))
        .ok_or_else(|| "identity_rotation_archive_verification_failed".to_string())?;
    snapshot
        .verify()
        .map_err(|_| "identity_rotation_archive_verification_failed".to_string())?;

    let exact_delta = events.iter().find(|event| {
        event.kind.as_u16() == 8_002
            && event.pubkey == snapshot.pubkey
            && has_tag(event, "p", old_public_key)
            && has_tag(event, "replaced-by", new_public_key)
            && has_tag(event, "e", request_event_id)
    });
    // A crash after the relay accepted the archive but before the desktop
    // saved its checkpoint makes the retry a canonical no-op, so no new delta
    // is emitted. An earlier relay-signed delta with the exact same lineage is
    // sufficient in that idempotent recovery case.
    let lineage_delta = exact_delta.or_else(|| {
        events.iter().find(|event| {
            event.kind.as_u16() == 8_002
                && event.pubkey == snapshot.pubkey
                && has_tag(event, "p", old_public_key)
                && has_tag(event, "replaced-by", new_public_key)
        })
    });
    lineage_delta
        .ok_or_else(|| "identity_rotation_archive_lineage_missing".to_string())?
        .verify()
        .map_err(|_| "identity_rotation_archive_lineage_invalid".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    #[test]
    fn verifies_bare_snapshot_and_replacement_delta() {
        let relay = Keys::generate();
        let old = Keys::generate().public_key().to_hex();
        let replacement = Keys::generate().public_key().to_hex();
        let request_id = "a".repeat(64);
        let snapshot = EventBuilder::new(Kind::Custom(13_535), "")
            .tags([
                Tag::parse(["-"]).unwrap(),
                Tag::parse(["p", old.as_str()]).unwrap(),
            ])
            .sign_with_keys(&relay)
            .unwrap();
        let delta = EventBuilder::new(Kind::Custom(8_002), "")
            .tags([
                Tag::parse(["-"]).unwrap(),
                Tag::parse(["p", old.as_str()]).unwrap(),
                Tag::parse(["e", request_id.as_str()]).unwrap(),
                Tag::parse(["replaced-by", replacement.as_str()]).unwrap(),
            ])
            .sign_with_keys(&relay)
            .unwrap();

        verify_archive_lineage(&[snapshot.clone(), delta], &old, &replacement, &request_id)
            .unwrap();
        assert_eq!(
            verify_archive_lineage(&[snapshot], &old, &replacement, &request_id),
            Err("identity_rotation_archive_lineage_missing".into())
        );
    }

    #[test]
    fn rejects_a_delta_not_signed_by_the_snapshot_relay() {
        let relay = Keys::generate();
        let attacker = Keys::generate();
        let old = Keys::generate().public_key().to_hex();
        let replacement = Keys::generate().public_key().to_hex();
        let request_id = "b".repeat(64);
        let snapshot = EventBuilder::new(Kind::Custom(13_535), "")
            .tags([Tag::parse(["p", old.as_str()]).unwrap()])
            .sign_with_keys(&relay)
            .unwrap();
        let forged_delta = EventBuilder::new(Kind::Custom(8_002), "")
            .tags([
                Tag::parse(["p", old.as_str()]).unwrap(),
                Tag::parse(["e", request_id.as_str()]).unwrap(),
                Tag::parse(["replaced-by", replacement.as_str()]).unwrap(),
            ])
            .sign_with_keys(&attacker)
            .unwrap();

        assert_eq!(
            verify_archive_lineage(&[snapshot, forged_delta], &old, &replacement, &request_id,),
            Err("identity_rotation_archive_lineage_missing".into())
        );
    }
}

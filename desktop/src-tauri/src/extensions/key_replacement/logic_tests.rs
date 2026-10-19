use super::*;

use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, Tag};

const NOW: u64 = 1_790_000_000;

fn keys(fill: char) -> Keys {
    Keys::parse(&fill.to_string().repeat(64)).unwrap()
}

fn signed(signer: &Keys, kind: u16, tags: &[&[&str]]) -> Event {
    EventBuilder::new(Kind::Custom(kind), "")
        .tags(
            tags.iter()
                .map(|tag| Tag::parse(tag.iter().copied()).unwrap()),
        )
        .sign_with_keys(signer)
        .unwrap()
}

#[test]
fn lookup_proof_is_list_shaped_with_the_key_replacement_action() {
    let owner = keys('1');
    let body =
        build_lookup_request(&owner, "provider-x", "chat.example.test", "req-1", NOW).unwrap();
    assert_eq!(body["contract_version"], 1);
    assert_eq!(body["request_id"], "req-1");
    assert_eq!(body.as_object().unwrap().len(), 3);
    let proof = Event::from_json(body["owner_proof"].to_string()).unwrap();
    proof.verify().unwrap();
    assert_eq!(proof.pubkey, owner.public_key());
    assert_eq!(proof.kind, Kind::Custom(27_236));
    assert_eq!(proof.content, "buzz-provider-owner-v1");
    assert_eq!(proof.created_at.as_secs(), NOW);
    let tags = proof
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .collect::<Vec<_>>();
    assert_eq!(
        tags,
        vec![
            vec!["action".to_string(), "key_replacement".into()],
            vec!["provider".into(), "provider-x".into()],
            vec!["request".into(), "req-1".into()],
            vec!["community".into(), "chat.example.test".into()],
            vec!["expires".into(), (NOW + 300).to_string()],
        ]
    );
}

#[test]
fn lookup_answer_is_bound_to_request_and_owner() {
    let current = keys('1').public_key().to_hex();
    let old = keys('2').public_key().to_hex();
    let answer = |correlation: &str, owner: &str, replacement: Value| {
        json!({
            "contract_version": 1,
            "correlation_id": correlation,
            "owner_public_key": owner,
            "replacement": replacement,
        })
    };
    let found = parse_lookup_response(
        &answer(
            "r",
            &current,
            json!({"old_public_key": old.to_uppercase(), "revoked_at": "2026-10-18T12:00:00Z"}),
        ),
        "r",
        &current,
    )
    .unwrap()
    .unwrap();
    assert_eq!(found.old_public_key, old);
    assert_eq!(found.revoked_at.as_deref(), Some("2026-10-18T12:00:00Z"));
    assert_eq!(
        parse_lookup_response(&answer("r", &current, Value::Null), "r", &current).unwrap(),
        None
    );
    for bad in [
        answer("other", &current, Value::Null),
        answer("r", &old, Value::Null),
        answer("r", &current, json!({"old_public_key": "xyz"})),
        answer("r", &current, json!({"old_public_key": current})),
    ] {
        assert!(parse_lookup_response(&bad, "r", &current).is_err());
    }
}

#[test]
fn only_owner_or_admin_in_a_relay_signed_snapshot_counts() {
    let relay = keys('9');
    let relay_self = relay.public_key().to_hex();
    let me = keys('1').public_key().to_hex();
    let members = |signer: &Keys, role: &str| signed(signer, 13_534, &[&["member", &me, role]]);
    assert!(is_relay_admin(
        &[members(&relay, "owner")],
        &relay_self,
        &me
    ));
    assert!(is_relay_admin(
        &[members(&relay, "admin")],
        &relay_self,
        &me
    ));
    assert!(!is_relay_admin(
        &[members(&relay, "member")],
        &relay_self,
        &me
    ));
    assert!(!is_relay_admin(&[], &relay_self, &me));
    // A snapshot signed by anyone but the relay identity is ignored.
    assert!(!is_relay_admin(
        &[members(&keys('8'), "owner")],
        &relay_self,
        &me
    ));
    // NIP-29 `p` fallback carries the role in the fourth element.
    let fallback = signed(&relay, 13_534, &[&["p", &me, "", "admin"]]);
    assert!(is_relay_admin(&[fallback], &relay_self, &me));
}

#[test]
fn archive_state_reads_the_relay_snapshot_and_successor_delta() {
    let relay = keys('9');
    let relay_self = relay.public_key().to_hex();
    let old = keys('2').public_key().to_hex();
    let current = keys('1').public_key().to_hex();
    let other = keys('3').public_key().to_hex();
    let snapshot = signed(&relay, 13_535, &[&["-"], &["p", &old]]);
    let delta = |successor: &str| {
        signed(
            &relay,
            8_002,
            &[&["-"], &["p", &old], &["replaced-by", successor]],
        )
    };

    assert_eq!(
        archive_state(&[], &relay_self, &old, &current),
        ArchiveState::NotArchived
    );
    assert_eq!(
        archive_state(
            &[signed(&relay, 13_535, &[&["p", &other]])],
            &relay_self,
            &old,
            &current
        ),
        ArchiveState::NotArchived
    );
    assert_eq!(
        archive_state(
            &[snapshot.clone(), delta(&current)],
            &relay_self,
            &old,
            &current
        ),
        ArchiveState::ArchivedReplacedBy
    );
    assert_eq!(
        archive_state(
            &[snapshot.clone(), delta(&other)],
            &relay_self,
            &old,
            &current
        ),
        ArchiveState::ArchivedOther
    );
    assert_eq!(
        archive_state(std::slice::from_ref(&snapshot), &relay_self, &old, &current),
        ArchiveState::ArchivedOther
    );
    // Events not signed by the relay identity change nothing.
    let forged_snapshot = signed(&keys('8'), 13_535, &[&["p", &old]]);
    assert_eq!(
        archive_state(&[forged_snapshot], &relay_self, &old, &current),
        ArchiveState::NotArchived
    );
    let forged_delta = signed(
        &keys('8'),
        8_002,
        &[&["p", &old], &["replaced-by", &current]],
    );
    assert_eq!(
        archive_state(&[snapshot, forged_delta], &relay_self, &old, &current),
        ArchiveState::ArchivedOther
    );
}

#[test]
fn offer_needs_all_three_conditions() {
    let replacement = Replacement {
        old_public_key: "2".repeat(64),
        revoked_at: None,
    };
    assert!(should_offer(
        true,
        Some(&replacement),
        ArchiveState::NotArchived
    ));
    assert!(!should_offer(
        false,
        Some(&replacement),
        ArchiveState::NotArchived
    ));
    assert!(!should_offer(true, None, ArchiveState::NotArchived));
    assert!(!should_offer(
        true,
        Some(&replacement),
        ArchiveState::ArchivedReplacedBy
    ));
    assert!(!should_offer(
        true,
        Some(&replacement),
        ArchiveState::ArchivedOther
    ));
}

#[test]
fn the_archive_request_targets_the_old_key_and_names_the_signer() {
    let signer = keys('1');
    let old = keys('2').public_key().to_hex();
    let current = signer.public_key().to_hex();
    let event = crate::events::build_archive_identity_request(
        &old,
        "",
        Some(ARCHIVE_REASON),
        Some(&current),
        None,
    )
    .unwrap()
    .sign_with_keys(&signer)
    .unwrap();
    assert_eq!(event.kind, Kind::Custom(9_035));
    let tags = event
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .collect::<Vec<_>>();
    assert_eq!(
        tags,
        vec![
            vec!["-".to_string()],
            vec!["p".into(), old],
            vec!["reason".into(), "rotated".into()],
            vec!["replaced-by".into(), current],
        ]
    );
}

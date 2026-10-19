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
    .replacement
    .unwrap();
    assert_eq!(found.old_public_key, old);
    assert_eq!(found.revoked_at.as_deref(), Some("2026-10-18T12:00:00Z"));
    assert_eq!(
        parse_lookup_response(&answer("r", &current, Value::Null), "r", &current).unwrap(),
        LookupAnswer::default()
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

#[test]
fn lookup_answer_reads_the_retired_relay_owner_key() {
    let current = keys('1').public_key().to_hex();
    let retired = keys('4').public_key().to_hex();
    let body = |value: Value| {
        json!({
            "contract_version": 1,
            "correlation_id": "r",
            "owner_public_key": current,
            "replacement": null,
            "retired_relay_owner_public_key": value,
        })
    };
    assert_eq!(
        parse_lookup_response(&body(json!(retired.to_uppercase())), "r", &current)
            .unwrap()
            .retired_relay_owner,
        Some(retired.clone())
    );
    assert_eq!(
        parse_lookup_response(&body(Value::Null), "r", &current)
            .unwrap()
            .retired_relay_owner,
        None
    );
    // A malformed value fails the whole answer closed.
    for bad in [json!("xyz"), json!(7), json!({"key": retired})] {
        assert!(parse_lookup_response(&body(bad), "r", &current).is_err());
    }
}

fn members_snapshot(relay: &Keys, members: &[(&str, &str)]) -> Event {
    let tags = members
        .iter()
        .map(|(key, role)| vec!["member", key, role])
        .collect::<Vec<_>>();
    let tags = tags.iter().map(Vec::as_slice).collect::<Vec<_>>();
    signed(relay, 13_534, &tags)
}

#[test]
fn removal_step_targets_exactly_the_retired_key_when_every_check_agrees() {
    let relay = keys('9');
    let current = keys('1').public_key().to_hex();
    let retired = keys('4').public_key().to_hex();
    let bystander = keys('5').public_key().to_hex();
    let snapshot = members_snapshot(
        &relay,
        &[
            (&current, "owner"),
            (&retired, "admin"),
            (&bystander, "member"),
        ],
    );
    let step = removal_step(Some(&retired.to_uppercase()), &current, Some(&snapshot)).unwrap();
    assert_eq!(
        step,
        RemovalStep {
            public_key: retired.clone(),
            removable: true,
            reason: None,
        }
    );
    // The built request names exactly that key and nothing else.
    let event = crate::events::build_relay_admin_remove(&step.public_key)
        .unwrap()
        .sign_with_keys(&keys('1'))
        .unwrap();
    assert_eq!(event.kind, Kind::Custom(9_031));
    let tags = event
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .collect::<Vec<_>>();
    assert_eq!(tags, vec![vec!["p".to_string(), retired]]);
}

#[test]
fn removal_step_fails_closed_with_a_reason() {
    let relay = keys('9');
    let current = keys('1').public_key().to_hex();
    let retired = keys('4').public_key().to_hex();
    let reason = |retired_key: Option<&str>, snapshot: Option<&Event>| {
        removal_step(retired_key, &current, snapshot).map(|step| {
            assert_eq!(step.removable, step.reason.is_none());
            step.reason
        })
    };

    // No hosted value: no step at all.
    let full = members_snapshot(&relay, &[(&current, "owner"), (&retired, "admin")]);
    assert_eq!(reason(None, Some(&full)), None);
    // The hosted value names the signed-in key.
    assert_eq!(
        reason(Some(&current), Some(&full)),
        Some(Some("is_current_key".into()))
    );
    // Signed-in key is an admin, not the owner.
    let admin = members_snapshot(&relay, &[(&current, "admin"), (&retired, "admin")]);
    assert_eq!(
        reason(Some(&retired), Some(&admin)),
        Some(Some("not_owner".into()))
    );
    // No relay-signed snapshot: the role cannot be shown.
    assert_eq!(reason(Some(&retired), None), Some(Some("not_owner".into())));
    // The retired key is no longer a member.
    let gone = members_snapshot(&relay, &[(&current, "owner")]);
    assert_eq!(
        reason(Some(&retired), Some(&gone)),
        Some(Some("not_a_member".into()))
    );
    // The relay refuses to remove another owner.
    let two_owners = members_snapshot(&relay, &[(&current, "owner"), (&retired, "owner")]);
    assert_eq!(
        reason(Some(&retired), Some(&two_owners)),
        Some(Some("is_owner".into()))
    );
}

#[test]
fn removal_step_ignores_a_membership_snapshot_not_signed_by_the_relay() {
    let relay = keys('9');
    let relay_self = relay.public_key().to_hex();
    let current = keys('1').public_key().to_hex();
    let retired = keys('4').public_key().to_hex();
    let forged = members_snapshot(&keys('8'), &[(&current, "owner"), (&retired, "admin")]);
    let snapshot = relay_members_snapshot(std::slice::from_ref(&forged), &relay_self);
    assert!(snapshot.is_none());
    assert_eq!(
        removal_step(Some(&retired), &current, snapshot).and_then(|step| step.reason),
        Some("not_owner".into())
    );
}

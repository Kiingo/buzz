use super::*;

use nostr::{Event, JsonUtil};

const NOW: u64 = 1_790_000_000;

fn owner() -> Keys {
    Keys::parse("1111111111111111111111111111111111111111111111111111111111111111").unwrap()
}

fn agent_key(fill: char) -> String {
    Keys::parse(&fill.to_string().repeat(64))
        .unwrap()
        .public_key()
        .to_hex()
}

fn selection(id: &str, key: &str) -> RebindSelection {
    RebindSelection {
        provider_agent_id: id.into(),
        agent_public_key: key.into(),
    }
}

fn proof_tags(body: &Value) -> Vec<Vec<String>> {
    body["owner_proof"]["tags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tag| {
            tag.as_array()
                .unwrap()
                .iter()
                .map(|part| part.as_str().unwrap().to_string())
                .collect()
        })
        .collect()
}

fn verify_attestation(attestation: &str, agent: &str) -> bool {
    let agent = PublicKey::from_hex(agent).unwrap();
    let tag: Vec<String> = serde_json::from_str(attestation).unwrap();
    tag.len() == 4
        && tag[0] == "auth"
        && tag[2].is_empty()
        && buzz_sdk_pkg::nip_oa::verify_auth_tag(attestation, &agent).is_ok()
}

#[test]
fn canonical_json_sorts_keys_recursively_like_the_api() {
    let value = json!({"b": 1, "a": {"d": [{"z": 1, "y": "\"q\""}], "c": null}});
    assert_eq!(
        canonical_json(&value),
        r#"{"a":{"c":null,"d":[{"y":"\"q\"","z":1}]},"b":1}"#
    );
}

#[test]
fn rebind_request_has_exact_proof_tags_payload_and_freshness() {
    let owner = owner();
    let ada = agent_key('4');
    let mira = agent_key('5');
    let body = build_rebind_request(
        &owner,
        "provider-x",
        "chat.example.test",
        "req-1",
        &[selection("buzz:ada", &ada), selection("buzz:mira", &mira)],
        NOW,
    )
    .unwrap();

    let keys = body
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(
        sorted,
        ["agents", "contract_version", "owner_proof", "request_id"]
    );
    assert_eq!(body["contract_version"], 1);
    assert_eq!(body["request_id"], "req-1");

    let mut without_proof = body.clone();
    without_proof.as_object_mut().unwrap().remove("owner_proof");
    assert_eq!(
        proof_tags(&body),
        vec![
            vec!["action".to_string(), "rebind_owner_key".into()],
            vec!["provider".into(), "provider-x".into()],
            vec!["request".into(), "req-1".into()],
            vec!["agent".into(), String::new()],
            vec!["community".into(), "chat.example.test".into()],
            vec!["payload".into(), canonical_sha256(&without_proof)],
            vec!["expires".into(), (NOW + 300).to_string()],
        ]
    );

    let proof = Event::from_json(body["owner_proof"].to_string()).unwrap();
    proof.verify().unwrap();
    assert_eq!(proof.pubkey, owner.public_key());
    assert_eq!(proof.kind, Kind::Custom(27_236));
    assert_eq!(proof.content, "buzz-provider-owner-v1");
    assert_eq!(proof.created_at.as_secs(), NOW);
}

#[test]
fn rebind_request_attests_each_selected_agent_and_no_other() {
    let owner = owner();
    let ada = agent_key('4');
    let mira = agent_key('5');
    let sage = agent_key('6');
    let body = build_rebind_request(
        &owner,
        "provider-x",
        "chat.example.test",
        "req-1",
        &[selection("buzz:ada", &ada), selection("buzz:mira", &mira)],
        NOW,
    )
    .unwrap();
    let agents = body["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 2);
    for (agent, key) in agents.iter().zip([&ada, &mira]) {
        let object = agent.as_object().unwrap();
        assert_eq!(object.len(), 3);
        assert_eq!(agent["agent_public_key"], key.as_str());
        let attestation = agent["owner_attestation"].as_str().unwrap();
        assert!(attestation.len() <= 512);
        assert!(attestation.contains(&owner.public_key().to_hex()));
        assert!(verify_attestation(attestation, key));
        // An attestation for one agent does not verify for another.
        assert!(!verify_attestation(attestation, &sage));
    }
    assert!(!body.to_string().contains(&sage));
}

#[test]
fn each_build_is_a_new_single_use_proof() {
    let owner = owner();
    let ada = agent_key('4');
    let first = build_rebind_request(
        &owner,
        "provider-x",
        "chat.example.test",
        "req-1",
        &[selection("buzz:ada", &ada)],
        NOW,
    )
    .unwrap();
    let second = build_rebind_request(
        &owner,
        "provider-x",
        "chat.example.test",
        "req-2",
        &[selection("buzz:ada", &ada)],
        NOW + 1,
    )
    .unwrap();
    assert_ne!(first["owner_proof"]["id"], second["owner_proof"]["id"]);
    assert_ne!(proof_tags(&first)[5], proof_tags(&second)[5]);
}

#[test]
fn invalid_selections_sign_nothing() {
    let owner = owner();
    let ada = agent_key('4');
    let build =
        |selected: &[RebindSelection]| build_rebind_request(&owner, "p", "c", "r", selected, NOW);
    assert_eq!(build(&[]).unwrap_err(), "rebind_selection_invalid");
    let many = (0..=MAX_REBIND_AGENTS)
        .map(|index| selection(&format!("buzz:{index}"), &ada))
        .collect::<Vec<_>>();
    assert_eq!(build(&many).unwrap_err(), "rebind_selection_invalid");
    assert_eq!(
        build(&[selection("buzz:ada", &ada), selection("buzz:ada", &ada)]).unwrap_err(),
        "rebind_selection_invalid"
    );
    assert_eq!(
        build(&[selection("buzz:ada", "not-hex")]).unwrap_err(),
        "rebind_selection_invalid"
    );
    // Self-attestation is refused.
    let own = owner.public_key().to_hex();
    assert_eq!(
        build(&[selection("buzz:self", &own)]).unwrap_err(),
        "owner_attestation_invalid"
    );
}

#[test]
fn list_request_has_five_exact_tags() {
    let body =
        build_list_request(&owner(), "provider-x", "chat.example.test", "req-l", NOW).unwrap();
    assert_eq!(
        proof_tags(&body),
        vec![
            vec!["action".to_string(), "list".into()],
            vec!["provider".into(), "provider-x".into()],
            vec!["request".into(), "req-l".into()],
            vec!["community".into(), "chat.example.test".into()],
            vec!["expires".into(), (NOW + 300).to_string()],
        ]
    );
}

#[test]
fn list_response_reads_owner_keys_and_skips_malformed_agents() {
    let ada = agent_key('4');
    let old = agent_key('3');
    let agents = parse_list_response(
        &json!({
            "contract_version": 1,
            "correlation_id": "req-l",
            "agents": [
                {"provider_agent_id": "buzz:ada", "agent_public_key": ada,
                 "display_name": "Ada", "owner_public_key": old.to_uppercase(),
                 "desired_state": "active", "observed_state": "ready"},
                {"provider_agent_id": "buzz:none", "agent_public_key": ada,
                 "display_name": "None", "owner_public_key": null,
                 "desired_state": "deleted", "observed_state": "deleted"},
                {"provider_agent_id": "buzz:bad", "agent_public_key": "xyz",
                 "display_name": "Bad"},
                {"provider_agent_id": "buzz:blank", "agent_public_key": ada,
                 "display_name": "   "},
                {"provider_agent_id": "buzz:ctl", "agent_public_key": ada,
                 "display_name": " Ada\u{202e}\u{0007} "},
                {"provider_agent_id": "buzz:nl", "agent_public_key": ada,
                 "display_name": "Ada\nLinked: Mira"},
                {"provider_agent_id": "buzz:noname", "agent_public_key": ada}
            ]
        }),
        "req-l",
    )
    .unwrap();
    // Malformed keys are skipped; a bad name keeps the agent, cleaned.
    let names: Vec<_> = agents.iter().map(|a| a.display_name.as_str()).collect();
    assert_eq!(names, ["Ada", "None", "", "Ada", "Ada Linked: Mira", ""]);
    assert_eq!(printable_name(&"x".repeat(300)).chars().count(), 200);
    let agents = &agents[..2];
    assert_eq!(agents[0].owner_public_key.as_deref(), Some(old.as_str()));
    assert!(!agents[0].deleted);
    assert_eq!(agents[1].owner_public_key, None);
    assert!(agents[1].deleted);
    assert!(parse_list_response(
        &json!({"contract_version": 1, "correlation_id": "other", "agents": []}),
        "req-l"
    )
    .is_err());
}

#[test]
fn rebind_response_maps_every_requested_agent_once() {
    let owner = owner().public_key().to_hex();
    let ada = agent_key('4');
    let mira = agent_key('5');
    let requested = [selection("buzz:ada", &ada), selection("buzz:mira", &mira)];
    let results = parse_rebind_response(
        &json!({
            "contract_version": 1,
            "correlation_id": "req-1",
            "owner_public_key": owner,
            "results": [
                {"provider_agent_id": "buzz:ada", "agent_public_key": ada,
                 "outcome": "rejected", "code": "buzz_hosted_previous_owner_not_revoked",
                 "profile_revision": 2, "profile_republished": false}
            ]
        }),
        "req-1",
        &owner,
        &requested,
    )
    .unwrap();
    assert_eq!(
        results,
        vec![
            RebindResult {
                provider_agent_id: "buzz:ada".into(),
                outcome: "rejected".into(),
                code: Some("previous_owner_not_revoked".into()),
            },
            RebindResult {
                provider_agent_id: "buzz:mira".into(),
                outcome: "rejected".into(),
                code: Some("result_missing".into()),
            },
        ]
    );
}

#[test]
fn rebind_response_for_another_request_owner_or_agent_is_refused() {
    let owner = owner().public_key().to_hex();
    let ada = agent_key('4');
    let sage = agent_key('6');
    let requested = [selection("buzz:ada", &ada)];
    let answer = |correlation: &str, owner_key: &str, results: Value| {
        json!({
            "contract_version": 1,
            "correlation_id": correlation,
            "owner_public_key": owner_key,
            "results": results,
        })
    };
    let rebound =
        json!([{"provider_agent_id": "buzz:ada", "agent_public_key": ada, "outcome": "rebound"}]);
    for bad in [
        answer("other", &owner, rebound.clone()),
        answer("req-1", &sage, rebound.clone()),
        answer(
            "req-1",
            &owner,
            json!([{"provider_agent_id": "buzz:sage", "agent_public_key": sage, "outcome": "rebound"}]),
        ),
        answer(
            "req-1",
            &owner,
            json!([{"provider_agent_id": "buzz:ada", "agent_public_key": sage, "outcome": "rebound"}]),
        ),
        answer(
            "req-1",
            &owner,
            json!([
                {"provider_agent_id": "buzz:ada", "agent_public_key": ada, "outcome": "rebound"},
                {"provider_agent_id": "buzz:ada", "agent_public_key": ada, "outcome": "rebound"}
            ]),
        ),
        answer(
            "req-1",
            &owner,
            json!([{"provider_agent_id": "buzz:ada", "agent_public_key": ada, "outcome": "maybe"}]),
        ),
    ] {
        assert_eq!(
            parse_rebind_response(&bad, "req-1", &owner, &requested).unwrap_err(),
            "response_invalid"
        );
    }
}

#[test]
fn attest_pending_request_is_the_rebind_body_with_the_attest_action() {
    let owner = owner();
    let ada = agent_key('4');
    let mira = agent_key('5');
    let sage = agent_key('6');
    let selected = [selection("buzz:ada", &ada), selection("buzz:mira", &mira)];
    let body = build_attest_pending_request(
        &owner,
        "provider-x",
        "chat.example.test",
        "req-a",
        &selected,
        NOW,
    )
    .unwrap();

    let mut keys = body
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        keys,
        ["agents", "contract_version", "owner_proof", "request_id"]
    );

    let mut without_proof = body.clone();
    without_proof.as_object_mut().unwrap().remove("owner_proof");
    assert_eq!(
        proof_tags(&body),
        vec![
            vec!["action".to_string(), "attest_pending".into()],
            vec!["provider".into(), "provider-x".into()],
            vec!["request".into(), "req-a".into()],
            vec!["agent".into(), String::new()],
            vec!["community".into(), "chat.example.test".into()],
            vec!["payload".into(), canonical_sha256(&without_proof)],
            vec!["expires".into(), (NOW + 300).to_string()],
        ]
    );
    let proof = Event::from_json(body["owner_proof"].to_string()).unwrap();
    proof.verify().unwrap();
    assert_eq!(proof.pubkey, owner.public_key());
    assert_eq!(proof.kind, Kind::Custom(27_236));
    assert_eq!(proof.content, "buzz-provider-owner-v1");

    let agents = body["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 2);
    for (agent, key) in agents.iter().zip([&ada, &mira]) {
        assert_eq!(agent.as_object().unwrap().len(), 3);
        let attestation = agent["owner_attestation"].as_str().unwrap();
        assert!(attestation.len() <= 512);
        assert!(verify_attestation(attestation, key));
        assert!(!verify_attestation(attestation, &sage));
    }

    // The same agents re-linked sign the same body under a different action.
    let rebind = build_rebind_request(
        &owner,
        "provider-x",
        "chat.example.test",
        "req-a",
        &selected,
        NOW,
    )
    .unwrap();
    assert_eq!(proof_tags(&rebind)[0][1], "rebind_owner_key");
    assert_eq!(proof_tags(&rebind)[5], proof_tags(&body)[5]);
    assert_ne!(rebind["owner_proof"]["id"], body["owner_proof"]["id"]);
}

#[test]
fn invalid_attest_selections_sign_nothing() {
    let owner = owner();
    let ada = agent_key('4');
    let build = |selected: &[RebindSelection]| {
        build_attest_pending_request(&owner, "p", "c", "r", selected, NOW)
    };
    assert_eq!(build(&[]).unwrap_err(), "attest_selection_invalid");
    let many = (0..=MAX_REBIND_AGENTS)
        .map(|index| selection(&format!("buzz:{index}"), &ada))
        .collect::<Vec<_>>();
    assert_eq!(build(&many).unwrap_err(), "attest_selection_invalid");
    assert_eq!(
        build(&[selection("buzz:ada", &ada), selection("buzz:ada", &ada)]).unwrap_err(),
        "attest_selection_invalid"
    );
    assert_eq!(
        build(&[selection(" ", &ada)]).unwrap_err(),
        "attest_selection_invalid"
    );
    let own = owner.public_key().to_hex();
    assert_eq!(
        build(&[selection("buzz:self", &own)]).unwrap_err(),
        "owner_attestation_invalid"
    );
}

#[test]
fn list_response_reads_status_and_kiingo_agent_id() {
    let ada = agent_key('4');
    let mira = agent_key('5');
    let sage = agent_key('6');
    let id = "0a1b2c3d-0000-4000-8000-00000000abcd";
    let agents = parse_list_response(
        &json!({
            "contract_version": 1,
            "correlation_id": "req-l",
            "agents": [
                {"provider_agent_id": "buzz:ada", "agent_public_key": ada,
                 "display_name": "Ada", "owner_public_key": null,
                 "status": "pending_attestation", "kiingo_agent_id": id.to_uppercase()},
                {"provider_agent_id": "buzz:mira", "agent_public_key": mira,
                 "display_name": "Mira", "status": "active", "kiingo_agent_id": "not-a-uuid"},
                {"provider_agent_id": "buzz:sage", "agent_public_key": sage,
                 "display_name": "Sage", "status": "frozen"},
                {"provider_agent_id": "buzz:old", "agent_public_key": sage,
                 "display_name": "Old"}
            ]
        }),
        "req-l",
    )
    .unwrap();
    let statuses = agents
        .iter()
        .map(|agent| agent.status.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        statuses,
        ["pending_attestation", "active", "unknown", "active"]
    );
    assert_eq!(agents[0].kiingo_agent_id.as_deref(), Some(id));
    assert_eq!(agents[1].kiingo_agent_id, None);
    assert_eq!(agents[0].owner_public_key, None);
}

#[test]
fn uuid_shape_is_strict() {
    assert!(is_uuid("0a1b2c3d-0000-4000-8000-00000000abcd"));
    assert!(!is_uuid("0a1b2c3d00004000800000000000abcd"));
    assert!(!is_uuid("0a1b2c3d-0000-4000-8000-00000000abcg"));
    assert!(!is_uuid("0a1b2c3d-0000-4000-8000-00000000abcd0"));
}

#[test]
fn attest_response_maps_outcomes_dm_and_missing_agents() {
    let owner = owner().public_key().to_hex();
    let ada = agent_key('4');
    let mira = agent_key('5');
    let sage = agent_key('6');
    let id = "0a1b2c3d-0000-4000-8000-00000000abcd";
    let requested = [
        selection("buzz:ada", &ada),
        selection("buzz:mira", &mira),
        selection("buzz:sage", &sage),
    ];
    let results = parse_attest_pending_response(
        &json!({
            "contract_version": 1,
            "correlation_id": "req-a",
            "owner_public_key": owner,
            "results": [
                {"provider_agent_id": "buzz:ada", "agent_public_key": ada,
                 "kiingo_agent_id": id, "outcome": "activated", "code": null,
                 "dm_opened": true},
                {"provider_agent_id": "buzz:mira", "agent_public_key": mira,
                 "outcome": "rejected", "code": "buzz_hosted_not_agent_owner",
                 "dm_opened": "yes"}
            ]
        }),
        "req-a",
        &owner,
        &requested,
    )
    .unwrap();
    assert_eq!(
        results,
        vec![
            AttestResult {
                provider_agent_id: "buzz:ada".into(),
                outcome: "activated".into(),
                code: None,
                dm_opened: true,
                kiingo_agent_id: Some(id.into()),
            },
            AttestResult {
                provider_agent_id: "buzz:mira".into(),
                outcome: "rejected".into(),
                code: Some("not_agent_owner".into()),
                dm_opened: false,
                kiingo_agent_id: None,
            },
            AttestResult {
                provider_agent_id: "buzz:sage".into(),
                outcome: "rejected".into(),
                code: Some("result_missing".into()),
                dm_opened: false,
                kiingo_agent_id: None,
            },
        ]
    );
}

#[test]
fn attest_response_for_another_request_owner_agent_or_outcome_is_refused() {
    let owner = owner().public_key().to_hex();
    let ada = agent_key('4');
    let sage = agent_key('6');
    let requested = [selection("buzz:ada", &ada)];
    let answer = |correlation: &str, owner_key: &str, results: Value| {
        json!({
            "contract_version": 1,
            "correlation_id": correlation,
            "owner_public_key": owner_key,
            "results": results,
        })
    };
    let activated =
        json!([{"provider_agent_id": "buzz:ada", "agent_public_key": ada, "outcome": "activated"}]);
    for bad in [
        answer("other", &owner, activated.clone()),
        answer("req-a", &sage, activated.clone()),
        answer(
            "req-a",
            &owner,
            json!([{"provider_agent_id": "buzz:sage", "agent_public_key": sage, "outcome": "activated"}]),
        ),
        answer(
            "req-a",
            &owner,
            json!([{"provider_agent_id": "buzz:ada", "agent_public_key": sage, "outcome": "activated"}]),
        ),
        // A re-link outcome is not an attest outcome.
        answer(
            "req-a",
            &owner,
            json!([{"provider_agent_id": "buzz:ada", "agent_public_key": ada, "outcome": "rebound"}]),
        ),
    ] {
        assert_eq!(
            parse_attest_pending_response(&bad, "req-a", &owner, &requested).unwrap_err(),
            "response_invalid"
        );
    }
    // And an attest outcome is not a re-link outcome.
    assert_eq!(
        parse_rebind_response(
            &answer("req-a", &owner, activated),
            "req-a",
            &owner,
            &requested
        )
        .unwrap_err(),
        "response_invalid"
    );
}

#[test]
fn pending_entry_in_the_providers_exact_shape_lists_as_pending() {
    let ada = agent_key('4');
    let id = "buzz:0A1B2C3D-0000-4000-8000-00000000ABCD";
    let agents = parse_list_response(
        &json!({
            "contract_version": 1,
            "correlation_id": "req-l",
            "agents": [
                {"contract_version": 1, "status": "pending_attestation",
                 "provider_agent_id": id, "agent_public_key": ada,
                 "kiingo_agent_id": "0a1b2c3d-0000-4000-8000-00000000abcd",
                 "display_name": "Scout", "owner_public_key": null,
                 "desired_state": "paused", "observed_state": "pending_attestation",
                 "profile_revision": 0},
                {"provider_agent_id": " buzz:padded ", "agent_public_key": ada,
                 "display_name": "Padded"}
            ]
        }),
        "req-l",
    )
    .unwrap();
    // The padded id is not usable, so it is skipped rather than trimmed.
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].status, STATUS_PENDING_ATTESTATION);
    assert!(!agents[0].deleted);
    // Ids pass through exactly as the provider wrote them.
    assert_eq!(agents[0].provider_agent_id, id);
}

#[test]
fn batch_requests_send_provider_agent_ids_verbatim() {
    let owner = owner();
    let ada = agent_key('4');
    let id = "buzz:0A1B2C3D-0000-4000-8000-00000000ABCD";
    let body = build_attest_pending_request(
        &owner,
        "provider-x",
        "chat.example.test",
        "req-a",
        &[selection(id, &ada)],
        NOW,
    )
    .unwrap();
    assert_eq!(body["agents"][0]["provider_agent_id"], id);
    for bad in [" buzz:ada", "buzz:ada ", "buzz:\u{7}ada", ""] {
        assert_eq!(
            build_rebind_request(
                &owner,
                "provider-x",
                "chat.example.test",
                "req-r",
                &[selection(bad, &ada)],
                NOW,
            )
            .unwrap_err(),
            "rebind_selection_invalid"
        );
    }
}

#[test]
fn activated_agent_keeps_the_dm_open_failed_note() {
    let owner = owner().public_key().to_hex();
    let ada = agent_key('4');
    let results = parse_attest_pending_response(
        &json!({
            "contract_version": 1,
            "correlation_id": "req-a",
            "owner_public_key": owner,
            "results": [{"provider_agent_id": "buzz:ada", "agent_public_key": ada,
                         "outcome": "activated", "code": "buzz_hosted_dm_open_failed",
                         "dm_opened": false}],
        }),
        "req-a",
        &owner,
        &[selection("buzz:ada", &ada)],
    )
    .unwrap();
    assert_eq!(results[0].outcome, "activated");
    assert_eq!(results[0].code.as_deref(), Some("dm_open_failed"));
    assert!(!results[0].dm_opened);
}

#[test]
fn unlinked_request_is_list_shaped_with_its_own_action() {
    let body = build_list_shaped_request(
        &owner(),
        "list_unlinked",
        "provider-x",
        "chat.example.test",
        "req-u",
        Map::new(),
        NOW,
    )
    .unwrap();
    assert_eq!(body["contract_version"], 1);
    assert_eq!(body["request_id"], "req-u");
    assert_eq!(
        proof_tags(&body),
        vec![
            vec!["action".to_string(), "list_unlinked".into()],
            vec!["provider".into(), "provider-x".into()],
            vec!["request".into(), "req-u".into()],
            vec!["community".into(), "chat.example.test".into()],
            vec!["expires".into(), (NOW + 300).to_string()],
        ]
    );
}

#[test]
fn unlinked_response_hides_machine_defaults_and_malformed_agents() {
    let first = "0a1b2c3d-0000-4000-8000-00000000abcd";
    let second = "0a1b2c3d-0000-4000-8000-00000000abce";
    let agents = parse_unlinked_response(
        &json!({
            "contract_version": 1,
            "correlation_id": "req-u",
            "agents": [
                {"kiingo_agent_id": first.to_uppercase(), "display_name": " Scout ",
                 "owner_principal_type": "User", "machine_default": false},
                {"kiingo_agent_id": second, "display_name": "This Mac",
                 "owner_principal_type": "User", "machine_default": true},
                {"kiingo_agent_id": second, "display_name": "No flag",
                 "owner_principal_type": "User"},
                {"kiingo_agent_id": "not-a-uuid", "display_name": "Bad id",
                 "owner_principal_type": "User", "machine_default": false},
                {"kiingo_agent_id": second, "display_name": "Team",
                 "owner_principal_type": "Group", "machine_default": false},
                {"kiingo_agent_id": first, "display_name": "Again",
                 "owner_principal_type": "User", "machine_default": false},
                {"kiingo_agent_id": second, "display_name": "Mail Helper",
                 "owner_principal_type": "Organization", "machine_default": false}
            ]
        }),
        "req-u",
    )
    .unwrap();
    assert_eq!(
        agents,
        vec![
            UnlinkedAgent {
                kiingo_agent_id: first.into(),
                display_name: "Scout".into(),
                owner_principal_type: "User".into(),
            },
            UnlinkedAgent {
                kiingo_agent_id: second.into(),
                display_name: "Mail Helper".into(),
                owner_principal_type: "Organization".into(),
            },
        ]
    );
    for bad in [
        json!({"contract_version": 1, "correlation_id": "other", "agents": []}),
        json!({"contract_version": 2, "correlation_id": "req-u", "agents": []}),
        json!({"contract_version": 1, "correlation_id": "req-u"}),
    ] {
        assert_eq!(
            parse_unlinked_response(&bad, "req-u").unwrap_err(),
            "response_invalid"
        );
    }
}

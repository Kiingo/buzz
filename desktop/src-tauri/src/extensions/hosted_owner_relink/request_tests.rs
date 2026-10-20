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
                 "display_name": "Bad"}
            ]
        }),
        "req-l",
    )
    .unwrap();
    assert_eq!(agents.len(), 2);
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

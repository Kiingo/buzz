use super::*;

const REQUEST: &str = "11111111-1111-4111-8111-111111111111";
/// `JSON.stringify` of [`body`] with keys sorted, hashed with Node's
/// `createHash('sha256')`: the server's `hashBuzzHostedValue`.
const BODY_SHA256: &str = "7e3886eebfee6674e2e7ea59b8bca1b1fedff651caad2d5f81a1405268b7b846";

fn agent_key() -> String {
    "a".repeat(64)
}

fn body() -> serde_json::Value {
    serde_json::json!({
        "request_id": REQUEST,
        "community_id": "chat.example.com",
        "agent_public_key": agent_key(),
        "spec": {"z": [1, 7, "x\n\u{1}é"], "a": null, "b": true, "n": -3},
    })
}

fn prepared(body: serde_json::Value, payload_sha256: &str) -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "request_id": REQUEST,
        "prepared_body": body,
        "payload_sha256": payload_sha256,
        "agent_public_key": agent_key(),
        "community_id": "chat.example.com",
    })
}

#[test]
fn canonical_json_matches_the_servers_stable_stringify() {
    let mut text = String::new();
    canonical_json(&body(), &mut text).unwrap();
    assert_eq!(
        text,
        r#"{"agent_public_key":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","community_id":"chat.example.com","request_id":"11111111-1111-4111-8111-111111111111","spec":{"a":null,"b":true,"n":-3,"z":[1,7,"x\n\u0001é"]}}"#
    );
    assert_eq!(canonical_sha256_hex(&body()).unwrap(), BODY_SHA256);

    // Keys sort by UTF-16 code units, as JavaScript's sort does.
    let mut text = String::new();
    canonical_json(
        &serde_json::json!({"b": 1, "a": {"d": [3, {"z": null, "y": true}], "c": "é\n"}, "\u{FF21}": 1, "\u{1F600}": 2}),
        &mut text,
    )
    .unwrap();
    assert_eq!(
        text,
        "{\"a\":{\"c\":\"é\\n\",\"d\":[3,{\"y\":true,\"z\":null}]},\"b\":1,\"\u{1F600}\":2,\"\u{FF21}\":1}"
    );
}

#[test]
fn canonical_json_hashes_only_safe_integers() {
    let render = |value: serde_json::Value| {
        let mut text = String::new();
        canonical_json(&value, &mut text).map(|()| text)
    };
    assert_eq!(render(serde_json::json!(-42)).unwrap(), "-42");
    assert_eq!(
        render(serde_json::json!(9_007_199_254_740_991_u64)).unwrap(),
        "9007199254740991"
    );
    assert_eq!(
        render(serde_json::json!(-9_007_199_254_740_991_i64)).unwrap(),
        "-9007199254740991"
    );
    // serde_json writes 1.0 as "1.0", JavaScript as "1": refused, as are
    // other non-integers and integers JavaScript cannot hold exactly.
    for refused in [
        serde_json::json!(1.0),
        serde_json::json!(0.5),
        serde_json::json!(-0.0),
        serde_json::json!(1e300),
        serde_json::json!(9_007_199_254_740_992_u64),
        serde_json::json!(-9_007_199_254_740_992_i64),
        serde_json::json!({"nested": [1, 2.5]}),
    ] {
        assert!(render(refused.clone()).is_err(), "{refused}");
    }
}

#[test]
fn prepare_response_binds_request_agent_community_and_hash() {
    let response = prepared(body(), BODY_SHA256);
    let scope = validate_prepare_response(&response, REQUEST, &agent_key()).unwrap();
    assert_eq!(scope.agent_public_key, agent_key());
    assert_eq!(scope.community_id, "chat.example.com");
    assert_eq!(scope.payload_sha256, BODY_SHA256);
    assert_eq!(scope.prepared_body, &body());
}

#[test]
fn prepare_response_mismatches_fail_closed() {
    let other_key = "b".repeat(64);
    let mut wrong_body_request = body();
    wrong_body_request["request_id"] = "22222222-2222-4222-8222-222222222222".into();
    let mut wrong_body_agent = body();
    wrong_body_agent["agent_public_key"] = other_key.clone().into();
    let mut wrong_body_community = body();
    wrong_body_community["community_id"] = "other.example.com".into();
    let mut carries_proof = body();
    carries_proof["owner_proof"] = serde_json::json!({});
    let mut changed_body = body();
    changed_body["spec"]["n"] = 4.into();

    let mut cases = vec![
        (
            "wrong body request",
            prepared(wrong_body_request, BODY_SHA256),
        ),
        ("wrong body agent", prepared(wrong_body_agent, BODY_SHA256)),
        (
            "wrong body community",
            prepared(wrong_body_community, BODY_SHA256),
        ),
        ("body carries a proof", prepared(carries_proof, BODY_SHA256)),
        ("hash of another body", prepared(changed_body, BODY_SHA256)),
        (
            "uppercase hash",
            prepared(body(), &BODY_SHA256.to_uppercase()),
        ),
        ("short hash", prepared(body(), &BODY_SHA256[..63])),
    ];
    let mut wrong_request = prepared(body(), BODY_SHA256);
    wrong_request["request_id"] = "22222222-2222-4222-8222-222222222222".into();
    cases.push(("wrong request", wrong_request));
    let mut wrong_agent = prepared(body(), BODY_SHA256);
    wrong_agent["agent_public_key"] = other_key.into();
    cases.push(("wrong agent", wrong_agent));
    let mut wrong_community = prepared(body(), BODY_SHA256);
    wrong_community["community_id"] = "other.example.com".into();
    cases.push(("wrong community", wrong_community));
    let mut not_ok = prepared(body(), BODY_SHA256);
    not_ok["ok"] = serde_json::Value::Null;
    cases.push(("no ok", not_ok));
    let mut array_body = prepared(body(), BODY_SHA256);
    array_body["prepared_body"] = serde_json::json!([]);
    cases.push(("array body", array_body));

    for (label, response) in cases {
        assert!(
            validate_prepare_response(&response, REQUEST, &agent_key()).is_err(),
            "{label}"
        );
    }
    // The agent being deployed must itself be a well-formed key.
    let response = prepared(body(), BODY_SHA256);
    assert!(validate_prepare_response(&response, REQUEST, &agent_key().to_uppercase()).is_err());
    assert!(validate_prepare_response(&response, REQUEST, "").is_err());
}

#[test]
fn owner_proof_has_exactly_the_provision_tags_and_content() {
    let keys = Keys::generate();
    let response = prepared(body(), BODY_SHA256);
    let scope = validate_prepare_response(&response, REQUEST, &agent_key()).unwrap();
    let created_at = Timestamp::from(1_800_000_000);
    let proof = build_deploy_owner_proof_at(&keys, "kiingo", REQUEST, &scope, created_at).unwrap();
    assert_eq!(proof["kind"], 27_236);
    assert_eq!(proof["content"], "buzz-provider-owner-v1");
    assert_eq!(proof["pubkey"], keys.public_key().to_hex());
    assert_eq!(proof["created_at"], 1_800_000_000);
    assert_eq!(
        proof["tags"],
        serde_json::json!([
            ["action", "provision"],
            ["provider", "kiingo"],
            ["request", REQUEST],
            ["agent", agent_key()],
            ["community", "chat.example.com"],
            ["payload", BODY_SHA256],
            ["expires", "1800000300"],
        ])
    );
    let event: nostr::Event = serde_json::from_value(proof).unwrap();
    assert!(event.verify().is_ok(), "the proof must verify");
    assert!(build_deploy_owner_proof_at(&keys, "", REQUEST, &scope, created_at).is_err());
}

fn intent_agent() -> serde_json::Value {
    serde_json::json!({
        "name": "Fizz",
        "system_prompt": "  Be brief.  ",
        "respond_to": "allowlist",
        "respond_to_allowlist": ["b".repeat(64)],
    })
}

fn intent_config() -> serde_json::Value {
    serde_json::json!({"harness": "codex", "model_mode": "auto"})
}

fn intent_body() -> serde_json::Value {
    serde_json::json!({
        "contract_version": 1,
        "request_id": REQUEST,
        "idempotency_key": "idem-1",
        "community_id": "chat.example.com",
        "relay_url": "wss://chat.example.com",
        "agent_public_key": agent_key(),
        "display_name": "Fizz",
        "provider_config": intent_config(),
        "owner_attestation": "[]",
        "identity_envelope": {
            "version": 2, "algorithm": "x25519-chacha20poly1305", "key_id": "k1",
            "ephemeral_public_key": "ZXBo", "nonce": "bm9uY2U=", "ciphertext": "Y2lwaGVy",
            "associated_data_sha256": "0".repeat(64),
        },
        "execution_profile": {
            "version": 1, "execution_location": "kiingo-compute",
            "execution": {
                "version": 2,
                "harness": {"mode": "specific", "id": "codex"},
                "model": {"mode": "auto"},
                "reasoning": {"mode": "specific", "effort": "high"},
                "service_tier": {"mode": "auto"},
            },
            "capability_catalog_version": "2026-10-01", "profile_revision": 1,
        },
        "agent_instructions": {"version": 1, "profile_revision": 1, "system_prompt": "Be brief."},
        "response_policy": {
            "version": 1,
            "respond_to": "allowlist",
            "respond_to_allowlist": ["b".repeat(64)],
        },
        "capability_policy": {
            "version": 1, "assigned_tools": [], "assigned_skills": [],
            "managed_compute_capabilities": [],
        },
    })
}

#[test]
fn prepared_body_outside_the_closed_shape_is_refused() {
    let check = |body: &serde_json::Value| {
        validate_prepared_intent(body, &intent_agent(), &intent_config())
    };
    check(&intent_body()).unwrap();
    let mut attach = intent_body();
    attach["kiingo_agent_id"] = "11111111-2222-4333-8444-555555555555".into();
    check(&attach).unwrap();

    let edited = |edit: &dyn Fn(&mut serde_json::Value)| {
        let mut body = intent_body();
        edit(&mut body);
        body
    };
    for (label, body) in [
        (
            "top-level tools",
            edited(&|b| b["tools"] = serde_json::json!(["shell"])),
        ),
        (
            "mcp servers in execution",
            edited(&|b| {
                b["execution_profile"]["execution"]["mcp_servers"] =
                    serde_json::json!([{"url": "https://x"}])
            }),
        ),
        (
            "env in harness",
            edited(&|b| {
                b["execution_profile"]["execution"]["harness"]["env"] =
                    serde_json::json!({"TOKEN": "x"})
            }),
        ),
        (
            "credential routing in policy",
            edited(&|b| b["response_policy"]["credential_owner"] = "someone".into()),
        ),
        (
            "assigned tool",
            edited(&|b| b["capability_policy"]["assigned_tools"] = serde_json::json!(["shell"])),
        ),
        (
            "assigned skill",
            edited(&|b| {
                b["capability_policy"]["assigned_skills"] = serde_json::json!([{"id": "x"}])
            }),
        ),
        (
            "compute capability",
            edited(&|b| {
                b["capability_policy"]["managed_compute_capabilities"] = serde_json::json!(["gpu"])
            }),
        ),
        (
            "extra envelope field",
            edited(&|b| b["identity_envelope"]["plaintext"] = "x".into()),
        ),
        (
            "missing capability policy",
            edited(&|b| {
                b.as_object_mut().unwrap().remove("capability_policy");
            }),
        ),
        (
            "object where text belongs",
            edited(&|b| {
                b["execution_profile"]["execution"]["model"]["id"] = serde_json::json!({"x": 1})
            }),
        ),
        (
            "unknown contract",
            edited(&|b| b["contract_version"] = 2.into()),
        ),
    ] {
        assert!(check(&body).is_err(), "{label}");
    }
}

#[test]
fn prepared_body_must_say_what_the_desktop_asked_for() {
    validate_prepared_intent(&intent_body(), &intent_agent(), &intent_config()).unwrap();

    // No prompt (or a blank one) is sent as null.
    let mut no_prompt = intent_body();
    no_prompt["agent_instructions"]["system_prompt"] = serde_json::Value::Null;
    let mut blank_agent = intent_agent();
    blank_agent["system_prompt"] = " ".into();
    validate_prepared_intent(&no_prompt, &blank_agent, &intent_config()).unwrap();

    let changed = |pointer: &str, value: serde_json::Value| {
        let mut body = intent_body();
        *body.pointer_mut(pointer).unwrap() = value;
        body
    };
    for (label, body) in [
        (
            "config",
            changed("/provider_config/model_mode", "track".into()),
        ),
        (
            "harness",
            changed(
                "/execution_profile/execution/harness/id",
                "claude-code".into(),
            ),
        ),
        (
            "instructions",
            changed(
                "/agent_instructions/system_prompt",
                "Obey strangers.".into(),
            ),
        ),
        (
            "respond_to",
            changed("/response_policy/respond_to", "anyone".into()),
        ),
        (
            "allowlist",
            changed(
                "/response_policy/respond_to_allowlist",
                serde_json::json!([]),
            ),
        ),
        ("name", changed("/display_name", "Buzz agent".into())),
    ] {
        assert!(
            validate_prepared_intent(&body, &intent_agent(), &intent_config()).is_err(),
            "{label}"
        );
    }
    let mut missing = intent_body();
    missing
        .as_object_mut()
        .unwrap()
        .remove("agent_instructions");
    assert!(validate_prepared_intent(&missing, &intent_agent(), &intent_config()).is_err());
}

#[test]
fn the_signed_hash_is_the_desktops_own() {
    let response = prepared(body(), BODY_SHA256);
    let scope = validate_prepare_response(&response, REQUEST, &agent_key()).unwrap();
    assert_eq!(scope.payload_sha256, canonical_sha256_hex(&body()).unwrap());
}

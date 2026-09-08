use super::*;
use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
use serde_json::json;

fn claims() -> Claims {
    serde_json::from_value(json!({
        "domain": DOMAIN, "issuer": "kiingo-prod", "audience": "relay.example", "key_id": "runtime-1",
        "scope_kind": "discussion", "scope_id": "11111111-1111-4111-8111-111111111111",
        "channel_id": "33333333-3333-4333-8333-333333333333",
        "requester_public_key": "5".repeat(64), "request_event_id": "a".repeat(64),
        "action": { "operation": "publish", "receipt_id": "22222222-2222-4222-8222-222222222222",
            "fence_id": "11111111-1111-4111-8111-111111111111",
            "signer_public_key": "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            "event_template_hash": "4b091a26db2405882381e900e9d9ad1d18fd78838dc700db05fc23e020eebe3d"
        }
    })).unwrap()
}

fn event(content: &str, extra: Vec<Vec<String>>, kind: u16, timestamp: u64) -> Event {
    let keys = Keys::parse(format!("{:064x}", 1).as_str()).unwrap();
    let mut tags = vec![
        vec![
            "h".to_string(),
            "33333333-3333-4333-8333-333333333333".to_string(),
        ],
        vec![
            "e".to_string(),
            "a".repeat(64),
            "".to_string(),
            "reply".to_string(),
        ],
        vec![
            "d".to_string(),
            "buzz-local-publication:11111111-1111-4111-8111-111111111111".to_string(),
        ],
    ];
    tags.extend(extra);
    EventBuilder::new(Kind::Custom(kind), content)
        .tags(tags.into_iter().map(|tag| Tag::parse(tag).unwrap()))
        .custom_created_at(Timestamp::from_secs(timestamp))
        .sign_with_keys(&keys)
        .unwrap()
}

#[test]
fn exact_template_is_bound_without_circular_authorization_hash() {
    let permit = claims();
    let runtime = vec![AUTHORIZATION_TAG.to_string(), "encoded-token".to_string()];
    let signed = event("Done", vec![runtime.clone()], 9, 1788811000);
    signed.verify().unwrap();
    assert!(permit.check_event(&signed).is_ok());
    for changed in [
        event("Changed.", vec![runtime.clone()], 9, 1788811000),
        event("Done.", vec![runtime.clone()], 9, 1788811001),
        event("Done.", vec![runtime.clone()], 40098, 1788811000),
        event("Done.", vec![], 9, 1788811000),
        event(
            "Done.",
            vec![runtime.clone(), runtime.clone()],
            9,
            1788811000,
        ),
        event(
            "Done.",
            vec![runtime, vec!["h".into(), permit.channel_id.clone()]],
            9,
            1788811000,
        ),
    ] {
        assert!(permit.check_event(&changed).is_err());
    }
}

#[test]
fn operation_and_scope_are_domain_separated_without_expiration() {
    let publish = claims();
    let mut cancel = publish.clone();
    cancel.action = Operation::Cancel {
        user_request_event_id: "c".repeat(64),
    };
    assert!(cancel.validate().is_ok());
    assert_ne!(
        publish.signing_bytes().unwrap(),
        cancel.signing_bytes().unwrap()
    );
    assert!(cancel
        .check_event(&event(
            "Done.",
            vec![vec!["runtime".into(), "token".into()]],
            9,
            1788811000
        ))
        .is_err());
    cancel.action = Operation::Cancel {
        user_request_event_id: cancel.request_event_id.clone(),
    };
    assert!(cancel.validate().is_err());
    let mut wrong_scope = publish.clone();
    wrong_scope.scope_kind = ScopeKind::Receipt;
    assert!(wrong_scope.validate().is_err());
    wrong_scope.scope_id = "22222222-2222-4222-8222-222222222222".into();
    assert!(wrong_scope.validate().is_ok());
    let mut wrong_domain = publish;
    wrong_domain.domain = "buzz-hosted-catalog-v1".into();
    assert!(wrong_domain.validate().is_err());
}

#[test]
fn parsing_is_bounded_strict_and_does_not_claim_signature_authority() {
    let valid = Authorization {
        claims: claims(),
        signature: URL_SAFE_NO_PAD.encode([0; 64]),
    };
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&valid).unwrap());
    let envelope = serde_json::to_value(&valid).unwrap();
    let encode =
        |value: &serde_json::Value| URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap());
    // This all-zero signature is merely well-formed. Only a trusted issuer
    // verification can authenticate it; decoding must not confer authority.
    assert!(Authorization::decode(&encoded).is_ok());
    let mut invalid = envelope.clone();
    invalid["claims"]["action"]["operation"] = json!("cancelled");
    assert!(Authorization::decode(&encode(&invalid)).is_err());
    invalid = envelope.clone();
    invalid["public_key"] = json!("untrusted-key");
    assert!(Authorization::decode(&encode(&invalid)).is_err());
    invalid = envelope.clone();
    invalid["signature"] = json!(URL_SAFE_NO_PAD.encode([0; 63]));
    assert!(Authorization::decode(&encode(&invalid)).is_err());
    assert!(Authorization::decode(&format!("{}=", encode(&envelope))).is_err());
    assert!(Authorization::decode(&"x".repeat(MAX_AUTHORIZATION_BYTES + 1)).is_err());
}

#[test]
fn verifies_node_signature_and_rejects_alternate_authority_or_token_encoding() {
    // Same public RFC8032 fixture and exact signing vector as the API test.
    let signature =
        "c0kAno3slU51SmN7mTyFDt0SbeusSgtdfN31u2SFSLSfSykAYkuflsiVBe2Xv4uZf4gbjO1bN7iilbwXzS8qBg";
    let public_key: [u8; 32] =
        hex::decode("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
            .unwrap()
            .try_into()
            .unwrap();
    let community = crate::CommunityId::from_uuid(Uuid::new_v4());
    let trust = || TrustedIssuer {
        community,
        audience: "relay.example",
        issuer: "kiingo-prod",
        key_id: "runtime-1",
        public_key: &public_key,
    };
    let auth = Authorization {
        claims: claims(),
        signature: signature.into(),
    };
    assert_eq!(
        hex::encode(Sha256::digest(auth.claims.signing_bytes().unwrap())),
        "b256872064e86057301ff9bb2da5be3de51cb9002e430bd9456cfadc532929f4"
    );
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&auth).unwrap());
    let signed = event(
        "Done",
        vec![vec![AUTHORIZATION_TAG.into(), encoded.clone()]],
        9,
        1788811000,
    );
    let verified = VerifiedAuthorization::publication(&signed, trust()).unwrap();
    assert_eq!(verified.community(), community);
    assert_eq!(verified.claims(), &claims());
    assert_eq!(verified.publication_event_id(), Some(signed.id));
    assert!(VerifiedAuthorization::cancellation(&encoded, trust()).is_err());
    assert!(VerifiedAuthorization::publication(
        &signed,
        TrustedIssuer {
            audience: "other.example",
            ..trust()
        }
    )
    .is_err());
    assert!(VerifiedAuthorization::publication(
        &signed,
        TrustedIssuer {
            issuer: "other",
            ..trust()
        }
    )
    .is_err());
    assert!(VerifiedAuthorization::publication(
        &signed,
        TrustedIssuer {
            key_id: "other",
            ..trust()
        }
    )
    .is_err());
    assert!(VerifiedAuthorization::publication(
        &signed,
        TrustedIssuer {
            public_key: &[1; 32],
            ..trust()
        }
    )
    .is_err());
    let mut forged = auth.clone();
    forged.claims.action = Operation::Cancel {
        user_request_event_id: "c".repeat(64),
    };
    let forged = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&forged).unwrap());
    assert!(VerifiedAuthorization::cancellation(&forged, trust()).is_err());
    let spaced = URL_SAFE_NO_PAD.encode(serde_json::to_vec_pretty(&auth).unwrap());
    assert!(Authorization::decode(&spaced).is_err());
    let mut cancel = auth;
    cancel.claims.action = Operation::Cancel {
        user_request_event_id: "c".repeat(64),
    };
    cancel.signature =
        "RaGlzQDellKRKXdasR9989fv1FgP9Y2xqGJMwU806gQO1ujkvY9ZyHANwc6yXKJV6sUMk0R3NhPdCZFGc73fCg"
            .into();
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cancel).unwrap());
    let verified = VerifiedAuthorization::cancellation(&encoded, trust()).unwrap();
    assert_eq!(verified.community(), community);
    assert_eq!(verified.claims(), &cancel.claims);
    assert_eq!(verified.publication_event_id(), None);
}

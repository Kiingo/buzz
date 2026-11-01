use buzz_core::engram::{self, Body};
use buzz_signer::{Op, Output, Reply, Request};
use nostr::nips::nip44;
use nostr::{Event, EventBuilder, JsonUtil as _, Keys, Kind, Tag, UnsignedEvent};

use super::ops::{nostr_header, Signer};
use super::server::answer;

const NOW: u64 = 1_800_000_000;
const RELAY: &str = "wss://relay.example";

struct Fixture {
    agent: Keys,
    owner: Keys,
    signer: Signer,
}

fn auth_tag(owner: &Keys) -> Tag {
    Tag::parse([
        "auth".to_string(),
        owner.public_key().to_hex(),
        String::new(),
        "ab".repeat(64),
    ])
    .unwrap()
}

fn fixture() -> Fixture {
    let agent = Keys::generate();
    let owner = Keys::generate();
    let signer = Signer::new(
        agent.clone(),
        Some(auth_tag(&owner)),
        RELAY,
        &["https://media.example".to_string()],
    )
    .unwrap();
    Fixture {
        agent,
        owner,
        signer,
    }
}

fn refused(result: Result<Output, &'static str>) -> &'static str {
    result.expect_err("must be refused")
}

fn signed_event(result: Result<Output, &'static str>) -> Event {
    match result.expect("must be signed") {
        Output::Event(json) => Event::from_json(json).unwrap(),
        other => panic!("not an event: {other:?}"),
    }
}

fn sign_event(kind: u16, tags: Vec<Vec<String>>, created_at: Option<u64>) -> Op {
    Op::SignEvent {
        kind,
        content: "hello".into(),
        tags,
        created_at,
    }
}

#[test]
fn the_signer_computes_the_id_and_injects_the_owner_tag() {
    let f = fixture();
    let event = signed_event(f.signer.handle(sign_event(1, vec![], None), NOW));
    event.verify().unwrap();
    assert_eq!(event.pubkey, f.agent.public_key());
    assert_eq!(event.created_at.as_secs(), NOW);
    assert!(event.tags.iter().any(|tag| tag.as_slice()[0] == "auth"));
}

#[test]
fn reserved_kinds_are_refused_on_sign_event() {
    let f = fixture();
    for kind in [27235, 24242, 22242] {
        assert_eq!(
            refused(f.signer.handle(sign_event(kind, vec![], None), NOW)),
            "signer_kind_reserved"
        );
    }
}

#[test]
fn a_caller_auth_tag_is_refused_except_on_identity_archive_kinds() {
    let f = fixture();
    let tag = vec![vec!["auth".to_string(), "x".to_string()]];
    assert_eq!(
        refused(f.signer.handle(sign_event(1, tag.clone(), None), NOW)),
        "signer_auth_tag_refused"
    );
    let event = signed_event(f.signer.handle(sign_event(9035, tag, None), NOW));
    let auth: Vec<_> = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice()[0] == "auth")
        .collect();
    assert_eq!(auth.len(), 1);
    assert_eq!(auth[0].as_slice()[1], "x");
}

#[test]
fn an_out_of_window_created_at_is_refused_and_an_inside_one_honoured() {
    let f = fixture();
    assert_eq!(
        refused(f.signer.handle(sign_event(1, vec![], Some(NOW - 61)), NOW)),
        "signer_created_at_out_of_window"
    );
    let event = signed_event(f.signer.handle(sign_event(1, vec![], Some(NOW + 60)), NOW));
    assert_eq!(event.created_at.as_secs(), NOW + 60);
}

#[test]
fn nip98_stays_on_the_configured_origins() {
    let f = fixture();
    for url in ["https://relay.example/api", "https://media.example/x"] {
        let event = signed_event(f.signer.handle(
            Op::Nip98 {
                url: url.into(),
                method: "GET".into(),
                payload_hash: None,
                owner_tag: false,
            },
            NOW,
        ));
        assert_eq!(event.kind, Kind::Custom(27235));
    }
    for url in [
        "https://evil.example/api",
        "http://relay.example/api",
        "https://relay.example:8443/api",
        "https://relay.example.evil.example/",
        "not a url",
    ] {
        assert_eq!(
            refused(f.signer.handle(
                Op::Nip98 {
                    url: url.into(),
                    method: "GET".into(),
                    payload_hash: None,
                    owner_tag: false,
                },
                NOW,
            )),
            "signer_origin_refused",
            "{url}"
        );
    }
}

#[test]
fn nip98_refuses_a_bad_method_or_payload_hash() {
    let f = fixture();
    let url = "https://relay.example/api".to_string();
    assert_eq!(
        refused(f.signer.handle(
            Op::Nip98 {
                url: url.clone(),
                method: "get\nx".into(),
                payload_hash: None,
                owner_tag: false,
            },
            NOW,
        )),
        "signer_method_invalid"
    );
    assert_eq!(
        refused(f.signer.handle(
            Op::Nip98 {
                url,
                method: "POST".into(),
                payload_hash: Some("zz".into()),
                owner_tag: false,
            },
            NOW,
        )),
        "signer_payload_hash_invalid"
    );
}

#[test]
fn blossom_binds_verb_hash_and_the_signers_expiry() {
    let f = fixture();
    let sha256 = "a".repeat(64);
    let tag = |event: &nostr::Event, name: &str| {
        event
            .tags
            .iter()
            .find(|tag| tag.as_slice()[0] == name)
            .map(|tag| tag.as_slice()[1].clone())
    };
    let upload = signed_event(f.signer.handle(
        Op::BlossomUpload {
            sha256: sha256.clone(),
            url: "https://relay.example".into(),
        },
        NOW,
    ));
    assert_eq!(tag(&upload, "t").as_deref(), Some("upload"));
    assert_eq!(tag(&upload, "x"), Some(sha256));
    let expiration: u64 = tag(&upload, "expiration").unwrap().parse().unwrap();
    assert!(expiration > NOW);
    let get = signed_event(f.signer.handle(
        Op::BlossomGet {
            media_url: "https://relay.example/media/x".into(),
        },
        NOW,
    ));
    assert_eq!(tag(&get, "t").as_deref(), Some("get"));
    assert_eq!(tag(&get, "x"), None);
    assert_eq!(tag(&get, "expiration"), Some(expiration.to_string()));
}

#[test]
fn blossom_upload_refuses_anything_but_a_sha256() {
    let f = fixture();
    for sha256 in [String::new(), "A".repeat(64), "a".repeat(63)] {
        assert_eq!(
            refused(f.signer.handle(
                Op::BlossomUpload {
                    sha256,
                    url: "https://relay.example".into(),
                },
                NOW,
            )),
            "signer_payload_hash_invalid"
        );
    }
}

#[test]
fn the_owner_tag_goes_only_to_the_git_origin() {
    let f = fixture();
    for url in [
        "https://media.example/git/o/r",
        "https://evil.example/git/o/r",
    ] {
        let op = Op::Nip98 {
            url: url.into(),
            method: "GET".into(),
            payload_hash: None,
            owner_tag: true,
        };
        assert!(
            matches!(
                refused(f.signer.handle(op, NOW)),
                "signer_owner_tag_refused" | "signer_origin_refused"
            ),
            "{url}"
        );
    }
    assert_eq!(
        refused(f.signer.handle(
            Op::Nip98 {
                url: "https://media.example/x".into(),
                method: "GET".into(),
                payload_hash: None,
                owner_tag: true,
            },
            NOW,
        )),
        "signer_owner_tag_refused"
    );
}

#[test]
fn blossom_stays_on_the_configured_origins() {
    let f = fixture();
    let event = signed_event(f.signer.handle(
        Op::BlossomUpload {
            sha256: "a".repeat(64),
            url: "https://relay.example".into(),
        },
        NOW,
    ));
    assert_eq!(event.kind, Kind::Custom(24242));
    assert_eq!(
        refused(f.signer.handle(
            Op::BlossomGet {
                media_url: "https://evil.example/media/x".into(),
            },
            NOW,
        )),
        "signer_origin_refused"
    );
    assert!(nostr_header("{}").starts_with("Nostr "));
}

#[test]
fn relay_auth_names_only_a_relay_of_the_signers_own() {
    let f = fixture();
    let challenge = "a1".repeat(32);
    let event = signed_event(f.signer.handle(
        Op::RelayAuth {
            challenge: challenge.clone(),
            relay: RELAY.into(),
        },
        NOW,
    ));
    assert_eq!(event.kind, Kind::Authentication);
    let relay = event
        .tags
        .iter()
        .find(|tag| tag.as_slice()[0] == "relay")
        .unwrap();
    assert_eq!(relay.as_slice()[1].trim_end_matches('/'), RELAY);
    event.verify().unwrap();
}

#[test]
fn relay_auth_refuses_anything_but_a_relay_challenge() {
    let f = fixture();
    assert_eq!(
        refused(f.signer.handle(
            Op::RelayAuth {
                challenge: "short".into(),
                relay: RELAY.into(),
            },
            NOW,
        )),
        "signer_challenge_invalid"
    );
}

#[test]
fn relay_auth_refuses_a_relay_off_the_signers_origins() {
    let f = fixture();
    for relay in [
        "wss://relay.evil.example",
        "https://relay.example",
        "not a url",
    ] {
        assert_eq!(
            refused(f.signer.handle(
                Op::RelayAuth {
                    challenge: "a1".repeat(32),
                    relay: relay.into(),
                },
                NOW,
            )),
            "signer_origin_refused",
            "{relay}"
        );
    }
}

fn memory_body() -> Body {
    Body::Memory {
        slug: "mem/notes".into(),
        value: Some("remember this".into()),
    }
}

fn body_json(body: &Body) -> String {
    String::from_utf8(body.to_json_bytes()).unwrap()
}

#[test]
fn an_engram_written_by_the_signer_reads_back() {
    let f = fixture();
    let event = signed_event(f.signer.handle(
        Op::MemWrite {
            body_json: body_json(&memory_body()),
            created_at: None,
        },
        NOW,
    ));
    let reply = f
        .signer
        .handle(
            Op::MemRead {
                event_json: event.as_json(),
            },
            NOW,
        )
        .unwrap();
    assert_eq!(reply, Output::Body(body_json(&memory_body())));
}

/// Any ciphertext under the agent-owner conversation key, wrapped by a child.
fn forged_wrapper(f: &Fixture, signer_keys: &Keys, pubkey_as_agent: bool) -> String {
    let secret = r#"{"not":"an engram"}"#;
    let ciphertext = nip44::encrypt(
        f.owner.secret_key(),
        &f.agent.public_key(),
        secret,
        nip44::Version::V2,
    )
    .unwrap();
    let key = engram::conversation_key(f.agent.secret_key(), &f.owner.public_key());
    let d = engram::d_tag(&key, "mem/notes");
    let builder = EventBuilder::new(Kind::Custom(30174), ciphertext).tags([
        Tag::parse(["d", d.as_str()]).unwrap(),
        Tag::parse(["p", f.owner.public_key().to_hex().as_str()]).unwrap(),
    ]);
    let event = builder.sign_with_keys(signer_keys).unwrap();
    if !pubkey_as_agent {
        return event.as_json();
    }
    // Claim the agent as author, keeping the child's signature.
    let mut value: serde_json::Value = serde_json::from_str(&event.as_json()).unwrap();
    value["pubkey"] = f.agent.public_key().to_hex().into();
    value.to_string()
}

#[test]
fn mem_read_refuses_a_wrapper_the_agent_did_not_sign() {
    let f = fixture();
    let child = Keys::generate();
    assert_eq!(
        refused(f.signer.handle(
            Op::MemRead {
                event_json: forged_wrapper(&f, &child, false),
            },
            NOW,
        )),
        "signer_mem_author_refused"
    );
    assert_eq!(
        refused(f.signer.handle(
            Op::MemRead {
                event_json: forged_wrapper(&f, &child, true),
            },
            NOW,
        )),
        "signer_mem_event_invalid"
    );
}

#[test]
fn a_child_cannot_get_an_agent_signed_wrapper_to_begin_with() {
    let f = fixture();
    assert_eq!(
        refused(f.signer.handle(sign_event(30174, vec![], None), NOW)),
        "signer_kind_not_allowed"
    );
}

#[test]
fn git_sign_returns_a_signature_over_the_nip_gs_preimage() {
    use base64::Engine as _;
    let f = fixture();
    let payload = b"tree 1234\n";
    let reply = f
        .signer
        .handle(
            Op::GitSign {
                payload_b64: base64::engine::general_purpose::STANDARD.encode(payload),
            },
            NOW,
        )
        .unwrap();
    let Output::GitSignature(signature) = reply else {
        panic!("not a git signature");
    };
    assert_eq!(signature.t, NOW);
    assert_eq!(signature.pubkey, f.agent.public_key().to_hex());
    let hash = git_sign_nostr::compute_signing_hash(NOW, signature.oa.as_ref(), payload);
    let sig =
        nostr::secp256k1::schnorr::Signature::from_slice(&hex::decode(&signature.sig).unwrap())
            .unwrap();
    let message = nostr::secp256k1::Message::from_digest(hash);
    nostr::secp256k1::SECP256K1
        .verify_schnorr(&sig, &message, &f.agent.public_key().xonly().unwrap())
        .unwrap();
}

#[test]
fn a_wrong_token_is_refused_and_a_second_listeners_too() {
    let f = fixture();
    let reply = answer(
        &f.signer,
        b"token-of-this-listener",
        Request {
            token: "token-of-another-listener".into(),
            op: Op::Pubkey,
        },
        NOW,
    );
    assert_eq!(reply, Reply::Refused("signer_token_refused".into()));
    let reply = answer(
        &f.signer,
        b"token-of-this-listener",
        Request {
            token: "token-of-this-listener".into(),
            op: Op::Pubkey,
        },
        NOW,
    );
    assert_eq!(
        reply,
        Reply::Ok(Output::Pubkey(f.agent.public_key().to_hex()))
    );
}

#[test]
fn unsigned_events_keep_their_fields_through_the_op() {
    // What the CLI backend sends: the fields of a built, unsigned event.
    let f = fixture();
    let unsigned: UnsignedEvent = EventBuilder::new(Kind::TextNote, "hello")
        .tags([Tag::parse(["h", "room"]).unwrap()])
        .build(f.agent.public_key());
    let rows = unsigned
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .collect();
    let event = signed_event(f.signer.handle(
        Op::SignEvent {
            kind: unsigned.kind.as_u16(),
            content: unsigned.content.clone(),
            tags: rows,
            created_at: None,
        },
        NOW,
    ));
    assert_eq!(event.content, "hello");
    assert!(event.tags.iter().any(|tag| tag.as_slice()[0] == "h"));
}

#[test]
fn nip98_carries_the_owner_tag_only_when_git_asks() {
    let f = fixture();
    let has_auth = |owner_tag| {
        let op = Op::Nip98 {
            url: "https://relay.example/git/o/r".into(),
            method: "GET".into(),
            payload_hash: None,
            owner_tag,
        };
        signed_event(f.signer.handle(op, NOW))
            .tags
            .iter()
            .any(|tag| tag.as_slice()[0] == "auth")
    };
    assert!(has_auth(true));
    assert!(!has_auth(false));
}

#[test]
fn the_gif_id_is_stable_and_shows_nothing_of_the_key() {
    let f = fixture();
    let first = f.signer.handle(Op::GifCustomerId, NOW).unwrap();
    assert_eq!(first, f.signer.handle(Op::GifCustomerId, NOW).unwrap());
    let Output::CustomerId(id) = first else {
        panic!("not a customer id");
    };
    assert_eq!(id.len(), 32);
}

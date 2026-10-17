//! Response bodies for `POST /requests/:id/response`. Signing happens here,
//! in the backend, with the user's key; only the signed relay request goes
//! back to the broker.

use nostr::JsonUtil;
use serde_json::{json, Value};

use super::validate::Operation;
use crate::commands::guest_access::nip98_header;

/// A signed answer plus the published event id (for the local log).
#[derive(Debug)]
pub(crate) struct SignedResponse {
    pub body: Value,
    pub event_id: Option<String>,
}

/// Decline body. `decision_source` is `prompt` or `scope:<id>`.
pub(crate) fn decline_body(decision_source: &str) -> Value {
    json!({ "declined": true, "decision_source": decision_source })
}

/// Sign the request's operation exactly as validated.
///
/// - publish: the unsigned event is signed unchanged; its id must still be
///   the expected id. The relay requires the HTTP signer to be the event
///   author, so the NIP-98 header for the relay's `/events` is signed too.
/// - query: only a NIP-98 header for the relay's `/query`, bound to the
///   exact filter body.
pub(crate) fn sign_response(
    keys: &nostr::Keys,
    operation: &Operation,
    decision_source: &str,
) -> Result<SignedResponse, String> {
    match operation {
        Operation::Publish {
            event,
            expected_event_id,
            relay_url,
            ..
        } => {
            if event.pubkey != keys.public_key() {
                return Err("signer_key_mismatch".to_string());
            }
            let signed = event
                .as_ref()
                .clone()
                .sign_with_keys(keys)
                .map_err(|e| format!("sign failed: {e}"))?;
            let event_id = signed.id.to_hex();
            if &event_id != expected_event_id {
                return Err("expected_event_id_mismatch".to_string());
            }
            let body = signed.as_json();
            let authorization = nip98_header(keys, "POST", relay_url, Some(body.as_bytes()))?;
            Ok(SignedResponse {
                body: json!({
                    "body": body,
                    "authorization": authorization,
                    "decision_source": decision_source,
                }),
                event_id: Some(event_id),
            })
        }
        Operation::Query {
            filters, relay_url, ..
        } => {
            let body = serde_json::to_string(filters).map_err(|e| e.to_string())?;
            let authorization = nip98_header(keys, "POST", relay_url, Some(body.as_bytes()))?;
            Ok(SignedResponse {
                body: json!({
                    "body": body,
                    "authorization": authorization,
                    "decision_source": decision_source,
                }),
                event_id: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use nostr::{Event, Kind, Tag, Timestamp, UnsignedEvent};
    use sha2::{Digest, Sha256};

    fn decode_auth(header: &str) -> Event {
        let json = base64::engine::general_purpose::STANDARD
            .decode(header.strip_prefix("Nostr ").unwrap())
            .unwrap();
        Event::from_json(std::str::from_utf8(&json).unwrap()).unwrap()
    }

    fn tag(event: &Event, name: &str) -> Option<String> {
        event
            .tags
            .iter()
            .find(|t| t.as_slice().first().map(String::as_str) == Some(name))
            .map(|t| t.as_slice()[1].clone())
    }

    #[test]
    fn publish_signs_the_exact_event_and_a_relay_header_over_its_bytes() {
        let keys = nostr::Keys::generate();
        let mut unsigned = UnsignedEvent::new(
            keys.public_key(),
            Timestamp::from(1_790_000_000),
            Kind::from(9),
            vec![Tag::parse(["h", "0b6c9f3e-2d3b-4b8a-9d55-0f3c1d2e3f4a"]).unwrap()],
            "hello",
        );
        let expected = unsigned.id().to_hex();
        let operation = Operation::Publish {
            event: Box::new(unsigned),
            expected_event_id: expected.clone(),
            relay_url: "https://chat.example.com/events".to_string(),
            channel_id: None,
            target_event_id: None,
            mentions: Vec::new(),
        };
        let signed = sign_response(&keys, &operation, "scope:abc").unwrap();
        assert_eq!(signed.event_id.as_deref(), Some(expected.as_str()));
        assert_eq!(signed.body["decision_source"], "scope:abc");

        let body = signed.body["body"].as_str().unwrap();
        let event = Event::from_json(body).unwrap();
        assert!(event.verify().is_ok());
        assert_eq!(event.id.to_hex(), expected);
        assert_eq!(event.created_at, Timestamp::from(1_790_000_000));
        assert_eq!(event.content, "hello");

        let auth = decode_auth(signed.body["authorization"].as_str().unwrap());
        assert!(auth.verify().is_ok());
        assert_eq!(auth.kind, Kind::HttpAuth);
        assert_eq!(auth.content, "");
        assert_eq!(auth.pubkey, keys.public_key());
        assert_eq!(
            tag(&auth, "u").as_deref(),
            Some("https://chat.example.com/events")
        );
        assert_eq!(tag(&auth, "method").as_deref(), Some("POST"));
        assert_eq!(
            tag(&auth, "payload"),
            Some(hex::encode(Sha256::digest(body.as_bytes())))
        );
    }

    #[test]
    fn a_query_header_binds_the_exact_filter_body() {
        let keys = nostr::Keys::generate();
        let filters = vec![json!({ "kinds": [9], "#h": ["x"], "limit": 50 })];
        let operation = Operation::Query {
            filters: filters.clone(),
            relay_url: "https://chat.example.com/query".to_string(),
            channel_id: None,
        };
        let signed = sign_response(&keys, &operation, "prompt").unwrap();
        assert_eq!(signed.event_id, None);
        let body = signed.body["body"].as_str().unwrap();
        let parsed: Vec<Value> = serde_json::from_str(body).unwrap();
        assert_eq!(parsed, filters);
        let auth = decode_auth(signed.body["authorization"].as_str().unwrap());
        assert_eq!(
            tag(&auth, "u").as_deref(),
            Some("https://chat.example.com/query")
        );
        assert_eq!(
            tag(&auth, "payload"),
            Some(hex::encode(Sha256::digest(body.as_bytes())))
        );
    }

    #[test]
    fn another_identity_cannot_sign_the_event() {
        let keys = nostr::Keys::generate();
        let other = nostr::Keys::generate();
        let mut unsigned = UnsignedEvent::new(
            other.public_key(),
            Timestamp::from(1_790_000_000),
            Kind::from(9),
            Vec::<Tag>::new(),
            "hello",
        );
        let operation = Operation::Publish {
            expected_event_id: unsigned.id().to_hex(),
            event: Box::new(unsigned),
            relay_url: "https://chat.example.com/events".to_string(),
            channel_id: None,
            target_event_id: None,
            mentions: Vec::new(),
        };
        assert_eq!(
            sign_response(&keys, &operation, "prompt").unwrap_err(),
            "signer_key_mismatch"
        );
    }

    #[test]
    fn declines_carry_the_decision_source() {
        assert_eq!(
            decline_body("prompt"),
            json!({ "declined": true, "decision_source": "prompt" })
        );
    }
}

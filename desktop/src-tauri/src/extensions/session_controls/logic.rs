//! Pure request fields and response checking for the session-controls
//! lookup.

use serde_json::{json, Map, Value};

pub(super) const ACTION: &str = "session_controls";
pub(super) const PATH: &str = "/session-controls";

/// Lowercase 64-hex agent key, or `None`.
pub(super) fn normalize_agent_key(value: &str) -> Option<String> {
    let key = value.trim().to_ascii_lowercase();
    (key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(key)
}

/// Body fields beyond the shared `contract_version`, `request_id` and
/// `owner_proof`.
pub(super) fn extra_fields(agent: &str) -> Map<String, Value> {
    let mut extra = Map::new();
    extra.insert("agent_public_key".into(), json!(agent));
    extra
}

/// `session_controls` from a 200 answer bound to the requested agent.
pub(super) fn parse_response(value: &Value, agent: &str) -> Result<bool, String> {
    if value.get("contract_version").and_then(Value::as_u64) != Some(1) {
        return Err("response_invalid".into());
    }
    let answered = value
        .get("agent_public_key")
        .and_then(Value::as_str)
        .and_then(normalize_agent_key);
    if answered.as_deref() != Some(agent) {
        return Err("response_agent_mismatch".into());
    }
    value
        .get("session_controls")
        .and_then(Value::as_bool)
        .ok_or_else(|| "response_invalid".into())
}

#[cfg(test)]
mod tests {
    use nostr::{Event, JsonUtil, Keys};

    use super::*;
    use crate::extensions::hosted_owner_relink::build_list_shaped_request;

    const AGENT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn request_carries_the_agent_and_a_list_shaped_proof() {
        let owner = Keys::parse(&"1".repeat(64)).expect("owner key");
        let body = build_list_shaped_request(
            &owner,
            ACTION,
            "kiingo-hosted",
            "community-1",
            "req-1",
            extra_fields(AGENT),
            1_760_000_000,
        )
        .expect("request");
        assert_eq!(body["contract_version"], json!(1));
        assert_eq!(body["request_id"], json!("req-1"));
        assert_eq!(body["agent_public_key"], json!(AGENT));
        let proof = Event::from_json(body["owner_proof"].to_string()).expect("proof event");
        proof.verify().expect("signed proof");
        assert_eq!(proof.kind.as_u16(), 27_236);
        assert_eq!(proof.content, "buzz-provider-owner-v1");
        assert_eq!(proof.pubkey, owner.public_key());
        let tags: Vec<Vec<String>> =
            serde_json::from_value(body["owner_proof"]["tags"].clone()).expect("proof tags");
        assert_eq!(
            tags,
            vec![
                vec!["action".to_string(), "session_controls".to_string()],
                vec!["provider".to_string(), "kiingo-hosted".to_string()],
                vec!["request".to_string(), "req-1".to_string()],
                vec!["community".to_string(), "community-1".to_string()],
                vec!["expires".to_string(), "1760000300".to_string()],
            ]
        );
    }

    #[test]
    fn response_is_bound_to_the_agent_and_strictly_typed() {
        let ok = |controls: Value| {
            json!({
                "contract_version": 1,
                "correlation_id": "c-1",
                "agent_public_key": AGENT.to_uppercase(),
                "session_controls": controls,
            })
        };
        assert_eq!(parse_response(&ok(json!(true)), AGENT), Ok(true));
        assert_eq!(parse_response(&ok(json!(false)), AGENT), Ok(false));
        assert!(parse_response(&ok(json!("true")), AGENT).is_err());
        assert!(parse_response(&ok(Value::Null), AGENT).is_err());
        let mut other = ok(json!(true));
        other["agent_public_key"] = json!("b".repeat(64));
        assert!(parse_response(&other, AGENT).is_err());
        let mut version = ok(json!(true));
        version["contract_version"] = json!(2);
        assert!(parse_response(&version, AGENT).is_err());
        assert!(parse_response(&Value::Null, AGENT).is_err());
    }

    #[test]
    fn agent_keys_are_validated() {
        assert_eq!(
            normalize_agent_key(&AGENT.to_uppercase()).as_deref(),
            Some(AGENT)
        );
        assert_eq!(normalize_agent_key("abc"), None);
        assert_eq!(normalize_agent_key(&"g".repeat(64)), None);
    }
}

//! Provider protocol v2 `preflight`: a read-only check, made before create,
//! of whether the owner can run an agent with this provider configuration
//! (for example, whether the owner's subscription for the chosen harness is
//! connected). It never creates or changes remote state.
//!
//! Request: `{op:"preflight", request_id, provider_config, owner_proof}`. The
//! proof is a kind-27236 event signed by the owner with content
//! `buzz-provider-preflight-v1` and exactly the tags action=preflight,
//! provider, request, community and expires (at most five minutes ahead).
//!
//! Response: `{ok:true, ready, message?, action_label?, action_url?, notice?}`.
//! Unknown fields, over-long text, and non-https action URLs are rejected so a
//! provider cannot smuggle arbitrary content into the create dialog.

use std::{path::Path, time::Duration};

use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
use serde::Serialize;

use super::backend::{invoke_provider, stage_provider, validate_provider_info};

const INFO_TIMEOUT: Duration = Duration::from_secs(10);
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(20);
const PREFLIGHT_PROOF_KIND: u16 = 27_236;
const PREFLIGHT_PROOF_CONTENT: &str = "buzz-provider-preflight-v1";
const PREFLIGHT_PROOF_TTL_SECONDS: u64 = 5 * 60;
/// Longest `message` or `notice` the desktop will show.
pub const PREFLIGHT_TEXT_MAX: usize = 300;
/// Longest `action_label` the desktop will show.
pub const PREFLIGHT_ACTION_LABEL_MAX: usize = 40;
/// Longest `action_url` the desktop will open.
pub const PREFLIGHT_ACTION_URL_MAX: usize = 2_048;

/// Owner readiness as reported by a provider that supports preflight.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreflight {
    /// False when the provider does not advertise `preflight`; nothing to check.
    pub supported: bool,
    pub ready: bool,
    pub message: Option<String>,
    pub action_label: Option<String>,
    pub action_url: Option<String>,
    pub notice: Option<String>,
}

impl ProviderPreflight {
    fn unsupported() -> Self {
        Self {
            supported: false,
            ready: true,
            message: None,
            action_label: None,
            action_url: None,
            notice: None,
        }
    }
}

/// Run preflight on one staged provider copy, or report it unsupported.
pub(crate) fn provider_preflight(
    binary: &Path,
    provider_id: &str,
    provider_config: &serde_json::Value,
    owner_keys: &Keys,
    community_id: &str,
) -> Result<ProviderPreflight, String> {
    let (_directory, staged, _digest, _execution_guard) = stage_provider(binary)?;
    let info = invoke_provider(
        &staged,
        &serde_json::json!({
            "op": "info",
            "request_id": uuid::Uuid::new_v4().to_string(),
        }),
        INFO_TIMEOUT,
    )?;
    if !validate_provider_info(&info)?.supports_preflight {
        return Ok(ProviderPreflight::unsupported());
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let owner_proof = build_preflight_owner_proof_at(
        owner_keys,
        provider_id,
        &request_id,
        community_id,
        Timestamp::now(),
    )?;
    let response = invoke_provider(
        &staged,
        &serde_json::json!({
            "op": "preflight",
            "request_id": request_id,
            "provider_config": provider_config,
            "owner_proof": owner_proof,
        }),
        PREFLIGHT_TIMEOUT,
    )?;
    parse_preflight_response(&response)
}

fn build_preflight_owner_proof_at(
    keys: &Keys,
    provider_id: &str,
    request_id: &str,
    community_id: &str,
    created_at: Timestamp,
) -> Result<serde_json::Value, String> {
    if provider_id.is_empty() || request_id.is_empty() || community_id.is_empty() {
        return Err("provider preflight proof scope is incomplete".to_string());
    }
    let expires = created_at
        .as_secs()
        .saturating_add(PREFLIGHT_PROOF_TTL_SECONDS)
        .to_string();
    let tags = [
        Tag::parse(["action", "preflight"]),
        Tag::parse(["provider", provider_id]),
        Tag::parse(["request", request_id]),
        Tag::parse(["community", community_id]),
        Tag::parse(["expires", expires.as_str()]),
    ]
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    .map_err(|_| "provider preflight proof contains an invalid scope".to_string())?;
    let event = EventBuilder::new(Kind::Custom(PREFLIGHT_PROOF_KIND), PREFLIGHT_PROOF_CONTENT)
        .tags(tags)
        .custom_created_at(created_at)
        .sign_with_keys(keys)
        .map_err(|_| "failed to sign provider preflight proof".to_string())?;
    serde_json::to_value(event).map_err(|_| "failed to encode provider preflight proof".to_string())
}

fn bounded_text(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    max: usize,
) -> Result<Option<String>, String> {
    match object.get(field) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else if trimmed.chars().count() > max || trimmed.chars().any(char::is_control) {
                Err(format!("provider preflight {field} is invalid"))
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Some(_) => Err(format!("provider preflight {field} must be a string")),
    }
}

fn parse_preflight_response(response: &serde_json::Value) -> Result<ProviderPreflight, String> {
    const FIELDS: &[&str] = &[
        "ok",
        "ready",
        "message",
        "action_label",
        "action_url",
        "notice",
    ];
    let object = response
        .as_object()
        .ok_or_else(|| "provider preflight response must be a JSON object".to_string())?;
    if let Some(field) = object.keys().find(|key| !FIELDS.contains(&key.as_str())) {
        return Err(format!(
            "provider preflight response contains unknown field {field}"
        ));
    }
    if object.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("provider preflight response must contain ok: true".to_string());
    }
    let ready = object
        .get("ready")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| "provider preflight response missing boolean ready".to_string())?;
    let action_url = bounded_text(object, "action_url", PREFLIGHT_ACTION_URL_MAX)?;
    if let Some(url) = action_url.as_deref() {
        let parsed = url::Url::parse(url)
            .map_err(|_| "provider preflight action_url is invalid".to_string())?;
        if parsed.scheme() != "https"
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("provider preflight action_url must be an https URL".to_string());
        }
    }
    let action_label = bounded_text(object, "action_label", PREFLIGHT_ACTION_LABEL_MAX)?;
    Ok(ProviderPreflight {
        supported: true,
        ready,
        message: bounded_text(object, "message", PREFLIGHT_TEXT_MAX)?,
        // A label without somewhere to go is not an action.
        action_label: action_url.as_ref().and(action_label),
        action_url,
        notice: bounded_text(object, "notice", PREFLIGHT_TEXT_MAX)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preflight_proof_has_exactly_the_scoped_tags_and_content() {
        let keys = Keys::generate();
        let created_at = Timestamp::from(1_800_000_000);
        let proof = build_preflight_owner_proof_at(
            &keys,
            "example",
            "11111111-1111-4111-8111-111111111111",
            "chat.example.com",
            created_at,
        )
        .unwrap();
        assert_eq!(proof["kind"], 27_236);
        assert_eq!(proof["content"], PREFLIGHT_PROOF_CONTENT);
        assert_eq!(proof["pubkey"], keys.public_key().to_hex());
        assert_eq!(
            proof["tags"],
            serde_json::json!([
                ["action", "preflight"],
                ["provider", "example"],
                ["request", "11111111-1111-4111-8111-111111111111"],
                ["community", "chat.example.com"],
                ["expires", "1800000300"],
            ])
        );
        assert!(
            build_preflight_owner_proof_at(&keys, "", "r", "c", created_at).is_err(),
            "incomplete scope must not be signed"
        );
    }

    #[test]
    fn preflight_response_accepts_the_documented_shape() {
        let parsed = parse_preflight_response(&serde_json::json!({
            "ok": true,
            "ready": false,
            "message": "Connect your Codex subscription, then check again.",
            "action_label": "Connect",
            "action_url": "https://example.com/connections",
            "notice": "People who message this agent use their own subscription."
        }))
        .unwrap();
        assert_eq!(
            parsed,
            ProviderPreflight {
                supported: true,
                ready: false,
                message: Some("Connect your Codex subscription, then check again.".into()),
                action_label: Some("Connect".into()),
                action_url: Some("https://example.com/connections".into()),
                notice: Some("People who message this agent use their own subscription.".into()),
            }
        );
        let minimal =
            parse_preflight_response(&serde_json::json!({"ok": true, "ready": true})).unwrap();
        assert!(minimal.ready && minimal.message.is_none() && minimal.action_url.is_none());
    }

    #[test]
    fn preflight_response_rejects_unsafe_or_unbounded_content() {
        for invalid in [
            serde_json::json!({"ok": true}),
            serde_json::json!({"ok": false, "ready": true}),
            serde_json::json!({"ok": true, "ready": "yes"}),
            serde_json::json!({"ok": true, "ready": true, "html": "<b>x</b>"}),
            serde_json::json!({"ok": true, "ready": false, "action_url": "http://example.com"}),
            serde_json::json!({"ok": true, "ready": false, "action_url": "javascript:alert(1)"}),
            serde_json::json!({"ok": true, "ready": false, "action_url": "https://u:p@example.com"}),
            serde_json::json!({"ok": true, "ready": false, "message": "x".repeat(301)}),
            serde_json::json!({"ok": true, "ready": false, "action_label": "x".repeat(41)}),
            serde_json::json!({"ok": true, "ready": false, "notice": "line\nbreak"}),
            serde_json::json!({"ok": true, "ready": false, "message": 7}),
        ] {
            assert!(parse_preflight_response(&invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn preflight_drops_an_action_label_without_a_url() {
        let parsed = parse_preflight_response(&serde_json::json!({
            "ok": true, "ready": false, "action_label": "Connect"
        }))
        .unwrap();
        assert_eq!(parsed.action_label, None);
    }

    #[cfg(unix)]
    fn write_test_provider(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::write(path, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn preflight_is_unsupported_without_the_advertised_operation() {
        let directory = tempfile::tempdir().unwrap();
        let provider = directory.path().join("provider");
        let marker = directory.path().join("preflight-ran");
        write_test_provider(
            &provider,
            &format!(
                r#"read request
case "$request" in
  *\"op\":\"info\"*) printf '%s\n' '{{"ok":true,"name":"test","version":"2.0.0","protocol_version":2,"description":"test provider","config_schema":{{}},"capabilities":{{"lifecycle_operations":["delete"]}}}}' ;;
  *) touch '{}'; printf '%s\n' '{{"ok":true,"ready":false}}' ;;
esac"#,
                marker.display()
            ),
        );
        let result = provider_preflight(
            &provider,
            "test",
            &serde_json::json!({"harness": "codex"}),
            &Keys::generate(),
            "chat.example.com",
        )
        .unwrap();
        assert_eq!(result, ProviderPreflight::unsupported());
        assert!(
            !marker.exists(),
            "preflight must not run when not advertised"
        );
    }

    #[cfg(unix)]
    #[test]
    fn preflight_sends_config_and_a_signed_proof_to_the_staged_provider() {
        let directory = tempfile::tempdir().unwrap();
        let provider = directory.path().join("provider");
        let requests = directory.path().join("requests");
        write_test_provider(
            &provider,
            &format!(
                r#"read request
printf '%s\n' "$request" >> '{}'
case "$request" in
  *\"op\":\"info\"*) printf '%s\n' '{{"ok":true,"name":"test","version":"2.1.0","protocol_version":2,"description":"test provider","config_schema":{{}},"capabilities":{{"lifecycle_operations":["delete","preflight"]}}}}' ;;
  *\"op\":\"preflight\"*) printf '%s\n' '{{"ok":true,"ready":true,"notice":"Senders use their own subscription."}}' ;;
esac"#,
                requests.display()
            ),
        );
        let keys = Keys::generate();
        let result = provider_preflight(
            &provider,
            "test",
            &serde_json::json!({"harness": "codex", "model_mode": "auto"}),
            &keys,
            "chat.example.com",
        )
        .unwrap();
        assert!(result.supported && result.ready);
        assert_eq!(
            result.notice.as_deref(),
            Some("Senders use their own subscription.")
        );
        let log = std::fs::read_to_string(requests).unwrap();
        let preflight: serde_json::Value =
            serde_json::from_str(log.lines().nth(1).unwrap()).unwrap();
        assert_eq!(preflight["op"], "preflight");
        assert_eq!(
            preflight["provider_config"],
            serde_json::json!({"harness": "codex", "model_mode": "auto"})
        );
        assert_eq!(
            preflight["owner_proof"]["pubkey"],
            keys.public_key().to_hex()
        );
        assert_eq!(
            preflight["owner_proof"]["tags"][2][1], preflight["request_id"],
            "the proof is bound to this request"
        );
    }
}

use std::{path::Path, time::Duration};

use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

use super::backend::{
    invoke_provider, stage_provider, validate_provider_info, ProviderProtocolInfo,
};

const INFO_TIMEOUT: Duration = Duration::from_secs(10);
const DELETE_TIMEOUT: Duration = Duration::from_secs(65);
const DELETE_PROOF_KIND: u16 = 27_236;
const DELETE_PROOF_CONTENT: &str = "buzz-provider-delete-v1";
const DELETE_PROOF_TTL_SECONDS: u64 = 5 * 60;

/// One immutable provider copy negotiated once and retained through deletion.
pub(crate) struct PreparedProviderDelete {
    protocol: ProviderProtocolInfo,
    _directory: tempfile::TempDir,
    staged_path: std::path::PathBuf,
    _execution_guard: std::fs::File,
}

impl PreparedProviderDelete {
    pub(crate) fn protocol_version(&self) -> u64 {
        self.protocol.version
    }

    pub(crate) fn supports_confirmed_delete(&self) -> bool {
        self.protocol.supports_confirmed_delete
    }

    pub(crate) fn confirm_delete(
        &self,
        request_id: &str,
        agent_id: &str,
        owner_proof: serde_json::Value,
    ) -> Result<(), String> {
        if !self.supports_confirmed_delete() {
            return Err("provider does not advertise confirmed delete".to_string());
        }
        let request = serde_json::json!({
            "op": "delete",
            "request_id": request_id,
            "agent_id": agent_id,
            "owner_proof": owner_proof,
        });
        let response = invoke_provider(&self.staged_path, &request, DELETE_TIMEOUT)?;
        validate_confirmed_delete_response(&response, agent_id)
    }
}

pub(crate) fn prepare_provider_delete(binary: &Path) -> Result<PreparedProviderDelete, String> {
    let (directory, staged_path, _digest, execution_guard) = stage_provider(binary)?;
    let info = invoke_provider(
        &staged_path,
        &serde_json::json!({
            "op": "info",
            "request_id": uuid::Uuid::new_v4().to_string(),
        }),
        INFO_TIMEOUT,
    )?;
    let protocol = validate_provider_info(&info)?;
    Ok(PreparedProviderDelete {
        protocol,
        _directory: directory,
        staged_path,
        _execution_guard: execution_guard,
    })
}

pub(crate) fn build_provider_delete_owner_proof(
    keys: &Keys,
    provider_id: &str,
    request_id: &str,
    agent_id: &str,
    community_id: &str,
) -> Result<serde_json::Value, String> {
    build_provider_delete_owner_proof_at(
        keys,
        provider_id,
        request_id,
        agent_id,
        community_id,
        Timestamp::now(),
    )
}

fn build_provider_delete_owner_proof_at(
    keys: &Keys,
    provider_id: &str,
    request_id: &str,
    agent_id: &str,
    community_id: &str,
    created_at: Timestamp,
) -> Result<serde_json::Value, String> {
    if provider_id.is_empty()
        || request_id.is_empty()
        || agent_id.is_empty()
        || community_id.is_empty()
    {
        return Err("provider delete proof scope is incomplete".to_string());
    }
    let expires = created_at
        .as_secs()
        .saturating_add(DELETE_PROOF_TTL_SECONDS);
    let expires_tag = expires.to_string();
    let tags = [
        Tag::parse(["action", "delete"]),
        Tag::parse(["provider", provider_id]),
        Tag::parse(["request", request_id]),
        Tag::parse(["agent", agent_id]),
        Tag::parse(["community", community_id]),
        Tag::parse(["expires", expires_tag.as_str()]),
    ]
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    .map_err(|_| "provider delete proof contains an invalid scope".to_string())?;
    let event = EventBuilder::new(Kind::Custom(DELETE_PROOF_KIND), DELETE_PROOF_CONTENT)
        .tags(tags)
        .custom_created_at(created_at)
        .sign_with_keys(keys)
        .map_err(|_| "failed to sign provider delete proof".to_string())?;
    serde_json::to_value(event).map_err(|_| "failed to encode provider delete proof".to_string())
}

pub(crate) fn community_id_from_relay(relay_url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(relay_url)
        .map_err(|_| "provider delete requires a valid community relay".to_string())?;
    if !matches!(parsed.scheme(), "ws" | "wss")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("provider delete requires a valid community relay".to_string());
    }
    parsed
        .host_str()
        .map(str::to_string)
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "provider delete requires a community relay host".to_string())
}

fn validate_confirmed_delete_response(
    response: &serde_json::Value,
    expected_agent_id: &str,
) -> Result<(), String> {
    let object = response
        .as_object()
        .ok_or_else(|| "provider delete response must be a JSON object".to_string())?;
    const FIELDS: &[&str] = &["ok", "deleted", "agent_id"];
    if object.len() != FIELDS.len()
        || object.keys().any(|field| !FIELDS.contains(&field.as_str()))
        || object.get("ok").and_then(serde_json::Value::as_bool) != Some(true)
        || object.get("deleted").and_then(serde_json::Value::as_bool) != Some(true)
        || object.get("agent_id").and_then(serde_json::Value::as_str) != Some(expected_agent_id)
    {
        return Err(
            "provider did not confirm terminal remote deletion and identity destruction"
                .to_string(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_proof_is_exact_fresh_and_signed() {
        let keys = Keys::generate();
        let proof = build_provider_delete_owner_proof_at(
            &keys,
            "example-provider",
            "11111111-1111-4111-8111-111111111111",
            "remote-1",
            "chat.example.com",
            Timestamp::from(1_787_000_000),
        )
        .expect("proof");
        assert_eq!(proof["kind"], DELETE_PROOF_KIND);
        assert_eq!(proof["content"], DELETE_PROOF_CONTENT);
        assert_eq!(proof["created_at"], 1_787_000_000_u64);
        assert_eq!(proof["pubkey"], keys.public_key().to_hex());
        assert_eq!(
            proof["tags"],
            serde_json::json!([
                ["action", "delete"],
                ["provider", "example-provider"],
                ["request", "11111111-1111-4111-8111-111111111111"],
                ["agent", "remote-1"],
                ["community", "chat.example.com"],
                ["expires", "1787000300"]
            ])
        );
        let event: nostr::Event = serde_json::from_value(proof).expect("event");
        assert!(event.verify().is_ok());
    }

    #[test]
    fn response_requires_exact_matching_terminal_confirmation() {
        assert!(validate_confirmed_delete_response(
            &serde_json::json!({"ok": true, "deleted": true, "agent_id": "remote-1"}),
            "remote-1"
        )
        .is_ok());
        for invalid in [
            serde_json::json!({"ok": true, "deleted": false, "agent_id": "remote-1"}),
            serde_json::json!({"ok": true, "deleted": true, "agent_id": "other"}),
            serde_json::json!({"ok": true, "deleted": true, "agent_id": "remote-1", "offline": true}),
        ] {
            assert!(validate_confirmed_delete_response(&invalid, "remote-1").is_err());
        }
    }

    #[test]
    fn community_scope_uses_only_a_valid_websocket_relay_host() {
        assert_eq!(
            community_id_from_relay("wss://chat.example.com").as_deref(),
            Ok("chat.example.com")
        );
        for invalid in [
            "https://chat.example.com",
            "wss://user@chat.example.com",
            "not-a-relay",
        ] {
            assert!(community_id_from_relay(invalid).is_err());
        }
    }
}

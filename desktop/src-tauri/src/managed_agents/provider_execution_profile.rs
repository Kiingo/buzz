use super::ManagedAgentRecord;

/// Remove the desktop execution projection from a provider-owned record.
/// Identity, prompt, membership, access policy, and provider configuration are
/// deliberately untouched. The operation is idempotent so legacy records can
/// be repaired during every provider deploy without a migration flag.
pub fn repair_provider_owned_record(
    record: &mut ManagedAgentRecord,
    provider_owns_execution_profile: bool,
) -> bool {
    if !provider_owns_execution_profile {
        return false;
    }

    let mut changed = false;
    macro_rules! clear_option {
        ($field:ident) => {
            if record.$field.take().is_some() {
                changed = true;
            }
        };
    }
    clear_option!(model);
    clear_option!(provider);
    clear_option!(runtime);
    clear_option!(relay_mesh);
    clear_option!(agent_command_override);
    clear_option!(effort_level);
    if !record.agent_command.is_empty() {
        record.agent_command.clear();
        changed = true;
    }
    if !record.agent_args.is_empty() {
        record.agent_args.clear();
        changed = true;
    }
    if !record.mcp_command.is_empty() {
        record.mcp_command.clear();
        changed = true;
    }
    if !record.env_vars.is_empty() {
        record.env_vars.clear();
        changed = true;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> ManagedAgentRecord {
        serde_json::from_value(serde_json::json!({
            "pubkey": "agent-key", "name": "Ada", "persona_id": "ada",
            "private_key_nsec": "nsec1fixture", "relay_url": "wss://relay.example",
            "acp_command": "buzz-acp", "agent_command": "buzz-agent",
            "agent_command_override": "buzz-agent", "agent_args": ["--local"],
            "mcp_command": "local-mcp", "turn_timeout_seconds": 0,
            "system_prompt": "preserve prompt", "model": "auto", "provider": "relay-mesh",
            "runtime": "buzz-agent", "env_vars": {"LOCAL_SECRET": "fixture"},
            "backend": {"type": "provider", "id": "remote-execution", "config": {"harness": "claude"}},
            "backend_agent_id": "hosted-id", "respond_to": "owner-only",
            "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
            "last_started_at": null, "last_stopped_at": null, "last_exit_code": null,
            "last_error": null
        }))
        .unwrap()
    }

    #[test]
    fn repair_is_idempotent_and_preserves_identity_prompt_and_hosted_state() {
        let mut record = record();
        assert!(repair_provider_owned_record(&mut record, true));
        assert!(!repair_provider_owned_record(&mut record, true));
        assert_eq!(record.pubkey, "agent-key");
        assert_eq!(record.private_key_nsec, "nsec1fixture");
        assert_eq!(record.system_prompt.as_deref(), Some("preserve prompt"));
        assert_eq!(record.backend_agent_id.as_deref(), Some("hosted-id"));
        assert!(record.runtime.is_none());
        assert!(record.model.is_none());
        assert!(record.provider.is_none());
        assert!(record.agent_command.is_empty());
        assert!(record.env_vars.is_empty());
    }

    #[test]
    fn non_owning_provider_is_unchanged() {
        let mut record = record();
        let original = record.clone();
        assert!(!repair_provider_owned_record(&mut record, false));
        assert_eq!(record, original);
    }

    #[test]
    fn definition_less_provider_owned_record_is_repaired_without_recreation() {
        let mut record = record();
        record.persona_id = None;
        let identity = record.private_key_nsec.clone();

        assert!(repair_provider_owned_record(&mut record, true));
        assert_eq!(record.private_key_nsec, identity);
        assert!(record.persona_id.is_none());
        assert!(record.provider.is_none());
        assert!(record.runtime.is_none());
    }
}

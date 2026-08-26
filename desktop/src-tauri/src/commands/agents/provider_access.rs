//! Upgrade reconciliation for provider-backed managed-agent access.

use tauri::AppHandle;

use crate::{
    app_state::AppState,
    managed_agents::{load_managed_agents, BackendKind, ManagedAgentRecord},
};

pub(super) fn needs_reconciliation_with_policy(
    record: &ManagedAgentRecord,
    owner_only_access: bool,
) -> bool {
    (owner_only_access || record.provider_policy_pending)
        && record.backend != BackendKind::Local
        && record.backend_agent_id.is_some()
}

fn collect_target_pubkeys(
    records: Vec<ManagedAgentRecord>,
    owner_only_access: bool,
) -> Vec<String> {
    records
        .into_iter()
        .filter(|record| needs_reconciliation_with_policy(record, owner_only_access))
        .map(|record| record.pubkey)
        .collect()
}

/// Redeploy existing provider agents whose access policy requires enforcement.
///
/// Owner-only builds refresh every existing deployment before each community UI
/// load. All builds also retry records whose saved policy has not yet been
/// acknowledged by a successful provider deployment. Workspace apply fails
/// closed if any selected provider rejects the current policy.
pub(crate) async fn reconcile_on_workspace_apply(
    app: &AppHandle,
    state: &AppState,
) -> Result<(), String> {
    let owner_only_access = crate::managed_agents::owner_only_access_build();
    let targets = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        collect_target_pubkeys(load_managed_agents(app)?, owner_only_access)
    };

    for pubkey in targets {
        if let Err(error) = super::deploy_to_provider(app, state, &pubkey, None, None).await {
            return Err(format!(
                "provider access reconciliation failed for agent {pubkey}: {error}"
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(backend: BackendKind, backend_agent_id: Option<&str>) -> ManagedAgentRecord {
        let mut record: ManagedAgentRecord = serde_json::from_value(serde_json::json!({
            "pubkey": "agent", "name": "Agent", "relay_url": "", "acp_command": "",
            "agent_command": "", "agent_args": [], "mcp_command": "",
            "turn_timeout_seconds": 0, "system_prompt": null, "created_at": "",
            "updated_at": "", "last_started_at": null, "last_stopped_at": null,
            "last_exit_code": null, "last_error": null
        }))
        .unwrap();
        record.backend = backend;
        record.backend_agent_id = backend_agent_id.map(str::to_string);
        record
    }

    #[test]
    fn upgrade_collects_existing_provider_and_builds_projected_payload() {
        let records = vec![
            record(
                BackendKind::Provider {
                    id: "provider".into(),
                    config: serde_json::json!({"region": "test"}),
                    owns_execution_profile: false,
                },
                Some("existing"),
            ),
            record(
                BackendKind::Provider {
                    id: "not-deployed".into(),
                    config: serde_json::json!({}),
                    owns_execution_profile: false,
                },
                None,
            ),
            record(BackendKind::Local, Some("stale")),
        ];

        let targets = collect_target_pubkeys(records, true);

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0], "agent");
    }

    #[test]
    fn unmarked_build_collects_only_pending_targets() {
        let mut pending = record(
            BackendKind::Provider {
                id: "pending-provider".into(),
                config: serde_json::json!({}),
                owns_execution_profile: false,
            },
            Some("existing-pending"),
        );
        pending.pubkey = "pending-agent".into();
        pending.provider_policy_pending = true;
        let ordinary = record(
            BackendKind::Provider {
                id: "ordinary-provider".into(),
                config: serde_json::json!({}),
                owns_execution_profile: false,
            },
            Some("existing-ordinary"),
        );

        let targets = collect_target_pubkeys(vec![ordinary, pending], false);

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0], "pending-agent");
    }

    #[test]
    fn pending_policy_requires_an_existing_provider_deployment() {
        let mut undeployed = record(
            BackendKind::Provider {
                id: "provider".into(),
                config: serde_json::json!({}),
                owns_execution_profile: false,
            },
            None,
        );
        undeployed.provider_policy_pending = true;
        let mut local = record(BackendKind::Local, Some("stale-provider-id"));
        local.provider_policy_pending = true;

        assert!(collect_target_pubkeys(vec![undeployed, local], false).is_empty());
    }
}

use crate::managed_agents::{BackendKind, ManagedAgentRecord};

use super::{
    coordinator::{CoordinatorStatus, DesktopPlan, HostedInventory, RotationItemStatus},
    journal::{IdentityRotationJournal, RotationAgentJournal, RotationMode},
};

pub(super) fn selected_records(
    plan: &DesktopPlan,
    records: &[ManagedAgentRecord],
    journal: Option<&IdentityRotationJournal>,
) -> Result<Vec<ManagedAgentRecord>, String> {
    let candidates: Vec<_> = records
        .iter()
        .filter(|record| record_is_in_plan_scope(plan, record))
        .cloned()
        .collect();
    let selected = match (&plan.mode, journal) {
        (RotationMode::Human, _) => Vec::new(),
        (_, Some(journal)) => journal
            .agents
            .iter()
            .map(|item| {
                records
                    .iter()
                    .find(|record| {
                        record.pubkey == item.old_public_key
                            || (!item.new_public_key.is_empty()
                                && record.pubkey == item.new_public_key)
                    })
                    .cloned()
                    .ok_or_else(|| "identity_rotation_local_inventory_changed".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?,
        (RotationMode::All, None) => candidates,
        (RotationMode::Agent, None) => candidates
            .into_iter()
            .filter(|record| {
                Some(record.pubkey.as_str()) == plan.selected_agent_public_key.as_deref()
            })
            .collect(),
    };
    if matches!(plan.mode, RotationMode::Agent) && selected.len() != 1 {
        return Err("identity_rotation_selected_agent_unavailable".into());
    }
    for hosted in &plan.inventory.hosted_agents {
        let lineage = journal.and_then(|value| {
            value.agents.iter().find(|item| {
                item.hosted
                    && item.old_public_key == hosted.public_key
                    && item.old_provider_agent_id.as_deref()
                        == Some(hosted.provider_agent_id.as_str())
            })
        });
        let found = selected.iter().find(|record| {
            if !matches!(&record.backend, BackendKind::Provider { .. }) {
                return false;
            }
            hosted_record_matches_inventory(
                hosted,
                lineage,
                &record.pubkey,
                record.backend_agent_id.as_deref(),
                journal.is_some_and(|value| value.committed_locally),
            )
        });
        if found.is_none() {
            return Err(if journal.is_some_and(|value| value.committed_locally) {
                "identity_rotation_postcommit_hosted_inventory_conflict"
            } else {
                "identity_rotation_hosted_inventory_conflict"
            }
            .into());
        }
    }
    Ok(selected)
}

fn hosted_record_matches_inventory(
    hosted: &HostedInventory,
    lineage: Option<&RotationAgentJournal>,
    record_public_key: &str,
    record_provider_agent_id: Option<&str>,
    committed_locally: bool,
) -> bool {
    if record_public_key == hosted.public_key {
        return record_provider_agent_id == Some(hosted.provider_agent_id.as_str());
    }
    let Some(lineage) = lineage else {
        return false;
    };
    if record_public_key != lineage.new_public_key {
        return false;
    }
    match lineage.new_provider_agent_id.as_deref() {
        Some(expected) => record_provider_agent_id == Some(expected),
        None => {
            // v0.5.18-kiingo.8 committed the provider deployment ID to the
            // managed-agent store but omitted it from the durable journal.
            // Permit only this exact post-commit lineage long enough to fetch
            // the authenticated coordinator status; reconciliation below then
            // requires the store and coordinator to agree before any canary or
            // revocation may run.
            committed_locally && record_provider_agent_id.is_some()
        }
    }
}

pub(super) fn reconcile_postcommit_provider_lineage(
    journal: &mut IdentityRotationJournal,
    records: &[ManagedAgentRecord],
    status: &CoordinatorStatus,
) -> Result<bool, String> {
    if !journal.committed_locally {
        return Ok(false);
    }
    let mut changed = false;
    for item in journal.agents.iter_mut().filter(|item| item.hosted) {
        let status_item = status
            .items
            .iter()
            .find(|candidate| candidate.old_public_key == item.old_public_key)
            .ok_or_else(|| "identity_rotation_postcommit_hosted_inventory_conflict".to_string())?;
        let replacement_public_key = status_item
            .new_public_key
            .as_deref()
            .filter(|value| *value == item.new_public_key)
            .ok_or_else(|| "identity_rotation_postcommit_hosted_inventory_conflict".to_string())?;
        let record = records
            .iter()
            .find(|record| {
                record.pubkey == replacement_public_key
                    && matches!(&record.backend, BackendKind::Provider { .. })
            })
            .ok_or_else(|| "identity_rotation_postcommit_hosted_inventory_conflict".to_string())?;
        changed |= reconcile_provider_lineage_item(
            item,
            status_item,
            &record.pubkey,
            record.backend_agent_id.as_deref(),
        )?;
    }
    Ok(changed)
}

fn reconcile_provider_lineage_item(
    item: &mut RotationAgentJournal,
    status_item: &RotationItemStatus,
    record_public_key: &str,
    record_provider_agent_id: Option<&str>,
) -> Result<bool, String> {
    let replacement_public_key = status_item
        .new_public_key
        .as_deref()
        .filter(|value| *value == item.new_public_key && *value == record_public_key)
        .ok_or_else(|| "identity_rotation_postcommit_hosted_inventory_conflict".to_string())?;
    let replacement_provider_id = status_item
        .new_provider_agent_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "identity_rotation_postcommit_hosted_inventory_conflict".to_string())?;
    if status_item.old_public_key != item.old_public_key
        || status_item.old_provider_agent_id.as_deref() != item.old_provider_agent_id.as_deref()
        || !status_item.hosted
        || record_public_key != replacement_public_key
        || record_provider_agent_id != Some(replacement_provider_id)
        || item
            .new_provider_agent_id
            .as_deref()
            .is_some_and(|value| value != replacement_provider_id)
    {
        return Err("identity_rotation_postcommit_hosted_inventory_conflict".into());
    }
    if item.new_provider_agent_id.is_some() {
        return Ok(false);
    }
    item.new_provider_agent_id = Some(replacement_provider_id.to_string());
    Ok(true)
}

fn record_is_in_plan_scope(plan: &DesktopPlan, record: &ManagedAgentRecord) -> bool {
    match &record.backend {
        BackendKind::Local => {
            record.relay_url.trim_end_matches('/') == plan.relay_url.trim_end_matches('/')
        }
        BackendKind::Provider { .. } => {
            hosted_identity_is_in_plan(plan, &record.pubkey, record.backend_agent_id.as_deref())
        }
    }
}

fn hosted_identity_is_in_plan(
    plan: &DesktopPlan,
    public_key: &str,
    provider_agent_id: Option<&str>,
) -> bool {
    plan.inventory.hosted_agents.iter().any(|hosted| {
        public_key == hosted.public_key
            && provider_agent_id == Some(hosted.provider_agent_id.as_str())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::identity_rotation::coordinator::Inventory;

    fn hosted_lineage(new_provider_agent_id: Option<&str>) -> RotationAgentJournal {
        RotationAgentJournal {
            old_public_key: "hosted-key".into(),
            new_public_key: "replacement-key".into(),
            hosted: true,
            provider_id: Some("kiingo".into()),
            old_provider_agent_id: Some("provider-agent-id".into()),
            new_provider_agent_id: new_provider_agent_id.map(str::to_string),
            profile_verified: true,
            profile_event_id: Some("profile-event".into()),
            memory_heads_migrated: 0,
            memory_tombstones_preserved: 0,
            archive_verified: false,
            archive_event_id: None,
            canary_verified: false,
            local_runtime_was_running: false,
        }
    }

    fn committed_status_item() -> RotationItemStatus {
        RotationItemStatus {
            old_public_key: "hosted-key".into(),
            new_public_key: Some("replacement-key".into()),
            hosted: true,
            old_provider_agent_id: Some("provider-agent-id".into()),
            new_provider_agent_id: Some("replacement-provider-agent-id".into()),
        }
    }

    fn plan() -> DesktopPlan {
        DesktopPlan {
            contract_version: 1,
            rotation_id: "00000000-0000-4000-8000-000000000001".into(),
            mode: RotationMode::All,
            community_id: "chat.example.com".into(),
            relay_url: "wss://chat.example.com".into(),
            old_owner_public_key: "owner".into(),
            selected_agent_public_key: None,
            challenge_expires_at: "2099-01-01T00:00:00Z".into(),
            inventory: Inventory {
                hosted_agents: vec![HostedInventory {
                    public_key: "hosted-key".into(),
                    provider_agent_id: "provider-agent-id".into(),
                }],
            },
        }
    }

    #[test]
    fn relayless_hosted_identity_is_scoped_by_exact_inventory_pair() {
        let plan = plan();
        assert!(hosted_identity_is_in_plan(
            &plan,
            "hosted-key",
            Some("provider-agent-id")
        ));
        assert!(!hosted_identity_is_in_plan(
            &plan,
            "hosted-key",
            Some("different-provider-agent-id")
        ));
        assert!(!hosted_identity_is_in_plan(
            &plan,
            "different-hosted-key",
            Some("provider-agent-id")
        ));
        assert!(!hosted_identity_is_in_plan(&plan, "hosted-key", None));
    }

    #[test]
    fn postcommit_inventory_accepts_only_exact_journaled_replacement_lineage() {
        let plan = plan();
        let hosted = &plan.inventory.hosted_agents[0];
        let missing_provider_lineage = hosted_lineage(None);
        assert!(hosted_record_matches_inventory(
            hosted,
            Some(&missing_provider_lineage),
            "replacement-key",
            Some("replacement-provider-agent-id"),
            true,
        ));
        assert!(!hosted_record_matches_inventory(
            hosted,
            Some(&missing_provider_lineage),
            "replacement-key",
            Some("replacement-provider-agent-id"),
            false,
        ));
        assert!(!hosted_record_matches_inventory(
            hosted,
            Some(&missing_provider_lineage),
            "different-replacement-key",
            Some("replacement-provider-agent-id"),
            true,
        ));

        let complete_lineage = hosted_lineage(Some("replacement-provider-agent-id"));
        assert!(hosted_record_matches_inventory(
            hosted,
            Some(&complete_lineage),
            "replacement-key",
            Some("replacement-provider-agent-id"),
            true,
        ));
        assert!(!hosted_record_matches_inventory(
            hosted,
            Some(&complete_lineage),
            "replacement-key",
            Some("different-provider-agent-id"),
            true,
        ));
    }

    #[test]
    fn postcommit_reconciliation_repairs_legacy_journal_only_after_exact_match() {
        let status = committed_status_item();
        let mut item = hosted_lineage(None);
        assert!(reconcile_provider_lineage_item(
            &mut item,
            &status,
            "replacement-key",
            Some("replacement-provider-agent-id"),
        )
        .is_ok_and(|changed| changed));
        assert_eq!(
            item.new_provider_agent_id.as_deref(),
            Some("replacement-provider-agent-id")
        );
        assert!(reconcile_provider_lineage_item(
            &mut item,
            &status,
            "replacement-key",
            Some("replacement-provider-agent-id"),
        )
        .is_ok_and(|changed| !changed));

        let mut mismatched = hosted_lineage(None);
        assert_eq!(
            reconcile_provider_lineage_item(
                &mut mismatched,
                &status,
                "replacement-key",
                Some("different-provider-agent-id"),
            )
            .expect_err("mismatched deployment must be rejected"),
            "identity_rotation_postcommit_hosted_inventory_conflict"
        );
        assert!(mismatched.new_provider_agent_id.is_none());
    }
}

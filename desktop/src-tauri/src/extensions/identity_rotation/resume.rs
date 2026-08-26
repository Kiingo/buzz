use crate::{app_state::AppState, managed_agents::ManagedAgentRecord};

use super::{
    coordinator::{resolve_plan, DesktopPlan},
    inventory::{selected_committed_records, selected_records},
    journal::IdentityRotationJournal,
    provider::RotationProvider,
};

fn requires_plan_resolution(existing: Option<&IdentityRotationJournal>) -> bool {
    !existing.is_some_and(|journal| journal.committed_locally)
}

pub(super) async fn resolve_execution_plan(
    state: &AppState,
    provider: &RotationProvider,
    rotation_id: &str,
    challenge: &str,
    existing: Option<&IdentityRotationJournal>,
) -> Result<Option<DesktopPlan>, String> {
    if !requires_plan_resolution(existing) {
        return Ok(None);
    }
    resolve_plan(state, provider, rotation_id, challenge, existing.is_some())
        .await
        .map(Some)
}

pub(super) fn expected_relay<'a>(
    plan: Option<&'a DesktopPlan>,
    existing: Option<&'a IdentityRotationJournal>,
) -> Result<&'a str, String> {
    plan.map(|value| value.relay_url.as_str())
        .or_else(|| existing.map(|journal| journal.relay_url.as_str()))
        .ok_or_else(|| "identity_rotation_resume_state_missing".to_string())
}

pub(super) fn selected_execution_records(
    plan: Option<&DesktopPlan>,
    existing: Option<&IdentityRotationJournal>,
    records: &[ManagedAgentRecord],
) -> Result<Vec<ManagedAgentRecord>, String> {
    match (plan, existing) {
        (Some(plan), journal) => selected_records(plan, records, journal),
        (None, Some(journal)) => selected_committed_records(journal, records),
        (None, None) => Err("identity_rotation_resume_state_missing".into()),
    }
}

pub(super) fn validate_provider_scope(
    journal: &IdentityRotationJournal,
    provider: &RotationProvider,
    plan: Option<&DesktopPlan>,
) -> Result<(), String> {
    if journal.coordinator_origin != provider.coordinator_origin
        || journal.provider_id != provider.provider_id
        || journal.resolve_path != provider.resolve_path
        || journal.prepare_path != provider.prepare_path
        || journal.advance_path != provider.advance_path
        || journal.proof_kind != provider.proof_kind
        || journal.proof_content != provider.proof_content
        || plan.is_some_and(|plan| journal.old_owner_public_key != plan.old_owner_public_key)
    {
        return Err("identity_rotation_resume_scope_mismatch".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::identity_rotation::{
        journal::{ContinuityJournal, RotationMode},
        provider::RotationProvider,
    };
    use std::path::PathBuf;

    fn committed_journal() -> IdentityRotationJournal {
        IdentityRotationJournal {
            contract_version: 1,
            rotation_id: "20000000-0000-4000-8000-000000000001".into(),
            coordinator_origin: "https://api.example.com".into(),
            community_id: "chat.example.com".into(),
            relay_url: "wss://chat.example.com".into(),
            mode: RotationMode::All,
            selected_agent_public_key: None,
            state: "recoverable".into(),
            state_version: 10,
            challenge_expires_at: "2026-08-21T00:00:00Z".into(),
            old_owner_public_key: "a".repeat(64),
            new_owner_public_key: Some("b".repeat(64)),
            provider_id: "test".into(),
            resolve_path: "/resolve".into(),
            prepare_path: "/prepare".into(),
            advance_path: "/advance/{rotation_id}".into(),
            proof_kind: 27_236,
            proof_content: "buzz-identity-rotation-v1".into(),
            recovery_backup_verified: true,
            agents: Vec::new(),
            continuity: ContinuityJournal::default(),
            committed_locally: true,
            old_authority_purged: false,
            error_code: None,
            created_at: "2026-08-21T00:00:00Z".into(),
            updated_at: "2026-08-21T00:00:00Z".into(),
        }
    }

    fn provider() -> RotationProvider {
        RotationProvider {
            provider_id: "test".into(),
            binary: PathBuf::from("provider"),
            coordinator_origin: "https://api.example.com".into(),
            resolve_path: "/resolve".into(),
            prepare_path: "/prepare".into(),
            advance_path: "/advance/{rotation_id}".into(),
            proof_kind: 27_236,
            proof_content: "buzz-identity-rotation-v1".into(),
        }
    }

    #[test]
    fn committed_resume_uses_journal_scope_without_a_fresh_plan() {
        let journal = committed_journal();
        assert!(!requires_plan_resolution(Some(&journal)));
        let mut precommit = journal.clone();
        precommit.committed_locally = false;
        assert!(requires_plan_resolution(Some(&precommit)));
        assert!(requires_plan_resolution(None));
        assert_eq!(
            expected_relay(None, Some(&journal)).unwrap(),
            "wss://chat.example.com"
        );
        assert!(validate_provider_scope(&journal, &provider(), None).is_ok());

        let mut changed = provider();
        changed.advance_path = "/different/{rotation_id}".into();
        assert_eq!(
            validate_provider_scope(&journal, &changed, None).unwrap_err(),
            "identity_rotation_resume_scope_mismatch"
        );
    }
}

use crate::managed_agents::ManagedAgentRecord;

/// Project a remote provider's two-axis lifecycle into the legacy control
/// status consumed by the desktop. The accepted desired state drives which
/// action the user can take immediately; observed state can legitimately lag
/// while the provider reconciles and remains available separately for health
/// display and diagnostics.
pub(super) fn provider_control_status(record: &ManagedAgentRecord) -> String {
    if record.backend_agent_id.is_none() {
        return "not_deployed".to_string();
    }

    if let Some(provider_state) = &record.provider_lifecycle_state {
        return match provider_state.desired_state.as_str() {
            "paused" => "paused".to_string(),
            "deleted" => "not_deployed".to_string(),
            _ => "deployed".to_string(),
        };
    }

    let paused = record.last_stopped_at.as_deref().is_some_and(|stopped| {
        record
            .last_started_at
            .as_deref()
            .is_none_or(|started| stopped > started)
    });
    if paused {
        "paused".to_string()
    } else {
        "deployed".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::provider_control_status;
    use crate::managed_agents::{ProviderLifecycleState, RespondTo};

    #[test]
    fn uses_accepted_desired_state_while_observed_state_lags() {
        let mut record =
            super::super::test_fixtures::fixture(RespondTo::OwnerOnly, vec![], Some("tag".into()));
        record.backend_agent_id = Some("provider-agent".into());
        record.provider_lifecycle_state = Some(ProviderLifecycleState {
            desired_state: "paused".into(),
            observed_state: "updating".into(),
            last_reconciled_at: None,
            last_ready_at: None,
            error_code: None,
            correlation_id: "correlation".into(),
        });

        assert_eq!(provider_control_status(&record), "paused");

        let state = record
            .provider_lifecycle_state
            .as_mut()
            .expect("provider lifecycle state");
        state.desired_state = "active".into();
        state.observed_state = "paused".into();

        assert_eq!(provider_control_status(&record), "deployed");
    }
}

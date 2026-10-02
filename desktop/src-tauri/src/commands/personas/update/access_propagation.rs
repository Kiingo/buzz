//! Carry a definition's access edit ("who can send instructions") to the
//! deployed instances that still follow it.
//!
//! A definition's access is the default an instance is minted with, so an
//! instance that never had its access set on its own keeps carrying the
//! definition's previous access. Editing the definition without updating those
//! instances leaves the running agent silently on the old gate. Instances
//! whose access was changed individually keep it, the same rule the display
//! name rename follows.
//!
//! Each instance goes through `update_managed_agent`, so the change crosses the
//! instance boundary every other access edit uses: stop the running gate,
//! persist, publish the policy, restart.

use std::collections::BTreeSet;

use tauri::{AppHandle, Manager};

use crate::{
    app_state::AppState,
    managed_agents::{
        validate_respond_to_allowlist, AgentDefinition, ManagedAgentRecord, RespondTo,
        UpdateManagedAgentRequest,
    },
};

/// A mode plus the allowlist that only matters in allowlist mode.
pub(super) type Access = (RespondTo, Vec<String>);

/// The access a definition hands a newly minted instance (see
/// `resolve_mint_behavioral_defaults`). `None` when the stored definition
/// access is unreadable; nothing is propagated from or to such a state.
pub(super) fn definition_access(definition: &AgentDefinition) -> Option<Access> {
    let mode = match definition.respond_to.as_deref() {
        Some(wire) => RespondTo::parse_wire(wire).ok()?,
        None => RespondTo::default(),
    };
    let allowlist = if mode == RespondTo::Allowlist {
        validate_respond_to_allowlist(&definition.respond_to_allowlist).ok()?
    } else {
        Vec::new()
    };
    Some((mode, allowlist))
}

fn same_access(a: &Access, b: &Access) -> bool {
    if a.0 != b.0 {
        return false;
    }
    if a.0 != RespondTo::Allowlist {
        return true;
    }
    let set = |list: &[String]| {
        list.iter()
            .map(|pubkey| pubkey.trim().to_ascii_lowercase())
            .collect::<BTreeSet<_>>()
    };
    set(&a.1) == set(&b.1)
}

/// Linked instances (pubkey, name) that still carry `previous` and so follow
/// the definition to `next`.
pub(super) fn instances_following_access(
    records: &[ManagedAgentRecord],
    persona_id: &str,
    previous: &Access,
    next: &Access,
) -> Vec<(String, String)> {
    if same_access(previous, next) {
        return Vec::new();
    }
    records
        .iter()
        .filter(|record| !record.pubkey.is_empty())
        .filter(|record| record.persona_id.as_deref() == Some(persona_id))
        .filter(|record| {
            let current = (record.respond_to, record.respond_to_allowlist.clone());
            same_access(&current, previous)
        })
        .map(|record| (record.pubkey.clone(), record.name.clone()))
        .collect()
}

pub(super) fn access_update_request(pubkey: &str, next: &Access) -> UpdateManagedAgentRequest {
    UpdateManagedAgentRequest {
        pubkey: pubkey.to_string(),
        respond_to: Some(next.0),
        respond_to_allowlist: (next.0 == RespondTo::Allowlist).then(|| next.1.clone()),
        ..Default::default()
    }
}

/// Apply `next` to each following instance through the instance update
/// command. Every instance is attempted; failures are reported together.
pub(super) async fn apply_access_to_instances(
    app: &AppHandle,
    definition_name: &str,
    instances: Vec<(String, String)>,
    next: &Access,
) -> Result<(), String> {
    let mut failures = Vec::new();
    for (pubkey, name) in instances {
        let request = access_update_request(&pubkey, next);
        match crate::commands::update_managed_agent(request, app.clone(), app.state::<AppState>())
            .await
        {
            Ok(response) => {
                if let Some(error) = response.profile_sync_error {
                    eprintln!(
                        "buzz-desktop: access for {name} saved after editing {definition_name}; {error}"
                    );
                }
            }
            Err(error) => failures.push(format!("{name}: {error}")),
        }
    }
    if failures.is_empty() {
        return Ok(());
    }
    Err(format!(
        "{definition_name} was saved, but its new access could not be applied to {}. Edit access from the agent's profile to retry. {}",
        if failures.len() == 1 {
            "one of its agents".to_string()
        } else {
            format!("{} of its agents", failures.len())
        },
        failures.join("; ")
    ))
}

#[cfg(test)]
#[path = "access_propagation_tests.rs"]
mod tests;

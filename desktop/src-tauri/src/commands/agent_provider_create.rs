//! Create-flow support for remote provider backends: an owner readiness
//! preflight before create, and a rollback that never leaves a half-created
//! remote agent behind after a failed start.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{
    app_state::AppState,
    managed_agents::{
        load_managed_agents,
        provider_delete::community_id_from_relay,
        provider_preflight::{provider_preflight, ProviderPreflight},
        resolve_provider_binary, validate_provider_config, BackendKind,
    },
    relay::relay_ws_url_with_override,
};

/// Ask a provider whether the current owner can create an agent with this
/// configuration. Providers that do not advertise `preflight` report
/// `supported: false`, and the create flow treats them as ready.
#[tauri::command]
pub async fn check_backend_provider_preflight(
    provider_id: String,
    provider_config: serde_json::Value,
    app: AppHandle,
) -> Result<ProviderPreflight, String> {
    validate_provider_config(&provider_config)?;
    let binary = resolve_provider_binary(&provider_id)?;
    let (owner_keys, community_id) = {
        let state = app.state::<AppState>();
        let keys = state.signing_keys()?;
        let community_id = community_id_from_relay(&relay_ws_url_with_override(&state))?;
        (keys, community_id)
    };
    tokio::task::spawn_blocking(move || {
        provider_preflight(
            &binary,
            &provider_id,
            &provider_config,
            &owner_keys,
            &community_id,
        )
    })
    .await
    .map_err(|error| format!("spawn_blocking failed: {error}"))?
}

/// Result of undoing a provider-backed create that did not start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ProviderCreateRollback {
    /// Nothing from this create remains, locally or remotely.
    Removed,
    /// The local record and key were kept because remote removal could not be
    /// confirmed. Running the rollback again is safe.
    Kept { reason: String },
}

/// How the rollback should proceed for the record as it is now.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RollbackPlan {
    /// The record is already gone; a previous rollback finished.
    AlreadyRemoved,
    /// The provider returned an agent id, so confirmed delete can remove it.
    DeleteKnownRemote,
    /// The deploy outcome is unknown: replay the identical idempotent deploy
    /// to learn the agent id (or the provider's word that none exists).
    ReplayDeployThenDelete,
}

fn rollback_plan(record: Option<(&BackendKind, Option<&str>)>) -> Result<RollbackPlan, String> {
    match record {
        None => Ok(RollbackPlan::AlreadyRemoved),
        Some((BackendKind::Local, _)) => {
            Err("only provider-backed creates can be rolled back here".to_string())
        }
        Some((BackendKind::Provider { .. }, Some(agent_id))) if !agent_id.trim().is_empty() => {
            Ok(RollbackPlan::DeleteKnownRemote)
        }
        Some((BackendKind::Provider { .. }, _)) => Ok(RollbackPlan::ReplayDeployThenDelete),
    }
}

/// What a replayed deploy tells the rollback to do next.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ReplayStep {
    /// The replay returned the agent id; delete it through the provider.
    DeleteRemote,
    /// The provider asserted no remote agent exists; local cleanup is enough.
    DeleteLocalOnly,
    /// Remote state is still unknown; keep everything so a retry can finish.
    Keep(String),
}

fn replay_step(result: Result<(), crate::managed_agents::ProviderDeployFailure>) -> ReplayStep {
    match result {
        Ok(()) => ReplayStep::DeleteRemote,
        Err(failure) if failure.remote_absent => ReplayStep::DeleteLocalOnly,
        Err(failure) => ReplayStep::Keep(failure.message),
    }
}

/// Undo a provider-backed create whose start failed. Idempotent: an already
/// removed agent reports `Removed`, and a `Kept` result can be retried.
///
/// Never treats local cleanup as proof the remote agent is gone. The local
/// record (and the agent key a replay needs) is removed only after the
/// provider confirmed deletion, or asserted that no remote agent exists.
#[tauri::command]
pub async fn rollback_failed_provider_create(
    pubkey: String,
    app: AppHandle,
) -> Result<ProviderCreateRollback, String> {
    let plan = {
        let state = app.state::<AppState>();
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        let records = load_managed_agents(&app)?;
        let record = records.iter().find(|record| record.pubkey == pubkey);
        rollback_plan(record.map(|record| (&record.backend, record.backend_agent_id.as_deref())))?
    };
    match plan {
        RollbackPlan::AlreadyRemoved => return Ok(ProviderCreateRollback::Removed),
        RollbackPlan::DeleteKnownRemote => {}
        RollbackPlan::ReplayDeployThenDelete => {
            let replay = {
                let state = app.state::<AppState>();
                super::agents::deploy_to_provider_reporting(&app, &state, &pubkey, None, None, None)
                    .await
            };
            if let ReplayStep::Keep(reason) = replay_step(replay) {
                return Ok(ProviderCreateRollback::Kept {
                    reason: format!("could not confirm whether the remote agent exists: {reason}"),
                });
            }
            // DeleteRemote: the record now carries the agent id. DeleteLocalOnly:
            // it still has none, so the delete below stays local.
        }
    }
    match super::agents::delete_managed_agent(pubkey, Some(false), app).await {
        Ok(()) => Ok(ProviderCreateRollback::Removed),
        Err(reason) => Ok(ProviderCreateRollback::Kept { reason }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managed_agents::ProviderDeployFailure;

    fn provider() -> BackendKind {
        BackendKind::Provider {
            id: "example".to_string(),
            config: serde_json::json!({}),
        }
    }

    #[test]
    fn rollback_plan_deletes_known_remotes_and_replays_unknown_outcomes() {
        let backend = provider();
        assert_eq!(rollback_plan(None), Ok(RollbackPlan::AlreadyRemoved));
        assert_eq!(
            rollback_plan(Some((&backend, Some("remote-1")))),
            Ok(RollbackPlan::DeleteKnownRemote)
        );
        assert_eq!(
            rollback_plan(Some((&backend, None))),
            Ok(RollbackPlan::ReplayDeployThenDelete)
        );
        assert_eq!(
            rollback_plan(Some((&backend, Some("  ")))),
            Ok(RollbackPlan::ReplayDeployThenDelete)
        );
        assert!(rollback_plan(Some((&BackendKind::Local, None))).is_err());
    }

    #[test]
    fn replay_keeps_everything_unless_the_provider_answered() {
        assert_eq!(replay_step(Ok(())), ReplayStep::DeleteRemote);
        assert_eq!(
            replay_step(Err(ProviderDeployFailure {
                message: "rejected".to_string(),
                remote_absent: true,
            })),
            ReplayStep::DeleteLocalOnly
        );
        assert_eq!(
            replay_step(Err(ProviderDeployFailure {
                message: "provider timed out after 600s".to_string(),
                remote_absent: false,
            })),
            ReplayStep::Keep("provider timed out after 600s".to_string())
        );
        // A local failure before the provider answers is never proof of absence.
        assert_eq!(
            replay_step(Err(ProviderDeployFailure::from(
                "agent changed while deploying".to_string()
            ))),
            ReplayStep::Keep("agent changed while deploying".to_string())
        );
    }

    #[test]
    fn rollback_result_serializes_with_a_status_tag() {
        assert_eq!(
            serde_json::to_value(ProviderCreateRollback::Removed).unwrap(),
            serde_json::json!({"status": "removed"})
        );
        assert_eq!(
            serde_json::to_value(ProviderCreateRollback::Kept {
                reason: "x".to_string()
            })
            .unwrap(),
            serde_json::json!({"status": "kept", "reason": "x"})
        );
    }
}

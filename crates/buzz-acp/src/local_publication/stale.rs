//! A definitive stale refusal plus exact-ID absence permits API-owned refreeze.
use std::time::Duration;

use nostr::Event;
use serde::Deserialize;

use super::{LocalPublicationIntent, LocalPublicationWorker, RELAY_TIMESTAMP_TOLERANCE_SECS};
use crate::relay::RelayError;

const STALE_REASON: &str = "invalid: event timestamp too far from server time";

pub(super) fn is_stale_rejection(error: &RelayError, event: &Event, now: u64) -> bool {
    let RelayError::Http(message) = error else {
        return false;
    };
    let Some(body) = message.strip_prefix("POST /events returned HTTP 400 Bad Request: ") else {
        return false;
    };
    now.saturating_sub(event.created_at.as_secs()) > RELAY_TIMESTAMP_TOLERANCE_SECS
        && serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(|reason| reason.as_str())
                    .map(str::to_owned)
            })
            .is_some_and(|reason| reason == STALE_REASON)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StaleRecovery {
    refreshed: bool,
    parked: bool,
}

impl LocalPublicationWorker {
    pub(super) async fn retire_stale_event(
        &self,
        intent: &LocalPublicationIntent,
        event: &Event,
    ) -> Result<(), String> {
        // Called only after exact signed submission was definitively rejected
        // and a successful verified lookup found that exact ID absent.
        // Never sign a fresh replacement locally or assert delivery success.
        let mut response = self
            .rest
            .http
            .post(format!(
                "{}/api/buzz-bridge/publications/{}/failure",
                self.completion_api_base_url, intent.fence_id
            ))
            .bearer_auth(&self.internal_token)
            .timeout(Duration::from_secs(5))
            .json(&serde_json::json!({
                "fence_id": intent.fence_id,
                "receipt_id": intent.receipt_id,
                "community_id": intent.community_id,
                "agent_public_key": intent.agent_public_key,
                "failure_code": "relay_timestamp_rejected",
                "frozen_event_id": event.id.to_hex(),
                "frozen_event_created_at": event.created_at.as_secs(),
                "relay_rejection": STALE_REASON,
            }))
            .send()
            .await
            .map_err(|_| "publication stale retirement outcome unavailable".to_string())?
            .error_for_status()
            .map_err(|_| "publication stale retirement not confirmed".to_string())?;
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "publication stale retirement response unavailable".to_string())?
        {
            if body.len() + chunk.len() > 1024 {
                return Err("publication stale retirement response exceeds limit".into());
            }
            body.extend_from_slice(&chunk);
        }
        let outcome: StaleRecovery = serde_json::from_slice(&body)
            .map_err(|_| "publication stale retirement response invalid".to_string())?;
        if outcome.refreshed == outcome.parked {
            return Err("publication stale retirement not confirmed".into());
        }
        tracing::warn!(
            target: "buzz::local_publication",
            receipt_id = %intent.receipt_id, fence_id = %intent.fence_id,
            retired_event_id = %event.id, parked = outcome.parked,
            "stale frozen event retired or parked by durable publication owner"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests;

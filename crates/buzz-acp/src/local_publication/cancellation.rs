//! Non-chat Stop control delivery. The API persists explicit-user authority;
//! the relay verifies it and serializes it against publication. Native workers
//! carry the exact saved token, never infer Stop from operational observations.

use super::*;
use buzz_core::managed_publication::{Authorization, Operation, ScopeKind};
use nostr::{Kind, Tag};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeCancellationIntent {
    cancellation_id: String,
    community_id: String,
    agent_public_key: String,
    scope_kind: ScopeKind,
    scope_id: String,
    channel_id: String,
    runtime_authorization: String,
    event_created_at: u64,
}

impl LocalPublicationWorker {
    pub(super) async fn deliver_runtime_cancellations(
        &self,
        body: &serde_json::Value,
    ) -> Result<(), String> {
        let values = body
            .get("cancellations")
            .and_then(serde_json::Value::as_array)
            .filter(|values| values.len() <= RECOVERY_BATCH_CAPACITY)
            .ok_or("runtime cancellation recovery batch invalid")?;
        // Validate the entire bounded batch before any transport mutation.
        let prepared = values
            .iter()
            .map(|value| {
                let intent: RuntimeCancellationIntent = serde_json::from_value(value.clone())
                    .map_err(|_| "runtime cancellation intent invalid".to_string())?;
                let event = self.build_runtime_cancellation(&intent)?;
                Ok((intent, event))
            })
            .collect::<Result<Vec<_>, String>>()?;
        for (intent, event) in prepared {
            if let Err(error) = self.deliver_runtime_cancellation(&intent, &event).await {
                tracing::warn!(target: "buzz::local_publication", cancellation_id = %intent.cancellation_id,
                    error = %error, "user Stop remains pending; durable control will recover");
            }
        }
        Ok(())
    }

    fn build_runtime_cancellation(
        &self,
        intent: &RuntimeCancellationIntent,
    ) -> Result<nostr::Event, String> {
        let authorization = Authorization::decode(&intent.runtime_authorization)?;
        let claims = &authorization.claims;
        if !Uuid::parse_str(&intent.cancellation_id)
            .is_ok_and(|id| id.to_string() == intent.cancellation_id)
            || intent.community_id != self.community_id
            || claims.issuer != self.community_id
            || intent.agent_public_key != self.rest.keys.public_key().to_hex()
            || claims.scope_kind != intent.scope_kind
            || claims.scope_id != intent.scope_id
            || claims.channel_id != intent.channel_id
            || !matches!(claims.action, Operation::Cancel { .. })
            || intent.event_created_at == 0
            || intent.event_created_at > i64::MAX as u64
        {
            return Err("runtime cancellation scope mismatch".into());
        }
        let tags = [
            Tag::parse(["h", &intent.channel_id]),
            Tag::parse(["d", &format!("buzz-user-cancellation:{}", intent.scope_id)]),
        ]
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "runtime cancellation routing invalid".to_string())?;
        sign_publication_event(
            EventBuilder::new(
                Kind::Custom(buzz_core::kind::KIND_AGENT_CANCELLATION as u16),
                &intent.runtime_authorization,
            )
            .tags(tags),
            &self.rest.keys,
            intent.event_created_at,
        )
    }

    async fn deliver_runtime_cancellation(
        &self,
        intent: &RuntimeCancellationIntent,
        event: &nostr::Event,
    ) -> Result<(), String> {
        // Controls are not ordinary retained events, so recovery resubmits the
        // same idempotent scope control without a chat lookup or deletion.
        tokio::time::timeout(Duration::from_secs(5), self.rest.submit_event(event))
            .await
            .map_err(|_| "runtime cancellation relay timeout".to_string())?
            .map_err(|error| format!("runtime cancellation relay rejected: {error}"))?;
        self.rest.http.post(format!("{}/api/buzz-bridge/cancellations/{}/complete",
            self.completion_api_base_url, intent.cancellation_id))
            .bearer_auth(&self.internal_token).timeout(Duration::from_secs(5))
            .json(&serde_json::json!({ "community_id": self.community_id,
                "agent_public_key": self.rest.keys.public_key().to_hex(), "buzz_event_id": event.id.to_hex() }))
            .send().await.map_err(|error| format!("runtime cancellation completion unavailable: {error}"))?
            .error_for_status().map_err(|error| format!("runtime cancellation completion rejected: {error}"))?;
        Ok(())
    }
}

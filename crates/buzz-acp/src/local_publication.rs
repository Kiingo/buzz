//! Optional local publication boundary for ACP adapters.
//!
//! The remote compute process never receives the Buzz agent's private key.
//! Instead, an adapter emits a structured ACP update after it has acquired a
//! server-side publication fence. `buzz-acp` validates that update, signs the
//! message locally, submits it through the normal relay REST path, and reports
//! the resulting Nostr event id to the configured completion endpoint.

use std::time::Duration;

use nostr::{Alphabet, Filter, Kind, SingleLetterTag};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::relay::RestClient;

const COMPLETE_TIMEOUT: Duration = Duration::from_secs(5);
const RELAY_LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);
const COMPLETE_RETRY_DELAYS: [Duration; 4] = [
    Duration::from_millis(100),
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_secs(1),
];
const PUBLISH_RETRY_DELAYS: [Duration; 9] = [
    Duration::from_millis(100),
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(15),
    Duration::from_secs(30),
];
const PUBLISH_RETRY_MAX_ELAPSED: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LocalPublicationIntent {
    #[serde(rename = "sessionUpdate")]
    pub session_update: String,
    pub community_id: String,
    pub agent_public_key: String,
    pub receipt_id: String,
    pub fence_id: String,
    pub channel_id: String,
    pub thread_root_event_id: Option<String>,
    pub reply_to_event_id: String,
    pub publication_kind: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalPublicationPublisher {
    rest: RestClient,
    completion_api_base_url: String,
    internal_token: String,
}

impl LocalPublicationPublisher {
    pub(crate) fn from_env(rest: RestClient) -> Option<Self> {
        if !matches!(
            std::env::var("BUZZ_ACP_LOCAL_PUBLICATION_ENABLED")
                .ok()
                .as_deref(),
            Some("1" | "true" | "TRUE")
        ) {
            return None;
        }
        let completion_api_base_url = std::env::var("BUZZ_ACP_PUBLICATION_API_BASE_URL")
            .ok()?
            .trim()
            .trim_end_matches('/')
            .to_string();
        if !(completion_api_base_url.starts_with("https://")
            || completion_api_base_url.starts_with("http://127.0.0.1")
            || completion_api_base_url.starts_with("http://localhost"))
        {
            tracing::error!(
                target: "buzz::local_publication",
                "BUZZ_ACP_PUBLICATION_API_BASE_URL must use HTTPS (loopback HTTP is allowed for tests)"
            );
            return None;
        }
        let internal_token = std::env::var("BUZZ_ACP_PUBLICATION_TOKEN").ok()?;
        if internal_token.trim().is_empty() {
            return None;
        }
        Some(Self {
            rest,
            completion_api_base_url,
            internal_token,
        })
    }

    pub(crate) fn enqueue(&self, intent: LocalPublicationIntent) {
        if let Err(error) = validate_intent(&intent, &self.rest) {
            tracing::error!(
                target: "buzz::local_publication",
                receipt_id = %intent.receipt_id,
                fence_id = %intent.fence_id,
                publication_kind = %intent.publication_kind,
                error = %error,
                "rejected invalid local Buzz publication"
            );
            return;
        }
        let publisher = self.clone();
        tokio::spawn(async move {
            let started_at = tokio::time::Instant::now();
            let mut attempt = 1usize;
            loop {
                match publisher.publish(&intent).await {
                    Ok(()) => return,
                    Err(error) => {
                        let delay = publication_retry_delay(attempt);
                        if started_at.elapsed().saturating_add(delay) > PUBLISH_RETRY_MAX_ELAPSED {
                            tracing::error!(
                                target: "buzz::local_publication",
                                receipt_id = %intent.receipt_id,
                                fence_id = %intent.fence_id,
                                publication_kind = %intent.publication_kind,
                                attempt,
                                error = %error,
                                "local Buzz publication exhausted its relay-recovery window"
                            );
                            return;
                        }
                        tracing::warn!(
                            target: "buzz::local_publication",
                            receipt_id = %intent.receipt_id,
                            fence_id = %intent.fence_id,
                            publication_kind = %intent.publication_kind,
                            attempt,
                            retry_delay_ms = delay.as_millis(),
                            error = %error,
                            "local Buzz publication will retry after a transient boundary failure"
                        );
                        tokio::time::sleep(delay).await;
                        attempt = attempt.saturating_add(1);
                    }
                }
            }
        });
    }

    async fn publish(&self, intent: &LocalPublicationIntent) -> Result<(), String> {
        validate_intent(intent, &self.rest)?;
        let fence_tag_value = format!("buzz-local-publication:{}", intent.fence_id);
        if let Some(event_id) = self.find_existing_event(&fence_tag_value).await? {
            self.complete_fence(intent, &event_id).await?;
            tracing::info!(
                target: "buzz::local_publication",
                receipt_id = %intent.receipt_id,
                fence_id = %intent.fence_id,
                buzz_event_id = %event_id,
                "reconciled an already-published Buzz event"
            );
            return Ok(());
        }

        let channel_id = Uuid::parse_str(&intent.channel_id)
            .map_err(|_| "publication channel_id is not a UUID".to_string())?;
        let root_hex = intent
            .thread_root_event_id
            .as_deref()
            .unwrap_or(&intent.reply_to_event_id);
        let root = nostr::EventId::from_hex(root_hex)
            .map_err(|_| "publication thread root event id is invalid".to_string())?;
        let thread_ref = buzz_sdk::ThreadRef {
            root_event_id: root,
            // Adapter-authored replies remain flat under the root.
            parent_event_id: root,
        };
        let builder = buzz_sdk::build_message_with_extra_tags(
            channel_id,
            &intent.content,
            Some(&thread_ref),
            &[],
            false,
            &[],
            &[vec!["d".to_string(), fence_tag_value]],
        )
        .map_err(|error| format!("publication build failed: {error}"))?;
        let event = builder
            .sign_with_keys(&self.rest.keys)
            .map_err(|error| format!("publication signing failed: {error}"))?;
        let event_id = event.id.to_hex();
        tokio::time::timeout(Duration::from_secs(5), self.rest.submit_event(&event))
            .await
            .map_err(|_| "publication relay submission timed out".to_string())?
            .map_err(|error| format!("publication relay submission failed: {error}"))?;
        self.complete_fence(intent, &event_id).await?;
        tracing::info!(
            target: "buzz::local_publication",
            receipt_id = %intent.receipt_id,
            fence_id = %intent.fence_id,
            publication_kind = %intent.publication_kind,
            buzz_event_id = %event_id,
            "published locally signed adapter output"
        );
        Ok(())
    }

    async fn find_existing_event(&self, fence_tag_value: &str) -> Result<Option<String>, String> {
        let filter = Filter::new()
            .kind(Kind::Custom(9))
            .author(self.rest.keys.public_key())
            .custom_tags(SingleLetterTag::lowercase(Alphabet::D), [fence_tag_value])
            .limit(1);
        let response = tokio::time::timeout(RELAY_LOOKUP_TIMEOUT, self.rest.query(&[filter]))
            .await
            .map_err(|_| "publication reconciliation query timed out".to_string())?
            .map_err(|error| format!("publication reconciliation query failed: {error}"))?;
        Ok(response
            .as_array()
            .and_then(|events| events.first())
            .and_then(|event| event.get("id"))
            .and_then(|id| id.as_str())
            .map(str::to_string))
    }

    async fn complete_fence(
        &self,
        intent: &LocalPublicationIntent,
        event_id: &str,
    ) -> Result<(), String> {
        let url = format!(
            "{}/api/buzz-bridge/publications/{}/complete",
            self.completion_api_base_url, intent.fence_id
        );
        let body = serde_json::json!({
            "receipt_id": intent.receipt_id,
            "community_id": intent.community_id,
            "agent_public_key": intent.agent_public_key,
            "buzz_event_id": event_id,
        });
        let mut last_error = "publication fence completion failed".to_string();
        for attempt in 0..=COMPLETE_RETRY_DELAYS.len() {
            let result = tokio::time::timeout(
                COMPLETE_TIMEOUT,
                self.rest
                    .http
                    .post(&url)
                    .bearer_auth(&self.internal_token)
                    .json(&body)
                    .send(),
            )
            .await;
            match result {
                Ok(Ok(response)) if response.status().is_success() => return Ok(()),
                Ok(Ok(response)) => {
                    last_error = format!(
                        "publication fence completion returned HTTP {}",
                        response.status().as_u16()
                    );
                }
                Ok(Err(error)) => {
                    last_error = format!("publication fence completion failed: {error}")
                }
                Err(_) => last_error = "publication fence completion timed out".to_string(),
            }
            if let Some(delay) = COMPLETE_RETRY_DELAYS.get(attempt) {
                tokio::time::sleep(*delay).await;
            }
        }
        Err(last_error)
    }
}

fn publication_retry_delay(attempt: usize) -> Duration {
    PUBLISH_RETRY_DELAYS
        .get(attempt.saturating_sub(1))
        .copied()
        .unwrap_or(PUBLISH_RETRY_DELAYS[PUBLISH_RETRY_DELAYS.len() - 1])
}

fn validate_intent(intent: &LocalPublicationIntent, rest: &RestClient) -> Result<(), String> {
    if intent.session_update != "buzz_local_publication" {
        return Err("publication ACP update discriminator is invalid".to_string());
    }
    let agent_public_key = intent.agent_public_key.trim().to_ascii_lowercase();
    if agent_public_key != rest.keys.public_key().to_hex() {
        return Err("publication agent key does not match the local signer".to_string());
    }
    if intent.community_id.trim().is_empty()
        || intent.receipt_id.trim().is_empty()
        || intent.fence_id.trim().is_empty()
        || intent.reply_to_event_id.len() != 64
        || !intent
            .reply_to_event_id
            .chars()
            .all(|character| character.is_ascii_hexdigit())
        || intent.content.trim().is_empty()
        || intent.content.len() > 64 * 1024
    {
        return Err("publication intent failed local validation".to_string());
    }
    if !matches!(
        intent.publication_kind.as_str(),
        "receipt" | "progress" | "capacity" | "final" | "error" | "cancelled" | "action"
    ) {
        return Err("publication kind is not allowed".to_string());
    }
    if let Some(root) = intent.thread_root_event_id.as_deref() {
        if root.len() != 64 || !root.chars().all(|character| character.is_ascii_hexdigit()) {
            return Err("publication thread root event id is invalid".to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    fn rest(keys: Keys) -> RestClient {
        RestClient {
            http: reqwest::Client::new(),
            base_url: "http://127.0.0.1:3000".to_string(),
            keys,
            auth_tag_json: None,
        }
    }

    fn intent(agent_public_key: String) -> LocalPublicationIntent {
        LocalPublicationIntent {
            session_update: "buzz_local_publication".to_string(),
            community_id: "example-community".to_string(),
            agent_public_key,
            receipt_id: Uuid::new_v4().to_string(),
            fence_id: Uuid::new_v4().to_string(),
            channel_id: Uuid::new_v4().to_string(),
            thread_root_event_id: None,
            reply_to_event_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_string(),
            publication_kind: "final".to_string(),
            content: "Done".to_string(),
        }
    }

    #[test]
    fn accepts_intent_only_for_the_local_signer() {
        let keys = Keys::generate();
        let rest = rest(keys.clone());
        assert!(validate_intent(&intent(keys.public_key().to_hex()), &rest).is_ok());
        let other = Keys::generate();
        assert!(validate_intent(&intent(other.public_key().to_hex()), &rest).is_err());
    }

    #[test]
    fn rejects_unknown_publication_fields_and_kinds() {
        let keys = Keys::generate();
        let mut value = serde_json::to_value(intent(keys.public_key().to_hex())).unwrap();
        value["private_key"] = serde_json::json!("must-not-cross-boundary");
        assert!(serde_json::from_value::<LocalPublicationIntent>(value).is_err());

        let mut invalid = intent(keys.public_key().to_hex());
        invalid.publication_kind = "arbitrary_write".to_string();
        assert!(validate_intent(&invalid, &rest(keys)).is_err());
    }

    #[test]
    fn accepts_scoped_action_publications_claimed_by_the_bridge() {
        let keys = Keys::generate();
        let rest = rest(keys.clone());
        let mut action = intent(keys.public_key().to_hex());
        action.publication_kind = "action".to_string();

        assert!(validate_intent(&action, &rest).is_ok());
    }

    #[test]
    fn publication_retry_backoff_is_fast_then_bounded() {
        assert_eq!(publication_retry_delay(1), Duration::from_millis(100));
        assert_eq!(publication_retry_delay(4), Duration::from_secs(1));
        assert_eq!(publication_retry_delay(9), Duration::from_secs(30));
        assert_eq!(publication_retry_delay(10_000), Duration::from_secs(30));
    }
}

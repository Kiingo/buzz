//! Optional local publication boundary for ACP adapters.
//!
//! The remote compute process never receives the Buzz agent's private key.
//! Instead, an adapter emits a structured ACP update after it has acquired a
//! server-side publication fence. `buzz-acp` validates that update, signs the
//! message locally, submits it through the normal relay REST path, and reports
//! the resulting Nostr event id to the configured completion endpoint.

use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use nostr::{Alphabet, EventBuilder, Filter, Kind, SingleLetterTag, Tag, Timestamp};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
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
    #[serde(default)]
    pub status_surface_fence_id: Option<String>,
    pub channel_id: String,
    pub thread_root_event_id: Option<String>,
    pub reply_to_event_id: String,
    pub publication_kind: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalPublicationPublisher {
    worker: Arc<LocalPublicationWorker>,
    queue: mpsc::UnboundedSender<LocalPublicationIntent>,
}

#[derive(Debug)]
struct LocalPublicationWorker {
    rest: RestClient,
    completion_api_base_url: String,
    internal_token: String,
    last_status_edit_created_at: AtomicU64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalPublicationMode {
    Create,
    EditStatusSurface,
    DeleteStatusSurfaceThenCreate,
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
        let worker = Arc::new(LocalPublicationWorker {
            rest,
            completion_api_base_url,
            internal_token,
            last_status_edit_created_at: AtomicU64::new(0),
        });
        let (queue, mut receiver) = mpsc::unbounded_channel();
        let queued_worker = Arc::clone(&worker);
        tokio::spawn(async move {
            while let Some(intent) = receiver.recv().await {
                queued_worker.publish_with_retry(intent).await;
            }
        });
        Some(Self { worker, queue })
    }

    pub(crate) fn enqueue(&self, intent: LocalPublicationIntent) {
        if let Err(error) = validate_intent(&intent, &self.worker.rest) {
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
        if self.queue.send(intent).is_err() {
            tracing::error!(
                target: "buzz::local_publication",
                "local Buzz publication queue is unavailable"
            );
        }
    }
}

impl LocalPublicationWorker {
    async fn publish_with_retry(&self, intent: LocalPublicationIntent) {
        let started_at = tokio::time::Instant::now();
        let mut attempt = 1usize;
        loop {
            match self.publish(&intent).await {
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
    }

    async fn publish(&self, intent: &LocalPublicationIntent) -> Result<(), String> {
        validate_intent(intent, &self.rest)?;
        match publication_mode(intent) {
            LocalPublicationMode::EditStatusSurface => {
                let status_surface_fence_id = intent
                    .status_surface_fence_id
                    .as_deref()
                    .ok_or_else(|| "status edit is missing its target fence".to_string())?;
                self.publish_status_edit(intent, status_surface_fence_id)
                    .await
            }
            LocalPublicationMode::DeleteStatusSurfaceThenCreate => {
                let status_surface_fence_id =
                    intent.status_surface_fence_id.as_deref().ok_or_else(|| {
                        "terminal publication is missing its target fence".to_string()
                    })?;
                self.publish_terminal(intent, status_surface_fence_id).await
            }
            LocalPublicationMode::Create => self.publish_message(intent).await,
        }
    }

    async fn publish_message(&self, intent: &LocalPublicationIntent) -> Result<(), String> {
        let fence_tag_value = format!("buzz-local-publication:{}", intent.fence_id);
        if let Some(event) = self.find_existing_event(9, &fence_tag_value).await? {
            let event_id = event_id(&event)?;
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
        let event_id = self.submit_builder(builder).await?;
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

    async fn publish_status_edit(
        &self,
        intent: &LocalPublicationIntent,
        status_surface_fence_id: &str,
    ) -> Result<(), String> {
        let fence_tag_value = format!("buzz-local-publication:{}", intent.fence_id);
        if let Some(event) = self.find_existing_event(40003, &fence_tag_value).await? {
            let event_id = event_id(&event)?;
            self.complete_fence(intent, &event_id).await?;
            return Ok(());
        }
        let target_event_id = self
            .find_status_surface_event_id(status_surface_fence_id)
            .await?
            .ok_or_else(|| "status surface is not visible on the relay yet".to_string())?;
        let channel_id = Uuid::parse_str(&intent.channel_id)
            .map_err(|_| "publication channel_id is not a UUID".to_string())?;
        let builder = build_status_mutation(
            40003,
            channel_id,
            &target_event_id,
            &intent.content,
            &fence_tag_value,
        )?
        .custom_created_at(self.next_status_edit_created_at());
        let event_id = self.submit_builder(builder).await?;
        self.complete_fence(intent, &event_id).await?;
        tracing::info!(
            target: "buzz::local_publication",
            receipt_id = %intent.receipt_id,
            fence_id = %intent.fence_id,
            publication_kind = %intent.publication_kind,
            buzz_event_id = %event_id,
            "edited the locally signed Buzz progress surface"
        );
        Ok(())
    }

    async fn publish_terminal(
        &self,
        intent: &LocalPublicationIntent,
        status_surface_fence_id: &str,
    ) -> Result<(), String> {
        self.delete_status_surface(intent, status_surface_fence_id)
            .await?;
        self.publish_message(intent).await
    }

    async fn delete_status_surface(
        &self,
        intent: &LocalPublicationIntent,
        status_surface_fence_id: &str,
    ) -> Result<(), String> {
        let delete_tag_value = format!("buzz-local-publication:{}:status-delete", intent.fence_id);
        if self
            .find_existing_event(5, &delete_tag_value)
            .await?
            .is_some()
        {
            return Ok(());
        }
        let target_event_id = self
            .find_status_surface_event_id(status_surface_fence_id)
            .await?
            .ok_or_else(|| "status surface is not visible on the relay yet".to_string())?;
        let channel_id = Uuid::parse_str(&intent.channel_id)
            .map_err(|_| "publication channel_id is not a UUID".to_string())?;
        let builder =
            build_status_mutation(5, channel_id, &target_event_id, "", &delete_tag_value)?;
        let delete_event_id = self.submit_builder(builder).await?;
        tracing::info!(
            target: "buzz::local_publication",
            receipt_id = %intent.receipt_id,
            fence_id = %intent.fence_id,
            buzz_event_id = %delete_event_id,
            "deleted the completed Buzz progress surface"
        );
        Ok(())
    }

    async fn find_status_surface_event_id(
        &self,
        status_surface_fence_id: &str,
    ) -> Result<Option<String>, String> {
        let status_tag_value = format!("buzz-local-publication:{status_surface_fence_id}");
        self.find_existing_event(9, &status_tag_value)
            .await?
            .map(|event| event_id(&event))
            .transpose()
    }

    async fn submit_builder(&self, builder: EventBuilder) -> Result<String, String> {
        let event = builder
            .sign_with_keys(&self.rest.keys)
            .map_err(|error| format!("publication signing failed: {error}"))?;
        let event_id = event.id.to_hex();
        tokio::time::timeout(Duration::from_secs(5), self.rest.submit_event(&event))
            .await
            .map_err(|_| "publication relay submission timed out".to_string())?
            .map_err(|error| format!("publication relay submission failed: {error}"))?;
        Ok(event_id)
    }

    fn next_status_edit_created_at(&self) -> Timestamp {
        let now = Timestamp::now().as_secs();
        let created_at = self
            .last_status_edit_created_at
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |previous| {
                Some(monotonic_status_edit_created_at(now, previous))
            })
            .map_or(now, |previous| {
                monotonic_status_edit_created_at(now, previous)
            });
        Timestamp::from(created_at)
    }

    async fn find_existing_event(
        &self,
        kind: u16,
        fence_tag_value: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        let filter = Filter::new()
            .kind(Kind::Custom(kind))
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
            .cloned())
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

fn event_id(event: &serde_json::Value) -> Result<String, String> {
    event
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| {
            value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
        })
        .map(str::to_string)
        .ok_or_else(|| "publication reconciliation returned an invalid event id".to_string())
}

fn publication_tag(parts: &[&str]) -> Result<Tag, String> {
    Tag::parse(parts.iter().copied())
        .map_err(|error| format!("publication tag build failed: {error}"))
}

fn build_status_mutation(
    kind: u16,
    channel_id: Uuid,
    target_event_id: &str,
    content: &str,
    fence_tag_value: &str,
) -> Result<EventBuilder, String> {
    if !matches!(kind, 5 | 40003) {
        return Err("status mutation kind is not allowed".to_string());
    }
    if kind == 40003 && content.trim().is_empty() {
        return Err("status edit content is empty".to_string());
    }
    let target = nostr::EventId::from_hex(target_event_id)
        .map_err(|_| "status mutation target event id is invalid".to_string())?;
    let channel = channel_id.to_string();
    let target = target.to_hex();
    let tags = vec![
        publication_tag(&["h", &channel])?,
        publication_tag(&["e", &target])?,
        publication_tag(&["d", fence_tag_value])?,
    ];
    Ok(EventBuilder::new(Kind::Custom(kind), content).tags(tags))
}

fn monotonic_status_edit_created_at(now: u64, previous: u64) -> u64 {
    now.max(previous.saturating_add(1))
}

fn publication_mode(intent: &LocalPublicationIntent) -> LocalPublicationMode {
    match (
        intent.publication_kind.as_str(),
        intent.status_surface_fence_id.as_deref(),
    ) {
        ("progress" | "capacity", Some(_)) => LocalPublicationMode::EditStatusSurface,
        ("final" | "error" | "cancelled", Some(_)) => {
            LocalPublicationMode::DeleteStatusSurfaceThenCreate
        }
        _ => LocalPublicationMode::Create,
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
        || intent
            .status_surface_fence_id
            .as_deref()
            .is_some_and(|fence_id| fence_id.trim().is_empty() || fence_id.len() > 256)
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
            status_surface_fence_id: None,
            channel_id: Uuid::new_v4().to_string(),
            thread_root_event_id: None,
            reply_to_event_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_string(),
            publication_kind: "final".to_string(),
            content: "Done".to_string(),
        }
    }

    fn has_tag(event: &nostr::Event, key: &str, value: &str) -> bool {
        event.tags.iter().any(|tag| {
            let parts = tag.as_slice();
            parts.first().map(String::as_str) == Some(key)
                && parts.get(1).map(String::as_str) == Some(value)
        })
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
    fn accepts_legacy_intents_without_a_status_surface() {
        let keys = Keys::generate();
        let mut value = serde_json::to_value(intent(keys.public_key().to_hex())).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .remove("status_surface_fence_id");

        let parsed = serde_json::from_value::<LocalPublicationIntent>(value).unwrap();
        assert!(parsed.status_surface_fence_id.is_none());
        assert_eq!(publication_mode(&parsed), LocalPublicationMode::Create);
    }

    #[test]
    fn routes_progress_to_edit_and_terminal_output_to_delete_then_create() {
        let keys = Keys::generate();
        let mut progress = intent(keys.public_key().to_hex());
        progress.publication_kind = "progress".to_string();
        progress.status_surface_fence_id = Some(Uuid::new_v4().to_string());
        assert_eq!(
            publication_mode(&progress),
            LocalPublicationMode::EditStatusSurface
        );

        progress.publication_kind = "final".to_string();
        assert_eq!(
            publication_mode(&progress),
            LocalPublicationMode::DeleteStatusSurfaceThenCreate
        );

        progress.publication_kind = "action".to_string();
        assert_eq!(publication_mode(&progress), LocalPublicationMode::Create);
    }

    #[test]
    fn builds_scoped_idempotent_status_edits_and_deletes() {
        let keys = Keys::generate();
        let channel_id = Uuid::new_v4();
        let target = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let edit_tag = "buzz-local-publication:edit-fence";
        let edit = build_status_mutation(40003, channel_id, target, "Working...", edit_tag)
            .unwrap()
            .sign_with_keys(&keys)
            .unwrap();
        assert_eq!(edit.kind.as_u16(), 40003);
        assert_eq!(edit.content, "Working...");
        assert!(has_tag(&edit, "h", &channel_id.to_string()));
        assert!(has_tag(&edit, "e", target));
        assert!(has_tag(&edit, "d", edit_tag));

        let delete_tag = "buzz-local-publication:terminal-fence:status-delete";
        let delete = build_status_mutation(5, channel_id, target, "", delete_tag)
            .unwrap()
            .sign_with_keys(&keys)
            .unwrap();
        assert_eq!(delete.kind.as_u16(), 5);
        assert!(delete.content.is_empty());
        assert!(has_tag(&delete, "h", &channel_id.to_string()));
        assert!(has_tag(&delete, "e", target));
        assert!(has_tag(&delete, "d", delete_tag));
    }

    #[test]
    fn rejects_invalid_status_surface_targets_and_mutation_kinds() {
        let keys = Keys::generate();
        let rest = rest(keys.clone());
        let mut invalid = intent(keys.public_key().to_hex());
        invalid.status_surface_fence_id = Some("   ".to_string());
        assert!(validate_intent(&invalid, &rest).is_err());
        assert!(build_status_mutation(
            9,
            Uuid::new_v4(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "message",
            "fence"
        )
        .is_err());
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

    #[test]
    fn status_edit_timestamps_are_strictly_monotonic_within_one_second() {
        assert_eq!(monotonic_status_edit_created_at(1_000, 0), 1_000);
        assert_eq!(monotonic_status_edit_created_at(1_000, 1_000), 1_001);
        assert_eq!(monotonic_status_edit_created_at(1_000, 1_001), 1_002);
        assert_eq!(monotonic_status_edit_created_at(1_005, 1_002), 1_005);
    }
}

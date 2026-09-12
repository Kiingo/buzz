//! Optional local publication boundary for ACP adapters.
//!
//! The remote compute process never receives the Buzz agent's private key.
//! Instead, an adapter emits a structured ACP update after it has acquired a
//! server-side publication fence. `buzz-acp` validates that update, signs the
//! message locally, submits it through the normal relay REST path, and reports
//! the resulting Nostr event id to the configured completion endpoint.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use nostr::{Alphabet, EventBuilder, Filter, SingleLetterTag};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::relay::RestClient;

mod cancellation;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicationAuthorization {
    should_publish: bool,
    runtime_authorization: Option<String>,
}

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
// A short delivery batch yields capacity to other receipts. The server outbox
// retains unfinished output and recovers it again; this is never an expiry.
const PUBLISH_RETRY_MAX_ELAPSED: Duration = Duration::from_secs(30);
const RECOVERY_POLL_INTERVAL: Duration = Duration::from_secs(5);
const STATUS_PUBLISH_RETRY_MAX_ELAPSED: Duration = Duration::from_secs(15);
const STATUS_PUBLISH_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(10);
const TERMINAL_RECEIPT_RETENTION: Duration = Duration::from_secs(5 * 60);
const PUBLICATION_QUEUE_CAPACITY: usize = 64;
const RECOVERY_BATCH_CAPACITY: usize = 4;
const LIVE_QUEUE_CAPACITY: usize = PUBLICATION_QUEUE_CAPACITY - RECOVERY_BATCH_CAPACITY;
const TERMINAL_RECEIPT_CACHE_CAPACITY: usize = 128;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LocalPublicationIntent {
    #[serde(rename = "sessionUpdate")]
    pub session_update: String,
    pub community_id: String,
    pub agent_public_key: String,
    pub receipt_id: String,
    pub fence_id: String,
    pub event_created_at: u64,
    pub channel_id: String,
    pub thread_root_event_id: Option<String>,
    pub reply_to_event_id: String,
    pub publication_kind: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalPublicationPublisher {
    worker: Arc<LocalPublicationWorker>,
    queue: mpsc::Sender<LocalPublicationIntent>,
}

static PROCESS_PUBLISHER: OnceLock<LocalPublicationPublisher> = OnceLock::new();

pub(crate) fn ensure_started(rest: RestClient) {
    let _ = LocalPublicationPublisher::from_env(rest);
}

#[derive(Debug)]
struct LocalPublicationWorker {
    rest: RestClient,
    community_id: String,
    completion_api_base_url: String,
    internal_token: String,
}

#[derive(Debug, Default)]
struct LocalPublicationQueueState {
    pending: VecDeque<LocalPublicationIntent>,
    // This is only a bounded cache. The durable API decides delivery eligibility.
    terminal_receipts: HashMap<String, Instant>,
}

impl LocalPublicationQueueState {
    fn accept(&mut self, intent: LocalPublicationIntent) {
        self.prune_terminal_receipts();
        if self
            .pending
            .iter()
            .any(|pending| pending.fence_id == intent.fence_id)
        {
            return;
        }
        if is_terminal_publication(&intent) {
            let receipt_id = intent.receipt_id.clone();
            self.remember_terminal(&receipt_id);
            self.pending.retain(|pending| {
                pending.receipt_id != receipt_id || !is_status_publication(pending)
            });
            if self.pending.len() >= PUBLICATION_QUEUE_CAPACITY {
                return;
            }
            // A batch may already contain this answer's admitted actions.
            // Preserve that dependency even before an action is in flight.
            let position = if intent.publication_kind == "final" {
                self.pending
                    .iter()
                    .rposition(|pending| {
                        pending.receipt_id == receipt_id && pending.publication_kind == "action"
                    })
                    .map_or(0, |position| position + 1)
            } else {
                0
            };
            self.pending.insert(position, intent);
            return;
        }

        if is_status_publication(&intent) {
            if self.terminal_receipts.contains_key(&intent.receipt_id) {
                return;
            }
            if let Some(position) = self.pending.iter().position(|pending| {
                pending.receipt_id == intent.receipt_id && is_status_publication(pending)
            }) {
                self.pending.remove(position);
                self.pending.insert(position, intent);
                return;
            }
        }

        if self.pending.len() < PUBLICATION_QUEUE_CAPACITY {
            self.pending.push_back(intent);
        }
    }

    fn should_preempt(
        &self,
        current: &LocalPublicationIntent,
        incoming: &LocalPublicationIntent,
    ) -> bool {
        if incoming.fence_id == current.fence_id {
            return false;
        }
        // Yield the current delivery batch so a same-receipt cancellation
        // observation can surface promptly. This is not cancellation authority:
        // the saved output remains in the outbox and must pass the API gate
        // again before any later delivery attempt.
        if incoming.publication_kind == "cancelled"
            && current.receipt_id == incoming.receipt_id
            && current.publication_kind != "cancelled"
        {
            return true;
        }
        if is_terminal_publication(incoming) && !is_terminal_publication(current) {
            // An approval/action for this turn must remain visible before its
            // answer. Operational status has no dependency on a chat surface.
            return !(incoming.publication_kind == "final"
                && current.publication_kind == "action"
                && current.receipt_id == incoming.receipt_id);
        }
        is_status_publication(current)
            && is_status_publication(incoming)
            && current.receipt_id == incoming.receipt_id
    }

    fn requeue_preempted(&mut self, intent: LocalPublicationIntent) {
        // Omitted operational observations remain in the durable outbox. Never
        // complete their fences using another observation's event identity.
        if !is_status_publication(&intent)
            && self.pending.len() < PUBLICATION_QUEUE_CAPACITY
            && !self
                .pending
                .iter()
                .any(|pending| pending.fence_id == intent.fence_id)
        {
            // Keep the observation that preempted us ahead of this retry.
            // Calling accept(final) here would jump ahead of cancellation again.
            self.pending.push_back(intent);
        }
    }

    fn take_next(&mut self) -> Option<LocalPublicationIntent> {
        self.pending.pop_front()
    }

    fn remember_terminal(&mut self, receipt_id: &str) {
        if self.terminal_receipts.len() >= TERMINAL_RECEIPT_CACHE_CAPACITY
            && !self.terminal_receipts.contains_key(receipt_id)
        {
            let oldest = self
                .terminal_receipts
                .iter()
                .min_by_key(|(_, at)| *at)
                .map(|(id, _)| id.clone());
            if let Some(oldest) = oldest {
                self.terminal_receipts.remove(&oldest);
            }
        }
        self.terminal_receipts
            .insert(receipt_id.to_owned(), Instant::now());
    }

    fn prune_terminal_receipts(&mut self) {
        self.terminal_receipts
            .retain(|_, updated_at| updated_at.elapsed() < TERMINAL_RECEIPT_RETENTION);
    }
}

impl LocalPublicationPublisher {
    pub(crate) fn from_env(rest: RestClient) -> Option<Self> {
        if let Some(publisher) = PROCESS_PUBLISHER.get() {
            return Some(publisher.clone());
        }
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
        let community_id = std::env::var("BUZZ_COMMUNITY_ID")
            .ok()
            .filter(|value| !value.trim().is_empty())?;
        let publisher = Self::start(rest, community_id, completion_api_base_url, internal_token);
        Some(PROCESS_PUBLISHER.get_or_init(|| publisher).clone())
    }

    fn start(
        rest: RestClient,
        community_id: String,
        completion_api_base_url: String,
        internal_token: String,
    ) -> Self {
        let worker = Arc::new(LocalPublicationWorker {
            rest,
            community_id,
            completion_api_base_url,
            internal_token,
        });
        let (queue, mut receiver) = mpsc::channel(PUBLICATION_QUEUE_CAPACITY);
        let queued_worker = Arc::clone(&worker);
        tokio::spawn(async move {
            queued_worker.run(&mut receiver).await;
        });
        Self { worker, queue }
    }

    pub(crate) fn enqueue(&self, intent: LocalPublicationIntent) {
        if let Err(error) = self.worker.validate_scoped_intent(&intent) {
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
        if self.queue.try_send(intent).is_err() {
            tracing::warn!(
                target: "buzz::local_publication",
                "local publication queue is busy; saved output remains in the durable outbox"
            );
        }
    }
}

impl LocalPublicationWorker {
    fn validate_scoped_intent(&self, intent: &LocalPublicationIntent) -> Result<(), String> {
        validate_intent(intent, &self.rest)?;
        if intent.community_id != self.community_id {
            return Err("publication community mismatch".into());
        }
        Ok(())
    }

    async fn run(self: Arc<Self>, receiver: &mut mpsc::Receiver<LocalPublicationIntent>) {
        let mut state = LocalPublicationQueueState::default();
        let mut input_open = true;
        let mut next_recovery = tokio::time::Instant::now() + RECOVERY_POLL_INTERVAL;
        loop {
            // Bound draining even when coalescing a continuous status stream.
            for _ in 0..PUBLICATION_QUEUE_CAPACITY {
                if state.pending.len() >= LIVE_QUEUE_CAPACITY {
                    break;
                }
                match receiver.try_recv() {
                    Ok(intent) => state.accept(intent),
                    Err(_) => break,
                }
            }
            if tokio::time::Instant::now() >= next_recovery {
                match self.recover_saved_publications().await {
                    Ok(intents) => {
                        for intent in intents {
                            state.accept(intent);
                        }
                    }
                    Err(error) => tracing::warn!(target: "buzz::local_publication", error = %error,
                        "durable publication recovery temporarily unavailable"),
                }
                next_recovery = tokio::time::Instant::now() + RECOVERY_POLL_INTERVAL;
            }

            let Some(intent) = state.take_next() else {
                if !input_open {
                    return;
                }
                tokio::select! {
                    incoming = receiver.recv() => match incoming {
                        Some(intent) => state.accept(intent),
                        None => input_open = false,
                    },
                    _ = tokio::time::sleep_until(next_recovery) => {},
                }
                continue;
            };

            let mut preempted = false;
            let mut received_while_publishing = 0usize;
            let mut publication = Box::pin(self.publish_with_retry(&intent));
            loop {
                tokio::select! {
                    biased;
                    incoming = receiver.recv(), if input_open && state.pending.len() < LIVE_QUEUE_CAPACITY && received_while_publishing < PUBLICATION_QUEUE_CAPACITY => {
                        match incoming {
                            Some(incoming) => {
                                received_while_publishing += 1;
                                if incoming.fence_id == intent.fence_id {
                                    continue;
                                }
                                let should_preempt = state.should_preempt(&intent, &incoming);
                                state.accept(incoming);
                                if should_preempt {
                                    preempted = true;
                                    break;
                                }
                            }
                            None => input_open = false,
                        }
                    }
                    _ = &mut publication => {
                        break;
                    }
                    _ = tokio::time::sleep_until(next_recovery) => {
                        // Give durable user controls a turn even during a slow
                        // publication batch. Saved output is reauthorized later.
                        preempted = true;
                        break;
                    }
                }
            }
            drop(publication);

            if preempted {
                tracing::debug!(
                    target: "buzz::local_publication",
                    receipt_id = %intent.receipt_id,
                    fence_id = %intent.fence_id,
                    publication_kind = %intent.publication_kind,
                    "preempted a local Buzz publication for newer or terminal output"
                );
                state.requeue_preempted(intent);
                continue;
            }
        }
    }

    async fn publish_with_retry(&self, intent: &LocalPublicationIntent) -> Option<String> {
        let started_at = tokio::time::Instant::now();
        let mut attempt = 1usize;
        loop {
            let result = if is_status_publication(intent) {
                tokio::time::timeout(STATUS_PUBLISH_ATTEMPT_TIMEOUT, self.publish(intent))
                    .await
                    .map_err(|_| "status publication attempt timed out".to_string())
                    .and_then(|result| result)
            } else {
                self.publish(intent).await
            };
            match result {
                Ok(event_id) => return event_id,
                Err(error) => {
                    let delay = publication_retry_delay(attempt);
                    if started_at.elapsed().saturating_add(delay)
                        > publication_retry_max_elapsed(intent)
                    {
                        tracing::error!(
                            target: "buzz::local_publication",
                            receipt_id = %intent.receipt_id,
                            fence_id = %intent.fence_id,
                            publication_kind = %intent.publication_kind,
                            attempt,
                            error = %error,
                            "local publication batch deferred; saved output remains recoverable in the durable outbox"
                        );
                        return None;
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

    async fn publish(&self, intent: &LocalPublicationIntent) -> Result<Option<String>, String> {
        self.validate_scoped_intent(intent)?;
        let authorization = self.authorize(intent).await?;
        if !authorization.should_publish {
            return Ok(None);
        }
        self.publish_message(intent, authorization.runtime_authorization.as_deref())
            .await
            .map(Some)
    }

    async fn authorize(
        &self,
        intent: &LocalPublicationIntent,
    ) -> Result<PublicationAuthorization, String> {
        let response = self
            .rest
            .http
            .post(format!(
                "{}/api/buzz-bridge/publications/{}/authorize",
                self.completion_api_base_url, intent.fence_id
            ))
            .bearer_auth(&self.internal_token)
            .timeout(Duration::from_secs(5))
            .json(intent)
            .send()
            .await
            .map_err(|error| format!("publication eligibility unavailable: {error}"))?
            .error_for_status()
            .map_err(|error| format!("publication eligibility rejected: {error}"))?;
        response
            .json::<PublicationAuthorization>()
            .await
            .map_err(|error| format!("publication authorization response invalid: {error}"))
    }

    async fn recover_saved_publications(&self) -> Result<Vec<LocalPublicationIntent>, String> {
        let url = format!(
            "{}/api/buzz-bridge/publications/recover",
            self.completion_api_base_url
        );
        let response = self
            .rest
            .http
            .post(url)
            .bearer_auth(&self.internal_token)
            .timeout(Duration::from_secs(10))
            .json(&serde_json::json!({
                "community_id": self.community_id,
                "agent_public_key": self.rest.keys.public_key().to_hex(),
            }))
            .send()
            .await
            .map_err(|error| format!("publication recovery failed: {error}"))?
            .error_for_status()
            .map_err(|error| format!("publication recovery rejected: {error}"))?;
        let body = response
            .json::<serde_json::Value>()
            .await
            .map_err(|error| format!("publication recovery response invalid: {error}"))?;
        self.deliver_runtime_cancellations(&body).await?;
        self.parse_recovered_publications(body)
    }

    fn parse_recovered_publications(
        &self,
        body: serde_json::Value,
    ) -> Result<Vec<LocalPublicationIntent>, String> {
        let values = body
            .get("publications")
            .and_then(serde_json::Value::as_array)
            .filter(|values| values.len() <= RECOVERY_BATCH_CAPACITY)
            .ok_or("publication recovery batch invalid")?;
        values
            .iter()
            .map(|value| {
                let intent: LocalPublicationIntent = serde_json::from_value(value.clone())
                    .map_err(|error| format!("saved publication invalid: {error}"))?;
                self.validate_scoped_intent(&intent)?;
                Ok(intent)
            })
            .collect()
    }

    async fn publish_message(
        &self,
        intent: &LocalPublicationIntent,
        runtime_authorization: Option<&str>,
    ) -> Result<String, String> {
        use buzz_core::managed_publication::{Authorization, Operation, AUTHORIZATION_TAG};
        let authority = if publication_event_kind(intent) == 9 {
            let encoded =
                runtime_authorization.ok_or("publication runtime authorization missing")?;
            let authorization = Authorization::decode(encoded)?;
            if authorization.claims.issuer != self.community_id
                || !matches!(&authorization.claims.action, Operation::Publish { receipt_id, .. } if receipt_id == &intent.receipt_id)
            {
                return Err("publication runtime authorization scope mismatch".into());
            }
            Some(authorization)
        } else {
            if runtime_authorization.is_some() {
                return Err("operational status cannot carry runtime authority".into());
            }
            None
        };
        let fence_tag_value = format!("buzz-local-publication:{}", intent.fence_id);
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
        let builder = if publication_event_kind(intent) == 9 {
            buzz_sdk::build_message_with_extra_tags(
                channel_id,
                &intent.content,
                Some(&thread_ref),
                &[],
                false,
                &[],
                &[
                    vec!["d".to_string(), fence_tag_value.clone()],
                    vec![
                        AUTHORIZATION_TAG.to_string(),
                        runtime_authorization
                            .ok_or("publication runtime authorization missing")?
                            .to_string(),
                    ],
                ],
            )
            .map_err(|error| format!("publication build failed: {error}"))?
        } else {
            use buzz_core::agent_status::{AgentStatus, AgentStatusState};
            let state = match intent.publication_kind.as_str() {
                "receipt" => AgentStatusState::Receipt,
                "progress" => AgentStatusState::Progress,
                "capacity" => AgentStatusState::Capacity,
                "error" => AgentStatusState::Error,
                "cancelled" => AgentStatusState::Cancelled,
                _ => return Err("invalid operational status kind".into()),
            };
            buzz_sdk::agent_status::build_agent_status(
                channel_id,
                root,
                &fence_tag_value,
                &AgentStatus {
                    version: 1,
                    receipt_id: intent.receipt_id.clone(),
                    state,
                    text: intent.content.clone(),
                },
            )?
        };
        let event = sign_publication_event(builder, &self.rest.keys, intent.event_created_at)?;
        if let Some(authorization) = authority {
            // This is a binding check, not issuer authentication. The relay
            // verifies its trusted runtime key and atomically fences Stop.
            authorization.claims.check_event(&event)?;
        }
        let event_id = event.id.to_hex();
        let already_published = self
            .find_existing_event(&event, &intent.channel_id, &fence_tag_value)
            .await?;
        if !already_published {
            tokio::time::timeout(Duration::from_secs(5), self.rest.submit_event(&event))
                .await
                .map_err(|_| "publication relay submission timed out".to_string())?
                .map_err(|error| format!("publication relay submission failed: {error}"))?;
        }
        self.complete_fence(intent, &event_id).await?;
        tracing::info!(
            target: "buzz::local_publication",
            receipt_id = %intent.receipt_id,
            fence_id = %intent.fence_id,
            publication_kind = %intent.publication_kind,
            buzz_event_id = %event_id,
            already_published,
            "published locally signed adapter output"
        );
        Ok(event_id)
    }

    async fn find_existing_event(
        &self,
        expected: &nostr::Event,
        channel_id: &str,
        fence_tag_value: &str,
    ) -> Result<bool, String> {
        let filter = Filter::new()
            .id(expected.id)
            .kind(expected.kind)
            .author(expected.pubkey)
            .custom_tags(SingleLetterTag::lowercase(Alphabet::H), [channel_id])
            .custom_tags(SingleLetterTag::lowercase(Alphabet::D), [fence_tag_value])
            .limit(1);
        let response = tokio::time::timeout(RELAY_LOOKUP_TIMEOUT, self.rest.query(&[filter]))
            .await
            .map_err(|_| "publication reconciliation query timed out".to_string())?
            .map_err(|error| format!("publication reconciliation query failed: {error}"))?;
        let events = response.as_array().ok_or_else(|| {
            "publication reconciliation returned a non-array response".to_string()
        })?;
        if events.len() > 1 {
            return Err("publication reconciliation exceeded the requested event limit".into());
        }
        let Some(value) = events.first() else {
            return Ok(false);
        };
        let event: nostr::Event = serde_json::from_value(value.clone()).map_err(|error| {
            format!("publication reconciliation returned an invalid event: {error}")
        })?;
        event.verify().map_err(|error| {
            format!("publication reconciliation event verification failed: {error}")
        })?;
        // The verified hash binds author, timestamp, kind, all tags, and content.
        // A fence tag alone is not evidence that this exact output was published.
        if event.id != expected.id {
            return Err("publication reconciliation returned a different event".into());
        }
        Ok(true)
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

fn sign_publication_event(
    builder: EventBuilder,
    keys: &nostr::Keys,
    event_created_at: u64,
) -> Result<nostr::Event, String> {
    // The immutable fence timestamp makes the event ID stable even if a relay
    // accepted an earlier submission but its ACK or reconciliation query is lost.
    builder
        .custom_created_at(nostr::Timestamp::from(event_created_at))
        .sign_with_keys(keys)
        .map_err(|error| format!("publication signing failed: {error}"))
}

fn publication_event_kind(intent: &LocalPublicationIntent) -> u16 {
    if matches!(intent.publication_kind.as_str(), "final" | "action") {
        9
    } else {
        buzz_sdk::kind::KIND_AGENT_STATUS as u16
    }
}

fn is_status_publication(intent: &LocalPublicationIntent) -> bool {
    matches!(
        intent.publication_kind.as_str(),
        "receipt" | "progress" | "capacity"
    )
}

fn is_terminal_publication(intent: &LocalPublicationIntent) -> bool {
    matches!(
        intent.publication_kind.as_str(),
        "final" | "error" | "cancelled"
    )
}

fn publication_retry_max_elapsed(intent: &LocalPublicationIntent) -> Duration {
    if is_status_publication(intent) {
        STATUS_PUBLISH_RETRY_MAX_ELAPSED
    } else {
        PUBLISH_RETRY_MAX_ELAPSED
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
        || intent.event_created_at == 0
        || intent.event_created_at > i64::MAX as u64
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
mod tests;

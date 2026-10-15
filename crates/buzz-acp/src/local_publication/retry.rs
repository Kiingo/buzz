//! Publication pacing survives dropped futures; the durable outbox owns output.
use std::{collections::HashMap, time::Duration};

use tokio::time::Instant;

use super::{
    is_status_event_publication, is_status_publication, publication_retry_delay,
    publication_retry_max_elapsed, LocalPublicationIntent, LocalPublicationWorker,
    PUBLICATION_QUEUE_CAPACITY, RELAY_TIMESTAMP_REJECTION, STATUS_PUBLISH_ATTEMPT_TIMEOUT,
};

const RETRY_FENCE_CAPACITY: usize = PUBLICATION_QUEUE_CAPACITY * 2;
const FAILURE_REPORT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug)]
struct RetryFence {
    attempt: usize,
    not_before: Instant,
    last_used: Instant,
}

/// Bounded pacing metadata only: eviction never discards saved output or authority.
#[derive(Debug, Default)]
pub(super) struct RetryPacing {
    fences: HashMap<String, RetryFence>,
}

impl RetryPacing {
    fn not_before(&self, fence_id: &str) -> Option<Instant> {
        self.fences.get(fence_id).map(|fence| fence.not_before)
    }

    fn begin_attempt(&mut self, fence_id: &str) -> usize {
        let now = Instant::now();
        if !self.fences.contains_key(fence_id) && self.fences.len() >= RETRY_FENCE_CAPACITY {
            let oldest = self
                .fences
                .iter()
                .min_by_key(|(_, fence)| fence.last_used)
                .map(|(id, _)| id.clone());
            if let Some(oldest) = oldest {
                self.fences.remove(&oldest);
            }
        }
        let fence = self
            .fences
            .entry(fence_id.to_owned())
            .or_insert(RetryFence {
                attempt: 0,
                not_before: now,
                last_used: now,
            });
        fence.attempt = fence.attempt.saturating_add(1);
        // Arm before awaiting I/O. Recovery/control preemption may drop that future.
        fence.not_before = now + publication_retry_delay(fence.attempt);
        fence.last_used = now;
        fence.attempt
    }

    fn defer(&mut self, fence_id: &str, delay: Duration) {
        if let Some(fence) = self.fences.get_mut(fence_id) {
            fence.not_before = fence.not_before.max(Instant::now() + delay);
        }
    }

    fn completed(&mut self, fence_id: &str) {
        self.fences.remove(fence_id);
    }
}

impl LocalPublicationWorker {
    pub(super) async fn publish_with_retry(
        &self,
        intent: &LocalPublicationIntent,
    ) -> Option<String> {
        let started_at = Instant::now();
        loop {
            let not_before = self.retry_pacing.lock().await.not_before(&intent.fence_id);
            if let Some(not_before) = not_before {
                tokio::time::sleep_until(not_before).await;
            }
            let attempt = self
                .retry_pacing
                .lock()
                .await
                .begin_attempt(&intent.fence_id);
            let result = if is_status_publication(intent) {
                tokio::time::timeout(STATUS_PUBLISH_ATTEMPT_TIMEOUT, self.publish(intent))
                    .await
                    .map_err(|_| "status publication attempt timed out".to_string())
                    .and_then(|result| result)
            } else {
                self.publish(intent).await
            };
            match result {
                Ok(Some(event_id)) => {
                    self.retry_pacing.lock().await.completed(&intent.fence_id);
                    return Some(event_id);
                }
                // A denied authorization is not success. Retain pacing if stale
                // adapter notifications or recovered intents keep arriving.
                Ok(None) => return None,
                Err(error) => {
                    if is_status_event_publication(intent)
                        && error.contains(RELAY_TIMESTAMP_REJECTION)
                    {
                        tracing::warn!(
                            target: "buzz::local_publication",
                            receipt_id = %intent.receipt_id, fence_id = %intent.fence_id,
                            publication_kind = %intent.publication_kind, attempt, error = %error,
                            "dropping operational status the relay rejected as outside its timestamp window"
                        );
                        return None;
                    }
                    let delay = publication_retry_delay(attempt);
                    self.retry_pacing
                        .lock()
                        .await
                        .defer(&intent.fence_id, delay);
                    if matches!(intent.publication_kind.as_str(), "final" | "action") {
                        self.report_failure(intent, failure_code(&error)).await;
                    }
                    if started_at.elapsed().saturating_add(delay)
                        > publication_retry_max_elapsed(intent)
                    {
                        tracing::error!(
                            target: "buzz::local_publication",
                            receipt_id = %intent.receipt_id, fence_id = %intent.fence_id,
                            publication_kind = %intent.publication_kind, attempt, error = %error,
                            "local publication batch deferred; saved output remains recoverable in the durable outbox"
                        );
                        return None;
                    }
                    tracing::warn!(
                        target: "buzz::local_publication",
                        receipt_id = %intent.receipt_id, fence_id = %intent.fence_id,
                        publication_kind = %intent.publication_kind, attempt,
                        retry_delay_ms = delay.as_millis(), error = %error,
                        "local Buzz publication will retry after a transient boundary failure"
                    );
                    // The next loop waits on the retained deadline. No reset on
                    // recovery, batch return, or cancellation of this future.
                }
            }
        }
    }

    async fn report_failure(&self, intent: &LocalPublicationIntent, code: &'static str) {
        let request = self
            .rest
            .http
            .post(format!(
                "{}/api/buzz-bridge/publications/{}/failure",
                self.completion_api_base_url, intent.fence_id
            ))
            .bearer_auth(&self.internal_token)
            .json(&serde_json::json!({
                "fence_id": intent.fence_id,
                "receipt_id": intent.receipt_id,
                "community_id": intent.community_id,
                "agent_public_key": intent.agent_public_key,
                "failure_code": code,
            }));
        // One bounded observation, never a delivery retry or success receipt.
        let recorded = tokio::time::timeout(FAILURE_REPORT_TIMEOUT, request.send())
            .await
            .is_ok_and(|result| result.is_ok_and(|response| response.status().is_success()));
        if !recorded {
            tracing::warn!(
                target: "buzz::local_publication",
                receipt_id = %intent.receipt_id, fence_id = %intent.fence_id,
                failure_code = code,
                "publication failure diagnostic unavailable; saved output remains recoverable"
            );
        }
    }
}

fn failure_code(error: &str) -> &'static str {
    if error.starts_with("publication eligibility unavailable:") {
        "authorization_unavailable"
    } else if error.starts_with("publication eligibility rejected:") {
        "authorization_rejected"
    } else if error.starts_with("publication authorization response invalid:") {
        "authorization_response_invalid"
    } else if error.starts_with("publication reconciliation") {
        "relay_reconciliation_unavailable"
    } else if error.starts_with("publication relay submission") {
        "relay_submission_unavailable"
    } else if error.starts_with("publication fence completion") {
        "completion_unavailable"
    } else if error.starts_with("publication runtime authorization")
        || error.starts_with("publication build")
        || error.starts_with("publication signing")
    {
        "signing_or_authority_invalid"
    } else {
        "publication_unavailable"
    }
}

#[cfg(test)]
mod tests;

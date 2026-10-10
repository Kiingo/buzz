//! Loop and amplification guards for agent-to-agent traffic.
//!
//! Enforced by the harness, so they hold for owner-sibling agents (local
//! turns) as well as for crossings handed to the hosted guest route:
//!
//! - **Per-pair rate limit.** At most [`PAIR_PER_THREAD_LIMIT`] agent → agent
//!   turns per (pair, thread) per [`PAIR_THREAD_WINDOW`], and
//!   [`PAIR_PER_DAY_LIMIT`] per pair per day. The first event over a limit
//!   reports [`PairDecision::LimitedFirst`] so the caller sends one digest
//!   notice to both owners; later ones are dropped quietly.
//! - **Per-root budget.** A thread root may trigger at most
//!   [`ROOT_TURN_BUDGET`] agent-authored turns a day here, and an event whose
//!   `buzz-root-budget` tag says the chain is spent is refused.
//! - **Dedup.** The same normalized request from an agent, for the same
//!   effective requester, to this agent within [`DEDUP_WINDOW`] is not handled
//!   twice. (People are deduplicated by the hosted route, which can reply.)
//! - **Echo suppression.** An agent message that quotes this agent's own
//!   recent output is not treated as a new instruction.
//! - **Approval-pending requests.** A request held for owner approval is never
//!   re-submitted because an agent asked again.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

/// Agent → agent turns allowed per (pair, thread) per window.
pub(crate) const PAIR_PER_THREAD_LIMIT: usize = 6;
/// Window for [`PAIR_PER_THREAD_LIMIT`].
pub(crate) const PAIR_THREAD_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Agent → agent turns allowed per pair per day.
pub(crate) const PAIR_PER_DAY_LIMIT: usize = 20;
const DAY: Duration = Duration::from_secs(24 * 60 * 60);
/// Agent-authored turns one thread root may trigger here per day.
pub(crate) const ROOT_TURN_BUDGET: usize = 12;
/// Repeated-request window.
pub(crate) const DEDUP_WINDOW: Duration = Duration::from_secs(10 * 60);
/// How long a held request blocks agent re-asks (matches approval expiry for
/// agent-to-agent requests).
pub(crate) const PENDING_APPROVAL_TTL: Duration = Duration::from_secs(72 * 60 * 60);
/// Minimum normalized length of an own output for echo matching. Short
/// replies ("ok", "done") are too common to be evidence of an echo.
const ECHO_MIN_CHARS: usize = 40;
const ECHO_HISTORY: usize = 64;
const ECHO_TTL: Duration = Duration::from_secs(60 * 60);
const MAP_CAP: usize = 4096;

/// Outcome of the per-pair rate limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PairDecision {
    /// Within limits; the turn was counted.
    Allow,
    /// First refusal for this pair today: send the digest notice.
    LimitedFirst,
    /// Already notified; drop quietly.
    Limited,
}

/// Lowercase, strip mentions and punctuation, collapse whitespace.
pub(crate) fn normalize_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for word in text.split_whitespace() {
        let lower = word.to_lowercase();
        if lower.starts_with("nostr:npub") || lower.starts_with("nostr:nprofile") {
            continue;
        }
        let cleaned: String = lower
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '\'')
            .collect();
        if cleaned.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&cleaned);
    }
    out
}

/// Dedup key over `(normalized text, effective requester, target agent)`.
pub(crate) fn request_key(text: &str, requester: &str, target_agent: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalize_text(text).as_bytes());
    hasher.update([0]);
    hasher.update(requester.as_bytes());
    hasher.update([0]);
    hasher.update(target_agent.as_bytes());
    hex::encode(hasher.finalize())
}

#[derive(Default)]
struct PairState {
    /// Turn times per thread.
    threads: HashMap<String, VecDeque<Instant>>,
    /// Turn times for the day window.
    day: VecDeque<Instant>,
    /// When the digest notice was last sent.
    notified_at: Option<Instant>,
}

/// Every guard's state for one harness. Single-threaded: owned by the main
/// event loop.
#[derive(Default)]
pub(crate) struct AgentGuards {
    pairs: HashMap<String, PairState>,
    roots: HashMap<String, VecDeque<Instant>>,
    recent_requests: HashMap<String, Instant>,
    pending: HashMap<String, (String, Instant)>,
    own_outputs: VecDeque<(Instant, String)>,
}

fn prune(times: &mut VecDeque<Instant>, now: Instant, window: Duration) {
    while times
        .front()
        .is_some_and(|at| now.duration_since(*at) >= window)
    {
        times.pop_front();
    }
}

impl AgentGuards {
    /// Count an agent → agent turn from `other_agent` in `thread`.
    pub(crate) fn check_pair(
        &mut self,
        other_agent: &str,
        thread: &str,
        now: Instant,
    ) -> PairDecision {
        if self.pairs.len() >= MAP_CAP && !self.pairs.contains_key(other_agent) {
            self.pairs.retain(|_, state| {
                state
                    .day
                    .back()
                    .is_some_and(|at| now.duration_since(*at) < DAY)
            });
        }
        let state = self.pairs.entry(other_agent.to_string()).or_default();
        prune(&mut state.day, now, DAY);
        let thread_times = state.threads.entry(thread.to_string()).or_default();
        prune(thread_times, now, PAIR_THREAD_WINDOW);
        if thread_times.len() >= PAIR_PER_THREAD_LIMIT || state.day.len() >= PAIR_PER_DAY_LIMIT {
            let first = state
                .notified_at
                .is_none_or(|at| now.duration_since(at) >= DAY);
            if first {
                state.notified_at = Some(now);
                return PairDecision::LimitedFirst;
            }
            return PairDecision::Limited;
        }
        thread_times.push_back(now);
        state.day.push_back(now);
        state.threads.retain(|_, times| !times.is_empty());
        PairDecision::Allow
    }

    /// Spend one agent-triggered turn under `root`. `budget_tag` is the
    /// remaining budget the event itself carries, if any. Returns `false`
    /// when the root's budget is exhausted.
    pub(crate) fn spend_root(&mut self, root: &str, budget_tag: Option<u32>, now: Instant) -> bool {
        if budget_tag == Some(0) {
            return false;
        }
        if self.roots.len() >= MAP_CAP && !self.roots.contains_key(root) {
            self.roots
                .retain(|_, times| times.back().is_some_and(|at| now.duration_since(*at) < DAY));
        }
        let times = self.roots.entry(root.to_string()).or_default();
        prune(times, now, DAY);
        if times.len() >= ROOT_TURN_BUDGET {
            return false;
        }
        times.push_back(now);
        true
    }

    /// Record `key` and report whether it was already seen within
    /// [`DEDUP_WINDOW`].
    pub(crate) fn is_duplicate(&mut self, key: &str, now: Instant) -> bool {
        if self.recent_requests.len() >= MAP_CAP {
            self.recent_requests
                .retain(|_, at| now.duration_since(*at) < DEDUP_WINDOW);
        }
        match self.recent_requests.get(key) {
            Some(at) if now.duration_since(*at) < DEDUP_WINDOW => true,
            _ => {
                self.recent_requests.insert(key.to_string(), now);
                false
            }
        }
    }

    /// Mark `key` as held for owner approval under `reference` (a guest turn
    /// or approval id).
    pub(crate) fn mark_pending(&mut self, key: &str, reference: &str, now: Instant) {
        if self.pending.len() >= MAP_CAP {
            self.pending
                .retain(|_, (_, at)| now.duration_since(*at) < PENDING_APPROVAL_TTL);
        }
        self.pending
            .insert(key.to_string(), (reference.to_string(), now));
    }

    /// The pending reference for `key`, if its approval is still open.
    pub(crate) fn pending_reference(&self, key: &str, now: Instant) -> Option<&str> {
        self.pending
            .get(key)
            .filter(|(_, at)| now.duration_since(*at) < PENDING_APPROVAL_TTL)
            .map(|(reference, _)| reference.as_str())
    }

    /// Clear every pending entry recorded under `reference` (an owner
    /// decided). Returns how many were cleared.
    pub(crate) fn resolve_pending(&mut self, reference: &str) -> usize {
        let before = self.pending.len();
        self.pending.retain(|_, (r, _)| r != reference);
        before - self.pending.len()
    }

    /// Remember text this agent published.
    pub(crate) fn record_own_output(&mut self, text: &str, now: Instant) {
        let normalized = normalize_text(text);
        if normalized.chars().count() < ECHO_MIN_CHARS {
            return;
        }
        while self.own_outputs.len() >= ECHO_HISTORY {
            self.own_outputs.pop_front();
        }
        self.own_outputs.push_back((now, normalized));
    }

    /// Whether `text` (from another agent) quotes this agent's recent output.
    pub(crate) fn is_echo(&mut self, text: &str, now: Instant) -> bool {
        while self
            .own_outputs
            .front()
            .is_some_and(|(at, _)| now.duration_since(*at) >= ECHO_TTL)
        {
            self.own_outputs.pop_front();
        }
        let inbound = normalize_text(text);
        if inbound.chars().count() < ECHO_MIN_CHARS {
            return false;
        }
        self.own_outputs
            .iter()
            .any(|(_, own)| inbound.contains(own.as_str()) || (own.contains(inbound.as_str())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT: &str = "agent-b";

    #[test]
    fn pair_limit_per_thread_then_one_digest() {
        let mut guards = AgentGuards::default();
        let t0 = Instant::now();
        for i in 0..PAIR_PER_THREAD_LIMIT {
            assert_eq!(
                guards.check_pair(AGENT, "root", t0 + Duration::from_secs(i as u64)),
                PairDecision::Allow
            );
        }
        assert_eq!(
            guards.check_pair(AGENT, "root", t0),
            PairDecision::LimitedFirst
        );
        assert_eq!(guards.check_pair(AGENT, "root", t0), PairDecision::Limited);
        // Another thread is still open.
        assert_eq!(guards.check_pair(AGENT, "other", t0), PairDecision::Allow);
        // After the window, the thread reopens (digest not repeated).
        let later = t0 + PAIR_THREAD_WINDOW + Duration::from_secs(10);
        assert_eq!(guards.check_pair(AGENT, "root", later), PairDecision::Allow);
    }

    #[test]
    fn pair_limit_per_day() {
        let mut guards = AgentGuards::default();
        let t0 = Instant::now();
        for i in 0..PAIR_PER_DAY_LIMIT {
            let thread = format!("t{}", i / 5);
            assert_eq!(
                guards.check_pair(AGENT, &thread, t0 + Duration::from_secs(i as u64)),
                PairDecision::Allow
            );
        }
        assert_eq!(
            guards.check_pair(AGENT, "fresh", t0 + Duration::from_secs(60)),
            PairDecision::LimitedFirst
        );
        assert_eq!(
            guards.check_pair(AGENT, "fresh", t0 + DAY + Duration::from_secs(60)),
            PairDecision::Allow
        );
    }

    #[test]
    fn root_budget_is_spent_and_tag_is_honoured() {
        let mut guards = AgentGuards::default();
        let now = Instant::now();
        assert!(!guards.spend_root("r", Some(0), now));
        for _ in 0..ROOT_TURN_BUDGET {
            assert!(guards.spend_root("r", Some(5), now));
        }
        assert!(!guards.spend_root("r", None, now));
        assert!(guards.spend_root("other", None, now));
    }

    #[test]
    fn dedup_within_window_only() {
        let mut guards = AgentGuards::default();
        let now = Instant::now();
        let key = request_key("Can you share the Q3 plan?", "jess", "atlas");
        let same = request_key("can you share the q3 plan", "jess", "atlas");
        assert_eq!(key, same);
        assert_ne!(
            key,
            request_key("can you share the q3 plan", "dan", "atlas")
        );
        assert!(!guards.is_duplicate(&key, now));
        assert!(guards.is_duplicate(&same, now + Duration::from_secs(60)));
        assert!(!guards.is_duplicate(&key, now + DEDUP_WINDOW + Duration::from_secs(1)));
    }

    #[test]
    fn mentions_do_not_change_the_key() {
        assert_eq!(
            request_key("nostr:npub1abc what's the status?", "a", "b"),
            request_key("what's the status", "a", "b")
        );
    }

    #[test]
    fn pending_blocks_until_resolved() {
        let mut guards = AgentGuards::default();
        let now = Instant::now();
        guards.mark_pending("k", "turn-1", now);
        assert_eq!(guards.pending_reference("k", now), Some("turn-1"));
        assert_eq!(guards.resolve_pending("turn-1"), 1);
        assert_eq!(guards.pending_reference("k", now), None);
        guards.mark_pending("k", "turn-2", now);
        assert_eq!(
            guards.pending_reference("k", now + PENDING_APPROVAL_TTL),
            None
        );
    }

    #[test]
    fn echo_of_own_output_is_detected() {
        let mut guards = AgentGuards::default();
        let now = Instant::now();
        let own = "The deploy finished at 14:02 and all health checks are green across regions.";
        guards.record_own_output(own, now);
        assert!(guards.is_echo(&format!("> {own}\nPlease do that again now."), now));
        assert!(!guards.is_echo(
            "Can you summarize the incident review from yesterday for me please?",
            now
        ));
        // Short outputs are never echo evidence.
        guards.record_own_output("ok", now);
        assert!(!guards.is_echo("ok", now));
        // Old outputs expire.
        assert!(!guards.is_echo(own, now + ECHO_TTL));
    }
}

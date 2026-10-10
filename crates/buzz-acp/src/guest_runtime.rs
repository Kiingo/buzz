//! Hosted guest-turn routing for one agent process.
//!
//! [`GuestRuntime`] owns everything the harness does for crossings (events
//! whose signed author is neither the owner nor an owner-sibling agent):
//!
//! 1. **Classify** the author into a [`TrustTier`] from signed data.
//! 2. **Guard** agent traffic (echo, pending approvals, dedup, root budget,
//!    per-pair rate limit). The guards also run for sibling agents, whose
//!    turns stay local.
//! 3. **Route** the event to the hosted guest route (`POST /turns`) with its
//!    thread context, verified relay chain, author profile and audience. The
//!    local agent session never sees it.
//! 4. **Publish** what the route puts in the outbox, signing the exact text
//!    it was given and acknowledging it (`GET /outbox`, `POST /outbox/:id/ack`).
//! 5. **Register** the endpoint on start and when the access policy changes.
//!
//! Observer frames emitted here (all under the harness observer stream):
//! `guest_endpoint_status`, `guest_turn_routed`, `guest_route_error`,
//! `guest_guard`, `guest_publication`, `guest_approval_decided`.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use buzz_sdk::agent_relay;
use nostr::{Event, EventId, Keys};
use serde_json::{json, Value};
use tokio::sync::Notify;
use uuid::Uuid;

use crate::agent_guards::{request_key, AgentGuards, PairDecision};
use crate::config::RespondTo;
use crate::dm_participants::DmParticipantResolver;
use crate::guest_route::{
    GuestRouteClient, OutboxItem, RegisterRequest, RegisterResponse, RouteError, TurnRequest,
    TurnResponse, OUTBOX_WAIT_MS,
};
use crate::observer::{ObserverContext, ObserverHandle};
use crate::provenance::{self, ChainStatus};
use crate::queue::parse_thread_tags;
use crate::relay::RestClient;
use crate::trust::{tier_from_parts, GuestTurns, ProfileDirectory, TrustTier};

/// Tag on harness-authored notices (refusals, hop-limit and pair-limit
/// notices), so they are never mistaken for a turn's own reply.
pub(crate) const HARNESS_NOTICE_TAG: &str = "buzz-harness-notice";

/// Thread events sent as context with a routed turn (contract cap).
const CONTEXT_EVENTS: usize = 20;
/// Audience pubkeys sent with a routed turn; `audience_total` carries the
/// full count.
const AUDIENCE_CAP: usize = 500;
/// One harness notice per key per this window.
const NOTICE_COOLDOWN: Duration = Duration::from_secs(60 * 60);
const SUBMIT_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(4),
    Duration::from_secs(15),
];
const REGISTER_REFRESH: Duration = Duration::from_secs(6 * 60 * 60);
const REGISTER_RETRY: Duration = Duration::from_secs(60);
const POLICY_CHECK: Duration = Duration::from_secs(60);
const PUBLISHED_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const NOTICE_TIMEOUT: Duration = Duration::from_secs(10);

/// Placeholder shown to the local session in place of a crossing's text.
pub(crate) const WITHHELD_PLACEHOLDER: &str =
    "[message from someone other than your owner; handled by the guest route and not shown here]";

/// The hosted-mode runtime, installed once at startup so prompt assembly can
/// withhold crossing text from the local session's conversation context.
static HOSTED_CONTEXT_FILTER: std::sync::OnceLock<Arc<GuestRuntime>> = std::sync::OnceLock::new();

/// Install `runtime` as the context filter (hosted mode only).
pub(crate) fn install_context_filter(runtime: &Arc<GuestRuntime>) {
    if runtime.mode() == GuestTurns::Hosted {
        let _ = HOSTED_CONTEXT_FILTER.set(Arc::clone(runtime));
    }
}

/// Whether hosted-mode context filtering is installed.
pub(crate) fn context_filter_active() -> bool {
    HOSTED_CONTEXT_FILTER.get().is_some()
}

/// Whether a message JSON object (from the relay) is harness output for a
/// guest: a hosted answer or a harness notice.
pub(crate) fn is_guest_output_json(obj: &Value) -> bool {
    obj.get("tags")
        .and_then(Value::as_array)
        .is_some_and(|tags| {
            tags.iter().any(|tag| {
                matches!(
                    tag.get(0).and_then(Value::as_str),
                    Some(agent_relay::GUEST_TAG)
                        | Some(agent_relay::GUEST_TURN_TAG)
                        | Some(HARNESS_NOTICE_TAG)
                )
            })
        })
}

/// In hosted mode, withhold every crossing's text from conversation context
/// handed to the local session: only the owner, this agent and verified
/// same-owner agents are shown; everyone else (and this agent's own output
/// for guests, already replaced by the caller) becomes
/// [`WITHHELD_PLACEHOLDER`]. A no-op in local mode.
pub(crate) async fn filter_context(
    context: Option<crate::queue::ConversationContext>,
) -> Option<crate::queue::ConversationContext> {
    let runtime = HOSTED_CONTEXT_FILTER.get()?.clone();
    let mut context = context?;
    let messages = match &mut context {
        crate::queue::ConversationContext::Thread { messages, .. }
        | crate::queue::ConversationContext::Dm { messages, .. } => messages,
    };
    // One concurrent lookup per distinct author (cached profiles are free).
    let mut authors: Vec<String> = messages
        .iter()
        .map(|m| m.pubkey.to_ascii_lowercase())
        .collect();
    authors.sort();
    authors.dedup();
    let verdicts = futures_util::future::join_all(
        authors
            .iter()
            .map(|author| runtime.is_owner_equivalent_author(author)),
    )
    .await;
    let trusted: HashSet<&String> = authors
        .iter()
        .zip(verdicts)
        .filter_map(|(author, ok)| ok.then_some(author))
        .collect();
    for message in messages.iter_mut() {
        if !trusted.contains(&message.pubkey.to_ascii_lowercase()) {
            message.content = WITHHELD_PLACEHOLDER.to_string();
        }
    }
    Some(context)
}

/// Static configuration for a [`GuestRuntime`].
pub(crate) struct GuestRuntimeConfig {
    pub(crate) mode: GuestTurns,
    pub(crate) route_url: Option<String>,
    pub(crate) community_id: String,
    pub(crate) relay_url: String,
    pub(crate) respond_to: RespondTo,
    pub(crate) static_allowlist: HashSet<String>,
    pub(crate) guest_instructions: Option<String>,
}

/// Verdict of the agent-traffic guards for one event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GuardVerdict {
    /// Handle the event. Carries the dedup key used for pending tracking.
    Proceed { request_key: Option<String> },
    /// Drop the event (`guard` names the rule for logs and observers).
    Drop { guard: &'static str },
}

/// Facts about an inbound event that the guards need.
pub(crate) struct GuardInput<'a> {
    pub(crate) event: &'a Event,
    pub(crate) channel_id: Uuid,
    pub(crate) tier: &'a TrustTier,
}

/// Shared state for guest routing in one harness process.
pub(crate) struct GuestRuntime {
    mode: GuestTurns,
    client: Option<Arc<GuestRouteClient>>,
    rest: RestClient,
    keys: Keys,
    agent_pubkey: String,
    owner_pubkey: Option<String>,
    respond_to: RespondTo,
    static_allowlist: HashSet<String>,
    guest_instructions: Option<String>,
    relay_url: String,
    profiles: ProfileDirectory,
    roster: DmParticipantResolver,
    guards: Mutex<AgentGuards>,
    registration: RwLock<Option<RegisterResponse>>,
    notices: Mutex<HashMap<String, Instant>>,
    outbox_wake: Notify,
    register_wake: Notify,
    observer: Option<ObserverHandle>,
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

impl GuestRuntime {
    /// Build the runtime. In hosted mode without a usable route URL, every
    /// crossing is refused with a short notice (fail closed).
    pub(crate) fn new(
        config: GuestRuntimeConfig,
        rest: RestClient,
        keys: Keys,
        owner_pubkey: Option<String>,
        observer: Option<ObserverHandle>,
    ) -> Self {
        let client = match (&config.mode, &config.route_url) {
            (GuestTurns::Hosted, Some(url)) => {
                let client = GuestRouteClient::new(url, keys.clone(), config.community_id.clone());
                if client.is_none() {
                    tracing::warn!(
                        "guest route URL must be HTTPS (or loopback HTTP); guest turns will be refused"
                    );
                }
                client.map(Arc::new)
            }
            (GuestTurns::Hosted, None) => {
                tracing::warn!(
                    "guest turns are hosted but no guest route is configured; \
                     non-owner requests will be refused with a notice"
                );
                None
            }
            (GuestTurns::Local, _) => None,
        };
        Self {
            mode: config.mode,
            client,
            roster: DmParticipantResolver::new(rest.clone()),
            rest,
            agent_pubkey: keys.public_key().to_hex(),
            keys,
            owner_pubkey,
            respond_to: config.respond_to,
            static_allowlist: config.static_allowlist,
            guest_instructions: config.guest_instructions,
            relay_url: config.relay_url,
            profiles: ProfileDirectory::default(),
            guards: Mutex::new(AgentGuards::default()),
            registration: RwLock::new(None),
            notices: Mutex::new(HashMap::new()),
            outbox_wake: Notify::new(),
            register_wake: Notify::new(),
            observer,
        }
    }

    /// Where non-owner turns run.
    pub(crate) fn mode(&self) -> GuestTurns {
        self.mode
    }

    /// The owner, this agent, or an agent attested by the same owner.
    pub(crate) async fn is_owner_equivalent_author(&self, pubkey: &str) -> bool {
        let pubkey = pubkey.to_ascii_lowercase();
        if pubkey == self.agent_pubkey {
            return true;
        }
        let Some(owner) = self.owner_pubkey.as_deref() else {
            return false;
        };
        if pubkey == owner {
            return true;
        }
        if !is_hex64(&pubkey) {
            return false;
        }
        self.profiles
            .lookup(&pubkey, &self.rest)
            .await
            .attested_owner
            .as_deref()
            .is_some_and(|attested| attested.eq_ignore_ascii_case(owner))
    }

    fn emit(&self, kind: &str, channel_id: Option<Uuid>, payload: Value) {
        if let Some(observer) = &self.observer {
            let context = ObserverContext {
                channel_id: channel_id.map(|c| c.to_string()),
                ..ObserverContext::default()
            };
            observer.emit(kind, None, &context, payload);
        }
    }

    fn guards(&self) -> std::sync::MutexGuard<'_, AgentGuards> {
        match self.guards.lock() {
            Ok(guards) => guards,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Classify `event`'s signed author. `is_sibling` is the existing
    /// owner-or-sibling verdict (true for the owner too).
    pub(crate) async fn classify(&self, event: &Event, is_owner_or_sibling: bool) -> TrustTier {
        let author = event.pubkey.to_hex();
        let owner = self.owner_pubkey.as_deref();
        let is_owner = owner.is_some_and(|o| o.eq_ignore_ascii_case(&author));
        let guest_tag = agent_relay::guest_requester(event);
        let attested_owner = if is_owner_or_sibling {
            None
        } else {
            self.profiles
                .lookup(&author, &self.rest)
                .await
                .attested_owner
                .clone()
        };
        let chain: Vec<String> = match agent_relay::parse_relay_claim(event) {
            Ok(Some(claim)) => {
                let mut chain = vec![claim.origin_author];
                if let Some((_, prev)) = claim.prev {
                    chain.push(prev);
                }
                chain
            }
            _ => Vec::new(),
        };
        tier_from_parts(
            &author,
            owner,
            is_owner_or_sibling && !is_owner,
            guest_tag.as_deref(),
            attested_owner.as_deref(),
            &chain,
        )
    }

    /// Run the loop and amplification guards. Owner events always proceed.
    pub(crate) fn check_guards(&self, input: &GuardInput<'_>) -> GuardVerdict {
        let author = input.event.pubkey.to_hex();
        let (requester, author_is_agent) = match input.tier {
            TrustTier::Owner => {
                return GuardVerdict::Proceed { request_key: None };
            }
            TrustTier::Sibling => (author.clone(), true),
            TrustTier::Guest { requester } => (requester.clone(), *requester != author),
            TrustTier::OtherOwnerAgent { owner, .. } => (owner.clone(), true),
        };
        let now = Instant::now();
        let key = request_key(&input.event.content, &requester, &self.agent_pubkey);
        // Top-level posts share one key per channel, so a loop of top-level
        // posts is limited like a loop inside one thread.
        let thread = parse_thread_tags(input.event)
            .root_event_id
            .unwrap_or_else(|| format!("channel:{}", input.channel_id));
        let verdict = {
            let mut guards = self.guards();
            if author_is_agent && guards.is_echo(&input.event.content, now) {
                Err("echo")
            } else if author_is_agent && guards.pending_reference(&key, now).is_some() {
                Err("approval_pending")
            } else if author_is_agent && guards.is_duplicate(&key, now) {
                // People re-asking are deduplicated server-side, which can
                // answer "already asked"; a silent local drop would not.
                Err("duplicate")
            } else if author_is_agent
                && !guards.spend_root(
                    &provenance::thread_of(input.event),
                    agent_relay::root_budget(input.event).map(|(_, remaining)| remaining),
                    now,
                )
            {
                Err("root_budget")
            } else if author_is_agent {
                match guards.check_pair(&author, &thread, now) {
                    PairDecision::Allow => Ok(()),
                    PairDecision::LimitedFirst => Err("pair_rate_limit_notice"),
                    PairDecision::Limited => Err("pair_rate_limit"),
                }
            } else {
                Ok(())
            }
        };
        match verdict {
            Ok(()) => GuardVerdict::Proceed {
                request_key: Some(key),
            },
            Err(guard) => {
                tracing::info!(
                    channel_id = %input.channel_id,
                    author = %author,
                    guard,
                    "agent traffic guard — dropping event"
                );
                self.emit(
                    "guest_guard",
                    Some(input.channel_id),
                    json!({
                        "guard": guard,
                        "author": author,
                        "eventId": input.event.id.to_hex(),
                        "trust": input.tier.label(),
                    }),
                );
                GuardVerdict::Drop { guard }
            }
        }
    }

    /// Send the one-per-day digest notice when a pair hits its rate limit.
    pub(crate) fn spawn_pair_limit_notice(
        self: &Arc<Self>,
        event: &Event,
        channel_id: Uuid,
        tier: &TrustTier,
    ) {
        let mut owners: Vec<String> = Vec::new();
        if let Some(owner) = &self.owner_pubkey {
            owners.push(owner.clone());
        }
        if let TrustTier::OtherOwnerAgent { owner, .. } = tier {
            owners.push(owner.clone());
        }
        let text = format!(
            "Pausing agent-to-agent replies here: this pair reached its limit \
             ({} turns per thread per 10 minutes, {} per day).",
            crate::agent_guards::PAIR_PER_THREAD_LIMIT,
            crate::agent_guards::PAIR_PER_DAY_LIMIT
        );
        let runtime = Arc::clone(self);
        let event = event.clone();
        tokio::spawn(async move {
            runtime
                .publish_notice(channel_id, &event, &text, &owners)
                .await;
        });
    }

    /// Record text this agent published (from its own events on the relay),
    /// for echo suppression.
    pub(crate) fn record_own_output(&self, text: &str) {
        self.guards().record_own_output(text, Instant::now());
    }

    /// Handle an owner-signed `approve_guest_reply` / `deny_guest_reply`
    /// control frame. The decision itself is recorded server-side by the
    /// owner's client; the harness clears its pending state and polls the
    /// outbox at once so an approved answer publishes without delay.
    pub(crate) fn handle_approval_control(&self, decision: &str, payload: &Value) {
        let ids: Vec<&str> = ["approvalId", "guestTurnId"]
            .iter()
            .filter_map(|key| payload.get(*key).and_then(Value::as_str))
            .collect();
        let cleared: usize = {
            let mut guards = self.guards();
            ids.iter().map(|id| guards.resolve_pending(id)).sum()
        };
        self.outbox_wake.notify_one();
        self.emit(
            "guest_approval_decided",
            None,
            json!({
                "decision": decision,
                "approvalId": payload.get("approvalId"),
                "guestTurnId": payload.get("guestTurnId"),
                "clearedPending": cleared,
            }),
        );
    }

    /// Hand `event` to the hosted guest route. Never blocks the caller.
    pub(crate) fn route(
        self: &Arc<Self>,
        event: Event,
        channel_id: Uuid,
        is_dm: bool,
        channel_name: Option<String>,
        tier: TrustTier,
        request_key: Option<String>,
    ) {
        let runtime = Arc::clone(self);
        tokio::spawn(async move {
            runtime
                .route_inner(event, channel_id, is_dm, channel_name, tier, request_key)
                .await;
        });
    }

    fn registration_status(&self) -> Option<String> {
        self.registration
            .read()
            .ok()
            .and_then(|r| r.as_ref().map(|r| r.status.clone()))
    }

    fn owner_display_name(&self) -> Option<String> {
        self.registration
            .read()
            .ok()
            .and_then(|r| r.as_ref().and_then(|r| r.owner_display_name.clone()))
    }

    async fn route_inner(
        &self,
        event: Event,
        channel_id: Uuid,
        is_dm: bool,
        channel_name: Option<String>,
        tier: TrustTier,
        request_key: Option<String>,
    ) {
        let author = event.pubkey.to_hex();
        let author_profile = self.profiles.lookup(&author, &self.rest).await;
        let author_is_agent = author_profile.is_agent()
            || !matches!(tier, TrustTier::Guest { ref requester } if *requester == author);
        let chain = provenance::check_chain(&event, &self.rest).await;
        if let ChainStatus::TooDeep { hop } = chain.status {
            self.hop_limit_notice(&event, channel_id, &chain.authors, hop)
                .await;
        }
        if let ChainStatus::Unverifiable(reason) = &chain.status {
            tracing::info!(
                event_id = %event.id,
                reason = %reason,
                "relay chain unverifiable — routing as tier 0"
            );
        }

        let route_ready = !matches!(
            self.registration_status().as_deref(),
            Some("owner_unlinked") | Some("disabled")
        );
        let Some(client) = self.client.clone().filter(|_| route_ready) else {
            self.emit(
                "guest_route_error",
                Some(channel_id),
                json!({
                    "eventId": event.id.to_hex(),
                    "error": "guest_route_unavailable",
                    "registration": self.registration_status(),
                }),
            );
            if !author_is_agent {
                self.unavailable_notice(&event, channel_id, &author).await;
            }
            return;
        };

        let thread_root = parse_thread_tags(&event).root_event_id;
        let context_events =
            provenance::thread_context(&self.rest, channel_id, &event, CONTEXT_EVENTS).await;
        let mut audience: Vec<String> = self
            .roster
            .participants(channel_id, &author)
            .await
            .map(|members| members.into_iter().collect())
            .unwrap_or_default();
        audience.sort();
        let audience_total = audience.len();
        audience.truncate(AUDIENCE_CAP);
        let request = TurnRequest {
            community_id: client.community_id().to_string(),
            channel_id: channel_id.to_string(),
            channel_type: if is_dm { "dm" } else { "channel" }.to_string(),
            channel_name,
            trigger_event: event.clone(),
            thread_root_event_id: thread_root,
            context_events,
            relay_chain_events: if chain.status == ChainStatus::Verified {
                self.chain_with_hop_profiles(&chain.events).await
            } else {
                Vec::new()
            },
            author_profile_event: author_profile
                .is_agent()
                .then(|| author_profile.event.clone())
                .flatten(),
            audience_pubkeys: audience,
            audience_total,
            relay_chain_status: chain.status.label().to_string(),
            relay_chain_error: match &chain.status {
                ChainStatus::Unverifiable(reason) => Some(reason.clone()),
                _ => None,
            },
            harness_trust: tier.label().to_string(),
        };

        match self.submit_with_retry(&client, &request).await {
            Ok(response) => {
                if response.awaits_owner() && author_is_agent {
                    if let Some(key) = &request_key {
                        self.guards()
                            .mark_pending(key, &response.guest_turn_id, Instant::now());
                    }
                }
                tracing::info!(
                    channel_id = %channel_id,
                    event_id = %event.id,
                    guest_turn_id = %response.guest_turn_id,
                    state = %response.state,
                    trust = tier.label(),
                    "routed crossing to hosted guest turn"
                );
                self.emit(
                    "guest_turn_routed",
                    Some(channel_id),
                    json!({
                        "eventId": event.id.to_hex(),
                        "guestTurnId": response.guest_turn_id,
                        "state": response.state,
                        "tier": response.tier,
                        "trust": tier.label(),
                        "requester": author,
                        "relayChain": chain.status.label(),
                    }),
                );
                self.outbox_wake.notify_one();
            }
            Err(error) => {
                tracing::warn!(
                    channel_id = %channel_id,
                    event_id = %event.id,
                    %error,
                    "guest route refused or unreachable"
                );
                self.emit(
                    "guest_route_error",
                    Some(channel_id),
                    json!({
                        "eventId": event.id.to_hex(),
                        "error": error.code,
                        "status": error.status,
                    }),
                );
                if matches!(
                    error.code.as_str(),
                    "guest_endpoint_not_registered" | "guest_endpoint_disabled"
                ) {
                    self.register_wake.notify_one();
                }
                if !author_is_agent && error.status != Some(409) {
                    self.unavailable_notice(&event, channel_id, &author).await;
                }
            }
        }
    }

    /// The verified chain events, origin first, followed by the signed kind:0
    /// profile of every agent hop (the route needs each agent's NIP-OA
    /// attestation; a hop without one counts as unknown).
    async fn chain_with_hop_profiles(&self, events: &[Event]) -> Vec<Event> {
        let mut out = events.to_vec();
        let mut seen: HashSet<String> = HashSet::new();
        for event in events {
            let author = event.pubkey.to_hex();
            if !seen.insert(author.clone()) {
                continue;
            }
            let profile = self.profiles.lookup(&author, &self.rest).await;
            if !profile.is_agent() {
                continue;
            }
            if let Some(parsed) = profile
                .event
                .clone()
                .and_then(|value| serde_json::from_value::<Event>(value).ok())
            {
                out.push(parsed);
            }
        }
        out
    }

    async fn submit_with_retry(
        &self,
        client: &GuestRouteClient,
        request: &TurnRequest,
    ) -> Result<TurnResponse, RouteError> {
        let mut attempt = 0;
        loop {
            match client.submit_turn(request).await {
                Ok(response) => return Ok(response),
                Err(error) if error.is_retryable() && attempt < SUBMIT_DELAYS.len() => {
                    let delay = error
                        .retry_after_ms
                        .map(Duration::from_millis)
                        .unwrap_or(SUBMIT_DELAYS[attempt])
                        .min(Duration::from_secs(30));
                    attempt += 1;
                    tokio::time::sleep(delay).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// Refuse a person when the route cannot take their request: the
    /// owner-only notice, or a short "can't take requests" line. At most once
    /// per requester per channel per hour.
    async fn unavailable_notice(&self, event: &Event, channel_id: Uuid, requester: &str) {
        let owner = self.owner_display_name();
        let text = match self.respond_to {
            RespondTo::OwnerOnly => crate::trust::owner_only_notice(owner.as_deref()),
            _ => match owner {
                Some(owner) => format!(
                    "I can't take requests from you right now. Please ask {owner} directly."
                ),
                None => "I can't take requests from you right now.".to_string(),
            },
        };
        if self.notice_due(&format!("unavailable:{requester}:{channel_id}")) {
            self.publish_notice(channel_id, event, &text, &[]).await;
        }
    }

    /// Refuse a chain deeper than the hop limit and tell every owner in it.
    async fn hop_limit_notice(
        &self,
        event: &Event,
        channel_id: Uuid,
        authors: &[String],
        hop: u32,
    ) {
        let mut owners: Vec<String> = Vec::new();
        let mut chain = authors.to_vec();
        chain.push(event.pubkey.to_hex());
        for author in &chain {
            let profile = self.profiles.lookup(author, &self.rest).await;
            let human = profile
                .attested_owner
                .clone()
                .unwrap_or_else(|| author.clone());
            if !owners.contains(&human) {
                owners.push(human);
            }
        }
        if let Some(owner) = &self.owner_pubkey {
            if !owners.contains(owner) {
                owners.push(owner.clone());
            }
        }
        self.emit(
            "guest_guard",
            Some(channel_id),
            json!({
                "guard": "hop_limit",
                "hop": hop,
                "eventId": event.id.to_hex(),
                "owners": owners,
            }),
        );
        if self.notice_due(&format!("hop:{}", event.id.to_hex())) {
            let text = format!(
                "I can't act on this: it was relayed through {hop} agents and the limit is {}. \
                 Owners in the chain have been notified.",
                agent_relay::HOP_LIMIT
            );
            self.publish_notice(channel_id, event, &text, &owners).await;
        }
    }

    fn notice_due(&self, key: &str) -> bool {
        let mut notices = match self.notices.lock() {
            Ok(n) => n,
            Err(poisoned) => poisoned.into_inner(),
        };
        let now = Instant::now();
        if notices.len() > 1024 {
            notices.retain(|_, at| now.duration_since(*at) < NOTICE_COOLDOWN);
        }
        match notices.get(key) {
            Some(at) if now.duration_since(*at) < NOTICE_COOLDOWN => false,
            _ => {
                notices.insert(key.to_string(), now);
                true
            }
        }
    }

    /// Publish a short harness notice in `trigger`'s thread. `mentions` are
    /// p-tagged only when they are people, never agents.
    async fn publish_notice(
        &self,
        channel_id: Uuid,
        trigger: &Event,
        text: &str,
        mentions: &[String],
    ) {
        let mut people: Vec<String> = Vec::new();
        for pubkey in mentions {
            if pubkey == &self.agent_pubkey || !is_hex64(pubkey) {
                continue;
            }
            if !self.profiles.lookup(pubkey, &self.rest).await.is_agent() {
                people.push(pubkey.clone());
            }
        }
        let root = parse_thread_tags(trigger)
            .root_event_id
            .and_then(|root| EventId::from_hex(&root).ok())
            .unwrap_or(trigger.id);
        let thread_ref = buzz_sdk::ThreadRef {
            root_event_id: root,
            parent_event_id: trigger.id,
        };
        let refs: Vec<&str> = people.iter().map(String::as_str).collect();
        let built = buzz_sdk::build_message_with_extra_tags(
            channel_id,
            text,
            Some(&thread_ref),
            &refs,
            false,
            &[],
            &[vec![HARNESS_NOTICE_TAG.to_string(), "guest".to_string()]],
        )
        .map_err(|e| e.to_string())
        .and_then(|b| b.sign_with_keys(&self.keys).map_err(|e| e.to_string()));
        match built {
            Ok(notice) => {
                match tokio::time::timeout(NOTICE_TIMEOUT, self.rest.submit_event(&notice)).await {
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) => tracing::warn!(%error, "guest notice publish failed"),
                    Err(_) => tracing::warn!("guest notice publish timed out"),
                }
            }
            Err(error) => tracing::warn!(%error, "could not build guest notice"),
        }
    }

    /// Start the registration and outbox loops (hosted mode with a route).
    pub(crate) fn spawn_background(self: &Arc<Self>) -> Vec<tokio::task::JoinHandle<()>> {
        let Some(client) = self.client.clone() else {
            return Vec::new();
        };
        let register = {
            let runtime = Arc::clone(self);
            let client = Arc::clone(&client);
            tokio::spawn(async move { runtime.registration_loop(client).await })
        };
        let outbox = {
            let runtime = Arc::clone(self);
            tokio::spawn(async move { runtime.outbox_loop(client).await })
        };
        vec![register, outbox]
    }

    fn allowlist_snapshot(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .static_allowlist
            .iter()
            .cloned()
            .chain(crate::respond_allowlist_file::snapshot())
            .collect();
        keys.sort();
        keys.dedup();
        keys
    }

    async fn own_profile(&self) -> Option<Value> {
        let filter = nostr::Filter::new()
            .kind(nostr::Kind::Metadata)
            .author(self.keys.public_key())
            .limit(1);
        let json = tokio::time::timeout(Duration::from_secs(5), self.rest.query(&[filter]))
            .await
            .ok()?
            .ok()?;
        json.as_array()?.first().cloned()
    }

    async fn registration_loop(self: Arc<Self>, client: Arc<GuestRouteClient>) {
        loop {
            let allowlist = self.allowlist_snapshot();
            let wait = match self.own_profile().await {
                None => {
                    self.emit(
                        "guest_endpoint_status",
                        None,
                        json!({ "status": "profile_missing" }),
                    );
                    REGISTER_RETRY
                }
                Some(profile) => {
                    let display_name = profile
                        .get("content")
                        .and_then(Value::as_str)
                        .and_then(|c| serde_json::from_str::<Value>(c).ok())
                        .and_then(|c| {
                            c.get("display_name")
                                .or_else(|| c.get("name"))
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        });
                    let request = RegisterRequest {
                        community_id: client.community_id().to_string(),
                        relay_url: self.relay_url.clone(),
                        agent_profile_event: profile,
                        display_name,
                        respond_to: self.respond_to.to_string(),
                        allowlist_pubkeys: allowlist.clone(),
                        guest_instructions: self.guest_instructions.clone(),
                        harness_version: format!("buzz-acp {}", env!("CARGO_PKG_VERSION")),
                    };
                    match client.register(&request).await {
                        Ok(response) => {
                            tracing::info!(
                                status = %response.status,
                                classifier_mode = ?response.classifier_mode,
                                "guest endpoint registered"
                            );
                            self.emit(
                                "guest_endpoint_status",
                                None,
                                serde_json::to_value(&response).unwrap_or(Value::Null),
                            );
                            if let Ok(mut registration) = self.registration.write() {
                                *registration = Some(response);
                            }
                            REGISTER_REFRESH
                        }
                        Err(error) => {
                            tracing::warn!(%error, "guest endpoint registration failed");
                            self.emit(
                                "guest_endpoint_status",
                                None,
                                json!({ "status": "error", "error": error.code, "httpStatus": error.status }),
                            );
                            if error.is_retryable() {
                                REGISTER_RETRY
                            } else {
                                REGISTER_RETRY * 30
                            }
                        }
                    }
                }
            };
            let deadline = tokio::time::Instant::now() + wait;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep_until(deadline) => break,
                    _ = self.register_wake.notified() => break,
                    _ = tokio::time::sleep(POLICY_CHECK) => {
                        if self.allowlist_snapshot() != allowlist {
                            break;
                        }
                    }
                }
            }
        }
    }

    async fn outbox_loop(self: Arc<Self>, client: Arc<GuestRouteClient>) {
        let mut cursor: Option<String> = None;
        let mut published: HashMap<String, (Instant, Event)> = HashMap::new();
        let mut backoff = Duration::from_secs(1);
        loop {
            let page = tokio::select! {
                page = client.poll_outbox(cursor.as_deref(), 20, OUTBOX_WAIT_MS) => page,
                _ = self.outbox_wake.notified() => continue,
            };
            match page {
                Ok(page) => {
                    backoff = Duration::from_secs(1);
                    published.retain(|_, (at, _)| at.elapsed() < PUBLISHED_TTL);
                    let mut all_settled = true;
                    for item in page.items {
                        if !self.publish_item(&client, item, &mut published).await {
                            all_settled = false;
                        }
                    }
                    if all_settled {
                        if let Some(next) = page.next_cursor {
                            cursor = Some(next);
                        }
                    } else {
                        tokio::time::sleep(backoff).await;
                    }
                }
                Err(error) => {
                    let wait = if error.status == Some(403) {
                        REGISTER_RETRY
                    } else {
                        backoff
                    };
                    tracing::debug!(%error, "guest outbox poll failed");
                    backoff = (backoff * 2).min(Duration::from_secs(60));
                    tokio::time::sleep(wait).await;
                }
            }
        }
    }

    /// Publish one outbox item. Returns `false` when it should be retried
    /// later (transient failure); `true` once it is published, acked or
    /// definitively failed.
    async fn publish_item(
        &self,
        client: &GuestRouteClient,
        item: OutboxItem,
        published: &mut HashMap<String, (Instant, Event)>,
    ) -> bool {
        if let Some((_, event)) = published.get(&item.publication_id) {
            return client.ack(&item.publication_id, event).await.is_ok();
        }
        if outbox_item_expired(&item, chrono::Utc::now()) {
            let _ = client.fail(&item.publication_id, "expired", None).await;
            return true;
        }
        let mut agents: HashSet<String> = HashSet::new();
        for pubkey in item.mentions.iter().chain(
            item.tags
                .iter()
                .filter(|t| t.first().is_some_and(|n| n == "p"))
                .filter_map(|t| t.get(1)),
        ) {
            let pubkey = pubkey.to_ascii_lowercase();
            if pubkey == self.agent_pubkey
                || (is_hex64(&pubkey) && self.profiles.lookup(&pubkey, &self.rest).await.is_agent())
            {
                agents.insert(pubkey);
            }
        }
        let event = match build_outbox_event(&item, &agents, &self.keys) {
            Ok(event) => event,
            Err(detail) => {
                let _ = client
                    .fail(&item.publication_id, "other", Some(&detail))
                    .await;
                return true;
            }
        };
        let channel_id = Uuid::parse_str(&item.channel_id).ok();
        match tokio::time::timeout(NOTICE_TIMEOUT, self.rest.submit_event(&event)).await {
            Ok(Ok(response))
                if response.get("accepted").and_then(Value::as_bool) != Some(false) => {}
            Ok(Ok(response)) => {
                let detail = response
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("rejected")
                    .to_string();
                let _ = client
                    .fail(&item.publication_id, "relay_rejected", Some(&detail))
                    .await;
                self.emit_publication(&item, channel_id, None, "failed");
                return true;
            }
            Ok(Err(error)) if error.to_string().contains("HTTP 4") => {
                let _ = client
                    .fail(
                        &item.publication_id,
                        "relay_rejected",
                        Some(&error.to_string()),
                    )
                    .await;
                self.emit_publication(&item, channel_id, None, "failed");
                return true;
            }
            _ => return false,
        }
        published.insert(item.publication_id.clone(), (Instant::now(), event.clone()));
        // Output for a held turn means the owner decided (or the hold ended):
        // stop treating its request as pending, even if no control frame came.
        if let Some(turn) = &item.guest_turn_id {
            self.guards().resolve_pending(turn);
        }
        self.emit_publication(&item, channel_id, Some(&event), "published");
        if let Err(error) = client.ack(&item.publication_id, &event).await {
            tracing::warn!(%error, publication_id = %item.publication_id, "outbox ack failed");
        }
        true
    }

    fn emit_publication(
        &self,
        item: &OutboxItem,
        channel_id: Option<Uuid>,
        event: Option<&Event>,
        state: &str,
    ) {
        self.emit(
            "guest_publication",
            channel_id,
            json!({
                "publicationId": item.publication_id,
                "guestTurnId": item.guest_turn_id,
                "kind": item.kind,
                "state": state,
                "eventId": event.map(|e| e.id.to_hex()),
            }),
        );
    }
}

fn outbox_item_expired(item: &OutboxItem, now: chrono::DateTime<chrono::Utc>) -> bool {
    item.expires_at
        .as_deref()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .is_some_and(|at| at < now)
}

/// Build the kind:9 event for an outbox item: exact content, every item tag
/// except `p` tags naming agents, NIP-10 thread tags, and `p` tags for the
/// item's people mentions only (no agent fan-out).
pub(crate) fn build_outbox_event(
    item: &OutboxItem,
    agents: &HashSet<String>,
    keys: &Keys,
) -> Result<Event, String> {
    let channel_id = Uuid::parse_str(&item.channel_id).map_err(|e| format!("channel id: {e}"))?;
    let parse = |id: &str| EventId::from_hex(id).map_err(|e| format!("event id: {e}"));
    let thread_ref = match (&item.reply_to_event_id, &item.thread_root_event_id) {
        (Some(parent), root) => {
            let parent = parse(parent)?;
            let root = match root {
                Some(root) => parse(root)?,
                None => parent,
            };
            Some(buzz_sdk::ThreadRef {
                root_event_id: root,
                parent_event_id: parent,
            })
        }
        (None, _) => None,
    };
    let mentions: Vec<&str> = item
        .mentions
        .iter()
        .map(String::as_str)
        .filter(|p| is_hex64(p) && !agents.contains(&p.to_ascii_lowercase()))
        .collect();
    let tags: Vec<Vec<String>> = item
        .tags
        .iter()
        .filter(|tag| !tag.is_empty())
        .filter(|tag| {
            !(tag[0] == "p"
                && tag
                    .get(1)
                    .is_some_and(|p| agents.contains(&p.to_ascii_lowercase())))
        })
        .cloned()
        .collect();
    buzz_sdk::build_message_with_extra_tags(
        channel_id,
        &item.content,
        thread_ref.as_ref(),
        &mentions,
        false,
        &[],
        &tags,
    )
    .map_err(|e| e.to_string())?
    .sign_with_keys(keys)
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item() -> OutboxItem {
        OutboxItem {
            publication_id: "pub-1".into(),
            guest_turn_id: Some("turn-1".into()),
            kind: "answer".into(),
            channel_id: Uuid::nil().to_string(),
            reply_to_event_id: Some("a".repeat(64)),
            thread_root_event_id: None,
            content: "Exact text, untouched.  \n".into(),
            tags: vec![
                vec!["buzz-guest".into(), "b".repeat(64)],
                vec!["buzz-guest-turn".into(), "turn-1".into()],
                vec!["p".into(), "d".repeat(64)],
            ],
            mentions: vec!["b".repeat(64), "c".repeat(64)],
            expires_at: None,
        }
    }

    fn tag_values(event: &Event, name: &str) -> Vec<String> {
        event
            .tags
            .iter()
            .filter(|t| t.as_slice()[0] == name)
            .map(|t| t.as_slice()[1].clone())
            .collect()
    }

    #[test]
    fn outbox_event_is_exact_and_threaded() {
        let keys = Keys::generate();
        let event = build_outbox_event(&item(), &HashSet::new(), &keys).expect("event");
        buzz_core::verify_event(&event).expect("signed");
        assert_eq!(event.content, "Exact text, untouched.  \n");
        assert_eq!(event.pubkey, keys.public_key());
        assert_eq!(tag_values(&event, "h"), vec![Uuid::nil().to_string()]);
        assert_eq!(tag_values(&event, "buzz-guest"), vec!["b".repeat(64)]);
        assert_eq!(tag_values(&event, "buzz-guest-turn"), vec!["turn-1"]);
        let thread = parse_thread_tags(&event);
        assert_eq!(thread.root_event_id, Some("a".repeat(64)));
    }

    #[test]
    fn outbox_event_never_p_tags_agents() {
        let agents: HashSet<String> = ["c".repeat(64), "d".repeat(64)].into_iter().collect();
        let event = build_outbox_event(&item(), &agents, &Keys::generate()).expect("event");
        assert_eq!(tag_values(&event, "p"), vec!["b".repeat(64)]);
    }

    #[test]
    fn nested_reply_keeps_root_and_parent() {
        let mut nested = item();
        nested.thread_root_event_id = Some("e".repeat(64));
        let event = build_outbox_event(&nested, &HashSet::new(), &Keys::generate()).expect("event");
        let thread = parse_thread_tags(&event);
        assert_eq!(thread.root_event_id, Some("e".repeat(64)));
        assert_eq!(thread.parent_event_id, Some("a".repeat(64)));
    }

    #[test]
    fn bad_items_are_rejected_not_guessed() {
        let mut bad = item();
        bad.channel_id = "nope".into();
        assert!(build_outbox_event(&bad, &HashSet::new(), &Keys::generate()).is_err());
        let mut bad = item();
        bad.reply_to_event_id = Some("zz".into());
        assert!(build_outbox_event(&bad, &HashSet::new(), &Keys::generate()).is_err());
    }

    #[test]
    fn expiry_is_checked() {
        let now = chrono::Utc::now();
        let mut expired = item();
        expired.expires_at = Some((now - chrono::Duration::minutes(1)).to_rfc3339());
        assert!(outbox_item_expired(&expired, now));
        expired.expires_at = Some((now + chrono::Duration::minutes(1)).to_rfc3339());
        assert!(!outbox_item_expired(&expired, now));
        expired.expires_at = None;
        assert!(!outbox_item_expired(&expired, now));
    }
}

#[cfg(test)]
#[path = "guest_runtime_tests.rs"]
mod runtime_tests;

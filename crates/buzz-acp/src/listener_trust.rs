//! Cross-owner trust boundary for the normal listener.
//!
//! The inbound author gate answers "may this author fire a turn here?". This
//! module adds *who* is speaking (see [`crate::trust`]): owner-equivalent
//! authors run local turns; every crossing (another person, another owner's
//! agent, or guest text relayed by a sibling) is guarded and then either
//! handed to the hosted guest route ([`GuestTurns::Hosted`]) or, in legacy
//! local mode, admitted into its own guest lane. The lane becomes part of the
//! session key (`SessionScope::in_lane`), so an owner and a guest never share
//! a provider session, a batch, or a steer target.
//!
//! It also owns the listener's recipient-only invocation routing, self-event
//! filtering, member-scoped `!cancel`, the addressed-elsewhere gate, and DM
//! addressing (every DM message is addressed to the agent).

use std::sync::Arc;

use crate::config::Config;
use crate::filter::{self, SubscriptionRule};
use crate::guest_runtime::{self, GuestRuntime};
use crate::pool::{AgentPool, ControlSignal, PromptContext};
use crate::trust::{self, GateDecision, GuestTurns, TrustLane};
use crate::{
    dm_addressing, event_mentions_agent, is_owner_or_sibling, relay, scope,
    AuthorizedNormalListenerEvent, InboundAuthorGate, NormalListenerIngress, OwnerCache,
    KIND_STREAM_MESSAGE,
};

/// Everything the trust boundary reads for one listener event.
pub(crate) struct TrustEnv<'a> {
    pub(crate) config: &'a Config,
    pub(crate) owner_cache: &'a OwnerCache,
    pub(crate) ctx: &'a PromptContext,
    pub(crate) guest_runtime: &'a Arc<GuestRuntime>,
    pub(crate) rules: &'a [SubscriptionRule],
    /// `rules` without the mention requirement, for known DMs.
    pub(crate) dm_rules: &'a [SubscriptionRule],
    pub(crate) agent_pubkey_hex: &'a str,
}

/// An event admitted for a local turn.
pub(crate) struct LocalAdmission {
    pub(crate) ingress: NormalListenerIngress,
    /// Trust lane keyed into the event's session scope.
    pub(crate) lane: TrustLane,
    /// A structured wake: no lifecycle reactions, never steered.
    pub(crate) is_invocation: bool,
    /// A relayed person post: it queues its own turn and never steers or
    /// interrupts a running one.
    pub(crate) never_steers: bool,
}

fn is_invocation_event(event: &nostr::Event) -> bool {
    event.kind.as_u16() as u32 == buzz_core::kind::KIND_AGENT_INVOCATION
}

/// A structured wake that does not name exactly this channel and this agent
/// as its recipient. Such wakes are ignored before any other handling.
pub(crate) fn misrouted_invocation(buzz_event: &relay::BuzzEvent, agent_pubkey_hex: &str) -> bool {
    is_invocation_event(&buzz_event.event)
        && buzz_sdk::agent_invocation::invocation_route(&buzz_event.event).map_or(
            true,
            |(channel, recipient)| {
                channel != buzz_event.channel_id || recipient.to_hex() != agent_pubkey_hex
            },
        )
}

/// Self-authored events are ignored, except the agent's own opaque recovery
/// capability addressed to itself.
pub(crate) fn should_ignore_self_event(event: &nostr::Event, agent_pubkey_hex: &str) -> bool {
    // A hosted participant may deliver its own opaque recovery capability in a
    // private channel. Chat still cannot trigger itself; the signed wake keeps
    // exact recipient routing, normal author gates and runtime token consumption.
    event.pubkey.to_hex() == agent_pubkey_hex
        && buzz_sdk::agent_invocation::invocation_route(event).map_or(true, |(_, recipient)| {
            recipient.to_hex() != agent_pubkey_hex
        })
}

/// Tag that marks a call transcript line (`["buzz-call-line", <call id>,
/// <speaker kind>]`): a record of what was said on a call, posted as a thread
/// reply. It is never a prompt, so the listener skips it before any trust,
/// queue or subscription handling, whoever signed it and whatever it tags.
pub(crate) const CALL_LINE_TAG: &str = "buzz-call-line";

/// Whether an event is a call transcript line.
pub(crate) fn is_call_line_event(event: &nostr::Event) -> bool {
    event
        .tags
        .iter()
        .any(|tag| tag.as_slice().first().map(String::as_str) == Some(CALL_LINE_TAG))
}

/// Why the listener drops `event` before any trust, control-command, queue,
/// steering or subscription handling, whoever signed it and whatever it tags:
/// a call transcript line, or a quiet agent DM marker (mirrored history,
/// session divider, question state; `docs/agent-dm-markers.md`). Neither is
/// ever a prompt, so neither may start or steer a turn. `None` for anything
/// else.
///
/// A relayed person post ([`crate::agent_dm_markers::relayed_person_mirror`])
/// is not dropped here: it may start a turn, but only as a guest crossing
/// (`GuestRuntime::classify`), never steering, cancelling or controlling
/// (`admit`), with all agent-traffic guards (`check_guards`) and its text
/// wrapped as untrusted in the prompt (`queue::format_event_block_for_owner`).
pub(crate) fn non_prompt_event(event: &nostr::Event) -> Option<&'static str> {
    if is_call_line_event(event) {
        return Some("call transcript line");
    }
    if crate::agent_dm_markers::is_quiet_agent_dm_marker_event(event)
        && crate::agent_dm_markers::relayed_person_mirror(event).is_none()
    {
        return Some("quiet agent DM marker");
    }
    None
}

/// Whether `event` is a relayed person post (see [`non_prompt_event`]).
pub(crate) fn is_relayed_person_post(event: &nostr::Event) -> bool {
    crate::agent_dm_markers::relayed_person_mirror(event).is_some()
}

/// A non-owner channel stream message that `p`-tags (mentions) someone but
/// not this agent is addressed to them, so this agent must not take a turn on
/// it. Messages that mention nobody, owner messages, and DMs are unaffected.
fn addressed_to_someone_else(
    event: &nostr::Event,
    agent_pubkey_hex: &str,
    owner_pubkey_hex: Option<&str>,
    is_dm: bool,
) -> bool {
    !is_dm
        && event.kind.as_u16() as u32 == KIND_STREAM_MESSAGE
        && owner_pubkey_hex != Some(event.pubkey.to_hex().as_str())
        && event
            .tags
            .iter()
            .any(|t| t.as_slice().first().map(|s| s.as_str()) == Some("p"))
        && !event_mentions_agent(event, agent_pubkey_hex)
}

/// Send a control signal only to an in-flight turn in `scope`'s channel that
/// was triggered by an event from `author_pubkey`. This lets an authorized
/// member cancel their own turn without granting scope-wide cancellation
/// authority. The command's own scope is preferred.
fn signal_in_flight_task_for_author(
    pool: &mut AgentPool,
    scope: &scope::SessionScope,
    author_pubkey: &str,
    mode: ControlSignal,
) -> bool {
    let channel_id = scope.channel_id();
    let authored = |meta: &crate::pool::TaskMeta| {
        meta.channel_id == Some(channel_id)
            && meta.control_tx.is_some()
            && meta
                .prompt_author_pubkeys
                .iter()
                .any(|pubkey| pubkey == author_pubkey)
    };
    let exact = pool
        .task_map()
        .iter()
        .find(|(_, meta)| authored(meta) && meta.scope.as_ref() == Some(scope))
        .map(|(id, _)| *id);
    let task_id = exact.or_else(|| {
        pool.task_map()
            .iter()
            .find(|(_, meta)| authored(meta))
            .map(|(id, _)| *id)
    });
    let Some(tx) = task_id.and_then(|id| {
        pool.task_map_mut()
            .get_mut(&id)
            .and_then(|meta| meta.control_tx.take())
    }) else {
        return false;
    };
    tracing::info!(
        channel = %channel_id,
        author = %author_pubkey,
        ?mode,
        "author-scoped control signal sent to in-flight task"
    );
    let _ = tx.send(mode);
    true
}

/// The owner's `!cancel` covers every trust lane of its conversation: the
/// owner-lane scope first, then guest lanes of the same channel thread (or
/// channel conversation). Guests are never given that authority.
pub(crate) fn signal_owner_cancel(
    pool: &mut AgentPool,
    scope: &scope::SessionScope,
    mode: ControlSignal,
) -> bool {
    if crate::signal_in_flight_task_for_scope(pool, scope, mode.clone()) {
        return true;
    }
    let lanes: Vec<scope::SessionScope> = pool
        .task_map()
        .values()
        .filter_map(|meta| meta.scope.clone())
        .filter(|candidate| {
            matches!(candidate, scope::SessionScope::Guest { .. })
                && candidate.channel_id() == scope.channel_id()
                && candidate.root_event_id() == scope.root_event_id()
        })
        .collect();
    let mut fired = false;
    for lane in lanes {
        fired |= crate::signal_in_flight_task_for_scope(pool, &lane, mode.clone());
    }
    fired
}

/// Apply the trust boundary to one normal-listener event. `None` means the
/// event was handled here (dropped, routed to the guest runtime, or consumed
/// as a member `!cancel`); `Some` admits it for a local turn in its lane.
pub(crate) async fn admit(
    gate: &mut InboundAuthorGate,
    buzz_event: relay::BuzzEvent,
    env: &TrustEnv<'_>,
    pool: &mut AgentPool,
    is_cancel: bool,
) -> Option<LocalAdmission> {
    let config = env.config;
    let ctx = env.ctx;
    let is_invocation = is_invocation_event(&buzz_event.event);
    let relayed = is_relayed_person_post(&buzz_event.event);
    if relayed && is_cancel {
        // Relayed text is never a control command, whoever signed it.
        tracing::debug!(
            channel_id = %buzz_event.channel_id,
            "relayed person post carrying a control command — dropping"
        );
        return None;
    }
    let screen = gate
        .screen_listener_event(
            buzz_event,
            &config.respond_to,
            &config.respond_to_allowlist,
            env.owner_cache,
            &ctx.channel_info,
            &ctx.rest_client,
        )
        .await;
    let allowed = screen.is_admitted();
    let is_dm = screen.is_dm();
    let mode = env.guest_runtime.mode();
    let decision = if !allowed && mode == GuestTurns::Local {
        GateDecision::Drop
    } else {
        let owner_or_sibling =
            is_owner_or_sibling(screen.effective_author(), env.owner_cache, &ctx.rest_client).await;
        let tier = env
            .guest_runtime
            .classify(&screen.event().event, owner_or_sibling)
            .await;
        if is_invocation && !tier.is_owner_equivalent() {
            // Structured wakes are never routed: local only under the
            // legacy gate.
            if allowed && mode == GuestTurns::Local {
                GateDecision::Local(tier)
            } else {
                GateDecision::Drop
            }
        } else {
            trust::decide(mode, &config.respond_to, tier, allowed)
        }
    };
    if decision == GateDecision::Drop {
        // INFO, not debug: under owner-only fleets a dropped event is the
        // whole story of "the agent never answered".
        tracing::info!(
            channel_id = %screen.event().channel_id,
            raw_author = %screen.event().event.pubkey.to_hex(),
            effective_author = %screen.effective_author(),
            mode = %config.respond_to,
            is_dm,
            "inbound author gate — dropping event"
        );
        return None;
    }

    let channel_id = screen.event().channel_id;
    if is_cancel {
        let event = &screen.event().event;
        let author = event.pubkey.to_hex();
        let scope = scope::SessionScope::derive(config.session_policy, channel_id, is_dm, event);
        let fired = signal_in_flight_task_for_author(
            pool,
            &scope,
            &author,
            ControlSignal::UserCancel {
                actor_public_key: author.clone(),
                request_event_id: event.id.to_hex(),
            },
        );
        if !fired {
            tracing::warn!(
                channel_id = %channel_id,
                author = %author,
                "!cancel received but no in-flight turn from this author — no-op"
            );
        }
        return None; // consume control event; never queue as a prompt
    }

    // Addressed-elsewhere gate: in a channel, a non-owner message that
    // @mentions others but not this agent is not for this agent, even when
    // its subscription does not require a mention.
    if addressed_to_someone_else(
        &screen.event().event,
        env.agent_pubkey_hex,
        env.owner_cache.get(),
        is_dm,
    ) {
        tracing::debug!(
            channel_id = %channel_id,
            author = %screen.event().event.pubkey.to_hex(),
            "message mentions other participants only — dropping"
        );
        return None;
    }

    // In a known DM every message is addressed to the agent, whether or not
    // the client p-tagged it.
    let rules = if is_dm && dm_addressing::is_known_dm(channel_id, &ctx.channel_info).await {
        env.dm_rules
    } else {
        env.rules
    };

    match decision {
        GateDecision::Drop => None,
        GateDecision::Route(tier) => {
            let buzz_event = screen.into_event();
            filter::match_event(&buzz_event.event, channel_id, rules, env.agent_pubkey_hex).await?;
            let request_key = guard(env.guest_runtime, &buzz_event.event, channel_id, &tier)?;
            let channel_name = ctx
                .channel_info
                .resolve_channel_metadata(channel_id)
                .await
                .map(|info| info.name);
            env.guest_runtime.route(
                buzz_event.event,
                channel_id,
                is_dm,
                channel_name,
                tier,
                request_key,
            );
            None
        }
        GateDecision::Local(tier) => {
            // `Local` implies the raw-author gate admitted the event.
            let authorized = screen.into_authorized()?;
            let Some(ingress) = AuthorizedNormalListenerEvent(authorized)
                .match_subscription(rules, env.agent_pubkey_hex)
                .await
            else {
                tracing::debug!("authorized event matched no rule — dropping");
                return None;
            };
            // Agent guards also apply to sibling (local) turns.
            guard(
                env.guest_runtime,
                &ingress.buzz_event.event,
                channel_id,
                &tier,
            )?;
            Some(LocalAdmission {
                ingress,
                lane: tier.lane(),
                is_invocation,
                never_steers: relayed,
            })
        }
    }
}

/// Run the agent-traffic guards. `None` drops the event (sending the pair
/// rate-limit notice when that guard fired); `Some` carries the dedup key.
fn guard(
    runtime: &Arc<GuestRuntime>,
    event: &nostr::Event,
    channel_id: uuid::Uuid,
    tier: &trust::TrustTier,
) -> Option<Option<String>> {
    match runtime.check_guards(&guest_runtime::GuardInput {
        event,
        channel_id,
        tier,
    }) {
        guest_runtime::GuardVerdict::Proceed { request_key } => Some(request_key),
        guest_runtime::GuardVerdict::Drop { guard } => {
            if guard == "pair_rate_limit_notice" {
                runtime.spawn_pair_limit_notice(event, channel_id, tier);
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn make_event(kind: u32, content: &str, p_hex: Option<&str>) -> nostr::Event {
        let tags: Vec<Tag> = p_hex
            .map(|p| vec![Tag::parse(["p", p]).unwrap()])
            .unwrap_or_default();
        EventBuilder::new(Kind::Custom(kind as u16), content)
            .tags(tags)
            .sign_with_keys(&Keys::generate())
            .unwrap()
    }

    #[test]
    fn self_invocation_recovery_does_not_enable_self_chat_or_foreign_recipient_wakes() {
        let agent = Keys::generate();
        let channel = uuid::Uuid::new_v4();
        let own = agent.public_key().to_hex();
        let wake = buzz_sdk::agent_invocation::build_agent_invocation(
            channel,
            agent.public_key(),
            &"a".repeat(43),
        )
        .unwrap()
        .sign_with_keys(&agent)
        .unwrap();
        assert_eq!(
            buzz_sdk::agent_invocation::invocation_route(&wake).unwrap(),
            (channel, agent.public_key())
        );
        assert!(!should_ignore_self_event(&wake, &own));
        let routed = relay::BuzzEvent {
            connection_generation: 0,
            channel_id: channel,
            event: wake.clone(),
        };
        assert!(!misrouted_invocation(&routed, &own));
        let elsewhere = relay::BuzzEvent {
            channel_id: uuid::Uuid::new_v4(),
            ..routed
        };
        assert!(misrouted_invocation(&elsewhere, &own));
        let other = buzz_sdk::agent_invocation::build_agent_invocation(
            channel,
            Keys::generate().public_key(),
            &"a".repeat(43),
        )
        .unwrap()
        .sign_with_keys(&agent)
        .unwrap();
        assert!(should_ignore_self_event(&other, &own));
        for kind in [9, 24201] {
            let malformed = EventBuilder::new(Kind::Custom(kind), "ordinary answer")
                .tags([Tag::public_key(agent.public_key())])
                .sign_with_keys(&agent)
                .unwrap();
            assert!(should_ignore_self_event(&malformed, &own));
        }
    }

    #[test]
    fn message_mentioning_only_others_is_addressed_elsewhere() {
        let me = "ab".repeat(32);
        let other_agent = "cd".repeat(32);

        let to_other = make_event(
            KIND_STREAM_MESSAGE,
            "@Marlowe your turn",
            Some(&other_agent),
        );
        assert!(addressed_to_someone_else(&to_other, &me, None, false));

        // Mentioning this agent (alone or alongside others) is for this agent.
        let to_me = make_event(KIND_STREAM_MESSAGE, "@Juniper", Some(&me));
        assert!(!addressed_to_someone_else(&to_me, &me, None, false));
        let both = EventBuilder::new(Kind::Custom(KIND_STREAM_MESSAGE as u16), "@both")
            .tags([
                Tag::parse(["p", &other_agent]).unwrap(),
                Tag::parse(["p", &me]).unwrap(),
            ])
            .sign_with_keys(&Keys::generate())
            .unwrap();
        assert!(!addressed_to_someone_else(&both, &me, None, false));

        // Messages that mention nobody keep current behavior.
        let nobody = make_event(KIND_STREAM_MESSAGE, "status update", None);
        assert!(!addressed_to_someone_else(&nobody, &me, None, false));

        // The owner, DMs, and non-chat kinds are exempt.
        let owner = to_other.pubkey.to_hex();
        assert!(!addressed_to_someone_else(
            &to_other,
            &me,
            Some(&owner),
            false
        ));
        assert!(!addressed_to_someone_else(&to_other, &me, None, true));
        let approval = make_event(46010, "approve", Some(&other_agent));
        assert!(!addressed_to_someone_else(&approval, &me, None, false));
    }

    #[tokio::test]
    async fn owner_cancel_reaches_guest_lanes_of_the_same_conversation_only() {
        let mut pool = AgentPool::from_slots(vec![]);
        let channel_id = uuid::Uuid::new_v4();
        let owner_scope = scope::SessionScope::Conversation { channel_id };
        let guest_scope = owner_scope
            .clone()
            .in_lane(&TrustLane::Guest("guest".into()));
        let other_channel = scope::SessionScope::Conversation {
            channel_id: uuid::Uuid::new_v4(),
        }
        .in_lane(&TrustLane::Guest("guest".into()));
        let mut receivers = Vec::new();
        for (index, scope) in [guest_scope, other_channel].into_iter().enumerate() {
            let (control_tx, control_rx) = tokio::sync::oneshot::channel();
            receivers.push(control_rx);
            let abort_handle = pool.join_set.spawn(async {});
            pool.task_map_mut().insert(
                abort_handle.id(),
                crate::pool::TaskMeta {
                    agent_index: index,
                    channel_id: Some(scope.channel_id()),
                    scope: Some(scope),
                    prompt_author_pubkeys: vec!["guest".to_string()],
                    turn_id: format!("turn-{index}"),
                    recoverable_batch: None,
                    control_tx: Some(control_tx),
                    steer_tx: None,
                    successful_steer_deliveries: std::collections::HashSet::new(),
                },
            );
        }
        assert!(signal_owner_cancel(
            &mut pool,
            &owner_scope,
            ControlSignal::Cancel
        ));
        let mut receivers = receivers.into_iter();
        assert_eq!(
            receivers.next().unwrap().await.unwrap(),
            ControlSignal::Cancel
        );
        assert!(
            receivers.next().unwrap().try_recv().is_err(),
            "another channel's guest lane is untouched"
        );
    }

    #[tokio::test]
    async fn author_scoped_cancel_only_signals_the_triggering_author() {
        let mut pool = AgentPool::from_slots(vec![]);
        let channel_id = uuid::Uuid::new_v4();
        let scope = scope::SessionScope::Conversation { channel_id };
        let (control_tx, control_rx) = tokio::sync::oneshot::channel();
        let abort_handle = pool.join_set.spawn(async {});
        pool.task_map_mut().insert(
            abort_handle.id(),
            crate::pool::TaskMeta {
                agent_index: 0,
                channel_id: Some(channel_id),
                scope: Some(scope.clone()),
                prompt_author_pubkeys: vec!["author-a".to_string()],
                turn_id: "author-scoped-turn".to_string(),
                recoverable_batch: None,
                control_tx: Some(control_tx),
                steer_tx: None,
                successful_steer_deliveries: std::collections::HashSet::new(),
            },
        );

        assert!(
            !signal_in_flight_task_for_author(&mut pool, &scope, "author-b", ControlSignal::Cancel),
            "another authorized member must not cancel this author's turn"
        );
        assert!(signal_in_flight_task_for_author(
            &mut pool,
            &scope,
            "author-a",
            ControlSignal::Cancel
        ));
        assert_eq!(control_rx.await.unwrap(), ControlSignal::Cancel);
        assert!(!signal_in_flight_task_for_author(
            &mut pool,
            &scope,
            "author-a",
            ControlSignal::Cancel
        ));
    }

    #[test]
    fn call_transcript_lines_are_recognized_and_nothing_else() {
        let keys = Keys::generate();
        let line = EventBuilder::new(Kind::Custom(9), "spoken words")
            .tags([
                Tag::parse(["e", "a".repeat(64).as_str(), "", "root"]).unwrap(),
                Tag::parse([CALL_LINE_TAG, "call-1", "agent"]).unwrap(),
            ])
            .sign_with_keys(&keys)
            .unwrap();
        assert!(is_call_line_event(&line));

        // Even one that tags this agent is a transcript line, never a prompt.
        let mentioned = EventBuilder::new(Kind::Custom(9), "spoken words")
            .tags([
                Tag::parse([CALL_LINE_TAG, "call-1", "human"]).unwrap(),
                Tag::parse(["p", keys.public_key().to_hex().as_str()]).unwrap(),
            ])
            .sign_with_keys(&keys)
            .unwrap();
        assert!(is_call_line_event(&mentioned));

        let message = EventBuilder::new(Kind::Custom(9), "buzz-call-line")
            .tags([Tag::parse(["t", CALL_LINE_TAG]).unwrap()])
            .sign_with_keys(&keys)
            .unwrap();
        assert!(!is_call_line_event(&message));
    }

    #[test]
    fn listener_drops_quiet_markers_before_any_turn_handling() {
        let agent = Keys::generate();
        let requester = Keys::generate();
        let agent_hex = agent.public_key().to_hex();
        let requester_hex = requester.public_key().to_hex();
        let build = |keys: &Keys, kind: u16, content: &str, marker: Option<Vec<&str>>| {
            let mut tags = vec![
                Tag::parse(["h", "c"]).unwrap(),
                // Mentions the agent, so it would otherwise be a prompt.
                Tag::parse(["p", agent_hex.as_str()]).unwrap(),
            ];
            if let Some(marker) = marker {
                tags.push(Tag::parse(marker).unwrap());
            }
            EventBuilder::new(Kind::Custom(kind), content)
                .tags(tags)
                .sign_with_keys(keys)
                .unwrap()
        };
        let mirror = || Some(vec!["buzz-mirror", "tasks", "t1", "1"]);
        let author = || {
            Some(vec![
                "buzz-mirror-author",
                "requester",
                requester_hex.as_str(),
                "",
            ])
        };
        for keys in [&agent, &requester] {
            for kind in [9u16, 40002] {
                // Including a control command's text: a marker never cancels,
                // rotates or steers.
                for content in ["please do it", "!cancel"] {
                    for marker in [mirror(), author()] {
                        assert_eq!(
                            non_prompt_event(&build(keys, kind, content, marker)),
                            Some("quiet agent DM marker")
                        );
                    }
                }
            }
        }
        assert_eq!(
            non_prompt_event(&build(&requester, 9, "please do it", None)),
            None
        );
        let line = build(
            &requester,
            9,
            "spoken",
            Some(vec![CALL_LINE_TAG, "call-1", "human"]),
        );
        assert_eq!(non_prompt_event(&line), Some("call transcript line"));

        // A relayed person post (kind 9, both mirror tags, requester role) is
        // the one marker-tagged event that reaches the trust gate; the same
        // tags on 40002 stay quiet.
        let relayed = |kind: u16| {
            let mut tags = vec![
                Tag::parse(["h", "c"]).unwrap(),
                Tag::parse(["p", agent_hex.as_str()]).unwrap(),
            ];
            tags.push(Tag::parse(["buzz-mirror", "tasks", "t1", "1"]).unwrap());
            tags.push(
                Tag::parse([
                    "buzz-mirror-author",
                    "requester",
                    requester_hex.as_str(),
                    "",
                ])
                .unwrap(),
            );
            EventBuilder::new(Kind::Custom(kind), "please do it")
                .tags(tags)
                .sign_with_keys(&agent)
                .unwrap()
        };
        assert_eq!(non_prompt_event(&relayed(9)), None);
        assert!(is_relayed_person_post(&relayed(9)));
        assert_eq!(
            non_prompt_event(&relayed(40002)),
            Some("quiet agent DM marker")
        );
    }
}

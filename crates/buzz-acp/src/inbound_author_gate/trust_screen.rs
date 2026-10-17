//! Fork extensions to the inbound author gate, kept beside the gate so they
//! share its private capability types instead of widening them.
//!
//! - Allowlist mode also admits the hot-reloaded respond-to allowlist file.
//! - Opt-in `BUZZ_ACP_ALLOWLIST_IN_DMS`: an allowlisted author may fire a turn
//!   in a DM only when every DM participant is trusted (see
//!   [`DmAllowlistGate`]). Unresolvable rosters fail closed.
//! - [`ListenerScreen`]: the normal listener's cross-owner trust tier needs
//!   the verdict *and* the event, because a hosted runtime hands non-owner
//!   events to the guest route. A denied event can never become an
//!   [`AuthorizedListenerEvent`], so it can never reach a local session.

use std::collections::HashSet;

use super::{AuthorizedListenerEvent, InboundAuthorGate, InboundAuthorGateDecision};
use crate::dm_participants::{DmAllowlistGate, DmParticipantResolver};
use crate::{pool, relay, OwnerCache, RespondTo};

/// The gate's verdict for one normal-listener event, with the event.
pub(crate) struct ListenerScreen {
    verdict: Verdict,
    is_dm: bool,
}

enum Verdict {
    Admitted(AuthorizedListenerEvent),
    Denied {
        buzz_event: relay::BuzzEvent,
        effective_author: String,
    },
}

impl ListenerScreen {
    /// Whether the raw-author policy admitted the event.
    pub(crate) fn is_admitted(&self) -> bool {
        matches!(self.verdict, Verdict::Admitted(_))
    }

    /// The listener's DM classification (unresolved counts as a DM).
    pub(crate) fn is_dm(&self) -> bool {
        self.is_dm
    }

    /// The screened event.
    pub(crate) fn event(&self) -> &relay::BuzzEvent {
        match &self.verdict {
            Verdict::Admitted(authorized) => &authorized.buzz_event,
            Verdict::Denied { buzz_event, .. } => buzz_event,
        }
    }

    /// The author principal after trusted workflow attribution.
    pub(crate) fn effective_author(&self) -> &str {
        match &self.verdict {
            Verdict::Admitted(authorized) => &authorized.effective_author,
            Verdict::Denied {
                effective_author, ..
            } => effective_author,
        }
    }

    /// The local-turn capability, only when the gate admitted the event.
    pub(crate) fn into_authorized(self) -> Option<AuthorizedListenerEvent> {
        match self.verdict {
            Verdict::Admitted(authorized) => Some(authorized),
            Verdict::Denied { .. } => None,
        }
    }

    /// The raw event, for the hosted guest route only.
    pub(crate) fn into_event(self) -> relay::BuzzEvent {
        match self.verdict {
            Verdict::Admitted(authorized) => authorized.buzz_event,
            Verdict::Denied { buzz_event, .. } => buzz_event,
        }
    }
}

impl InboundAuthorGate {
    /// Enable the opt-in allowlist-in-DMs roster check (`None` keeps the
    /// default DM hardening).
    pub(crate) fn with_dm_allowlist(mut self, resolver: Option<DmParticipantResolver>) -> Self {
        self.dm_allowlist = resolver;
        self
    }

    /// Apply the fork's allowlist extensions to a denied decision. Only ever
    /// widens `allowlist` mode for listed authors; never touches other modes.
    pub(super) async fn widen_decision(
        &self,
        decision: &mut InboundAuthorGateDecision,
        buzz_event: &relay::BuzzEvent,
        respond_to: &RespondTo,
        allowlist: &HashSet<String>,
        owner_cache: &OwnerCache,
        rest_client: &relay::RestClient,
    ) {
        if decision.allowed || *respond_to != RespondTo::Allowlist {
            return;
        }
        let is_listed =
            |pk: &str| allowlist.contains(pk) || crate::respond_allowlist_file::contains(pk);
        let author = decision.effective_author.as_str();
        if !is_listed(author) {
            return;
        }
        if !decision.is_dm {
            decision.allowed = true;
            return;
        }
        let Some(participants) = self.dm_allowlist.as_ref() else {
            return;
        };
        let gate = DmAllowlistGate {
            channel_id: buzz_event.channel_id,
            agent_pubkey: &self.agent_pubkey_hex,
            participants,
        };
        decision.allowed = gate
            .all_participants_trusted(author, &is_listed, owner_cache, rest_client)
            .await;
    }

    /// Screen one normal-listener event, keeping a denied event available to
    /// the cross-owner trust tier (hosted guest route) without admitting it.
    pub(crate) async fn screen_listener_event(
        &mut self,
        buzz_event: relay::BuzzEvent,
        respond_to: &RespondTo,
        allowlist: &HashSet<String>,
        owner_cache: &OwnerCache,
        channel_info: &pool::ChannelInfoResolver,
        rest_client: &relay::RestClient,
    ) -> ListenerScreen {
        let decision = self
            .evaluate_listener_event(
                &buzz_event,
                respond_to,
                allowlist,
                owner_cache,
                channel_info,
                rest_client,
            )
            .await;
        let verdict = if decision.allowed {
            Verdict::Admitted(AuthorizedListenerEvent {
                buzz_event,
                effective_author: decision.effective_author,
            })
        } else {
            tracing::debug!(
                channel_id = %buzz_event.channel_id,
                raw_author = %buzz_event.event.pubkey.to_hex(),
                effective_author = %decision.effective_author,
                mode = %respond_to,
                is_dm = decision.is_dm,
                "inbound author gate — not admitted locally; trust tier decides"
            );
            Verdict::Denied {
                buzz_event,
                effective_author: decision.effective_author,
            }
        };
        ListenerScreen {
            verdict,
            is_dm: decision.is_dm,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    const OWNER: &str = "11";
    const SIBLING: &str = "22";
    const EXTERNAL: &str = "33";
    const EXTERNAL_2: &str = "44";
    const STRANGER: &str = "55";
    const AGENT: &str = "aa";

    fn dummy_rest_client() -> relay::RestClient {
        relay::RestClient {
            http: reqwest::Client::new(),
            base_url: "http://127.0.0.1:1".into(),
            keys: nostr::Keys::generate(),
            auth_tag_json: None,
        }
    }

    fn cache() -> OwnerCache {
        let cache = OwnerCache::new(Some(OWNER.into()));
        cache.cache_sibling(SIBLING.into(), true);
        for other in [EXTERNAL, EXTERNAL_2, STRANGER] {
            cache.cache_sibling(other.into(), false);
        }
        cache
    }

    fn event_in(channel_id: Uuid) -> relay::BuzzEvent {
        relay::BuzzEvent {
            connection_generation: 0,
            channel_id,
            event: nostr::EventBuilder::new(nostr::Kind::Custom(9), "hi")
                .sign_with_keys(&nostr::Keys::generate())
                .unwrap(),
        }
    }

    /// Run the production widening for a decision the upstream policy denied.
    async fn widened(
        mode: RespondTo,
        author: &str,
        is_dm: bool,
        roster: Option<&[&str]>,
        enabled: bool,
    ) -> bool {
        let rest = dummy_rest_client();
        let channel_id = Uuid::new_v4();
        let resolver = DmParticipantResolver::new(rest.clone());
        if let Some(roster) = roster {
            resolver.seed(channel_id, roster);
        }
        let mut gate = InboundAuthorGate {
            agent_pubkey_hex: AGENT.into(),
            relay_self: None,
            refreshed_generation: Some(0),
            dm_allowlist: None,
        };
        if enabled {
            gate = gate.with_dm_allowlist(Some(resolver));
        }
        let allowlist = HashSet::from([EXTERNAL.to_string(), EXTERNAL_2.to_string()]);
        let cache = cache();
        let mut decision = InboundAuthorGateDecision {
            effective_author: author.into(),
            allowed: false,
            is_dm,
        };
        gate.widen_decision(
            &mut decision,
            &event_in(channel_id),
            &mode,
            &allowlist,
            &cache,
            &rest,
        )
        .await;
        decision.allowed
    }

    #[tokio::test]
    async fn dm_allowlist_disabled_keeps_rejecting_allowlisted_author() {
        assert!(
            !widened(
                RespondTo::Allowlist,
                EXTERNAL,
                true,
                Some(&[AGENT, EXTERNAL]),
                false
            )
            .await
        );
    }

    #[tokio::test]
    async fn dm_allowlist_admits_author_in_all_trusted_dm() {
        assert!(
            widened(
                RespondTo::Allowlist,
                EXTERNAL,
                true,
                Some(&[AGENT, EXTERNAL]),
                true
            )
            .await
        );
        assert!(
            widened(
                RespondTo::Allowlist,
                EXTERNAL,
                true,
                Some(&[AGENT, EXTERNAL, EXTERNAL_2, OWNER, SIBLING]),
                true
            )
            .await
        );
    }

    #[tokio::test]
    async fn dm_allowlist_rejects_untrusted_third_party_unlisted_author_and_unresolved_roster() {
        assert!(
            !widened(
                RespondTo::Allowlist,
                EXTERNAL,
                true,
                Some(&[AGENT, EXTERNAL, STRANGER]),
                true
            )
            .await
        );
        assert!(
            !widened(
                RespondTo::Allowlist,
                STRANGER,
                true,
                Some(&[AGENT, STRANGER]),
                true
            )
            .await
        );
        assert!(!widened(RespondTo::Allowlist, EXTERNAL, true, None, true).await);
        assert!(
            !widened(
                RespondTo::Allowlist,
                EXTERNAL,
                true,
                Some(&[AGENT, EXTERNAL_2]),
                true
            )
            .await
        );
    }

    #[tokio::test]
    async fn dm_allowlist_never_widens_other_modes() {
        for mode in [RespondTo::Anyone, RespondTo::OwnerOnly, RespondTo::Nobody] {
            assert!(!widened(mode.clone(), EXTERNAL, true, Some(&[AGENT, EXTERNAL]), true).await);
            assert!(!widened(mode, EXTERNAL, false, None, true).await);
        }
    }

    #[tokio::test]
    async fn channel_widening_admits_only_listed_authors() {
        assert!(widened(RespondTo::Allowlist, EXTERNAL, false, None, false).await);
        assert!(!widened(RespondTo::Allowlist, STRANGER, false, None, true).await);
    }
}

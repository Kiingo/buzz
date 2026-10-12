//! Direct messages are addressed to every participant.
//!
//! In a DM the only reason to post is to talk to the other participants, so
//! a message in a DM the agent belongs to is addressed to the agent whether or
//! not the sending client added a `p` tag. The desktop app already p-tags every
//! DM participant; other clients (mobile, the CLI) may not. Without this, a DM
//! from those clients was never even delivered: the channel subscription
//! carries a `#p` filter when rules require a mention, and the rule match then
//! drops anything without one.
//!
//! Only channels positively known to be DMs (relay metadata `dm`) are treated
//! this way. Every later gate still applies: the author/trust gate, guest
//! routing, relay hop limits, rate limits, dedup and echo suppression.

use std::collections::HashSet;

use uuid::Uuid;

use crate::config::ChannelFilter;
use crate::filter::SubscriptionRule;
use crate::pool::ChannelInfoResolver;

/// The same rules with the mention requirement lifted, for events in known
/// DM channels. Channel scope, kinds and filter expressions are unchanged.
pub(crate) fn dm_rules(rules: &[SubscriptionRule]) -> Vec<SubscriptionRule> {
    rules
        .iter()
        .map(|rule| {
            let mut rule = rule.clone();
            rule.require_mention = false;
            rule
        })
        .collect()
}

/// Drop the relay-side `#p` filter for a known DM so untagged DMs arrive.
pub(crate) fn widen_for_dm(filter: &mut ChannelFilter, is_known_dm: bool) {
    if is_known_dm {
        filter.require_mention = false;
    }
}

/// Channels the startup discovery reports as DMs.
pub(crate) fn known_dms<'a>(
    channel_types: impl IntoIterator<Item = (&'a Uuid, &'a str)>,
) -> HashSet<Uuid> {
    channel_types
        .into_iter()
        .filter(|(_, kind)| *kind == "dm")
        .map(|(id, _)| *id)
        .collect()
}

/// Whether `channel_id` is positively known to be a DM. Unlike the author
/// gate's fail-closed check, an unresolved channel is NOT treated as a DM here:
/// that would widen what reaches the agent.
pub(crate) async fn is_known_dm(channel_id: Uuid, channel_info: &ChannelInfoResolver) -> bool {
    channel_info
        .resolve_channel_metadata(channel_id)
        .await
        .is_some_and(|info| info.channel_type == "dm")
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn mention_rule() -> SubscriptionRule {
        SubscriptionRule {
            name: "mentions".into(),
            kinds: vec![9],
            require_mention: true,
            prompt_tag: Some("@mention".into()),
            ..SubscriptionRule::default()
        }
    }

    fn message(channel: Uuid, tags: Vec<Tag>) -> nostr::Event {
        let mut all = vec![Tag::parse(["h", &channel.to_string()]).unwrap()];
        all.extend(tags);
        EventBuilder::new(Kind::Custom(9), "hi there")
            .tags(all)
            .sign_with_keys(&Keys::generate())
            .unwrap()
    }

    #[tokio::test]
    async fn untagged_dm_matches_only_under_dm_rules() {
        let agent = Keys::generate().public_key().to_hex();
        let channel = Uuid::new_v4();
        let rules = vec![mention_rule()];
        let untagged = message(channel, vec![]);
        assert!(
            crate::filter::match_event(&untagged, channel, &rules, &agent)
                .await
                .is_none(),
            "a channel message without a mention still needs one"
        );
        let dm = dm_rules(&rules);
        let matched = crate::filter::match_event(&untagged, channel, &dm, &agent)
            .await
            .expect("a DM is addressed to the agent");
        assert_eq!(matched.prompt_tag, "@mention");
    }

    #[tokio::test]
    async fn dm_rules_keep_kind_and_scope_limits() {
        let agent = Keys::generate().public_key().to_hex();
        let channel = Uuid::new_v4();
        let dm = dm_rules(&[mention_rule()]);
        let reaction = EventBuilder::new(Kind::Custom(7), "+")
            .tags([Tag::parse(["h", &channel.to_string()]).unwrap()])
            .sign_with_keys(&Keys::generate())
            .unwrap();
        assert!(
            crate::filter::match_event(&reaction, channel, &dm, &agent)
                .await
                .is_none(),
            "kinds still constrain"
        );
    }

    #[test]
    fn only_known_dms_widen_the_subscription() {
        let mut filter = ChannelFilter {
            kinds: Some(vec![9]),
            require_mention: true,
        };
        widen_for_dm(&mut filter, false);
        assert!(filter.require_mention);
        widen_for_dm(&mut filter, true);
        assert!(!filter.require_mention);
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let dms = known_dms([(&a, "dm"), (&b, "stream")]);
        assert!(dms.contains(&a) && !dms.contains(&b));
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(super) enum ChannelMembershipTransition {
    Ready,
    /// Add the replacement or upsert its role to the predecessor's exact role.
    /// The still-authoritative owner signs this transition before revocation.
    ReconcileReplacement(String),
}

pub(super) fn channel_membership_transition(
    source_role: &str,
    replacement_role: Option<&str>,
) -> ChannelMembershipTransition {
    match replacement_role {
        Some(replacement) if replacement == source_role => ChannelMembershipTransition::Ready,
        Some(_) | None => {
            ChannelMembershipTransition::ReconcileReplacement(source_role.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cutover_reconciles_late_roles_before_revocation() {
        assert_eq!(
            channel_membership_transition("owner", None),
            ChannelMembershipTransition::ReconcileReplacement("owner".into())
        );
        assert_eq!(
            channel_membership_transition("bot", Some("bot")),
            ChannelMembershipTransition::Ready
        );
        assert_eq!(
            channel_membership_transition("owner", Some("member")),
            ChannelMembershipTransition::ReconcileReplacement("owner".into())
        );
        assert_eq!(
            channel_membership_transition("bot", Some("member")),
            ChannelMembershipTransition::ReconcileReplacement("bot".into())
        );
    }
}

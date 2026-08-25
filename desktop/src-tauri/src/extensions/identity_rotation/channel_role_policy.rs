#[derive(Debug, Eq, PartialEq)]
pub(super) enum ChannelMembershipTransition {
    Ready,
    AddReplacement(String),
}

pub(super) fn channel_membership_transition(
    source_role: &str,
    replacement_role: Option<&str>,
) -> Result<ChannelMembershipTransition, String> {
    match replacement_role {
        Some(replacement) if replacement == source_role => Ok(ChannelMembershipTransition::Ready),
        Some(_) => Err("identity_rotation_channel_membership_role_conflict".into()),
        None => Ok(ChannelMembershipTransition::AddReplacement(
            source_role.to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cutover_reconciles_late_roles_before_revocation() {
        assert_eq!(
            channel_membership_transition("owner", None).unwrap(),
            ChannelMembershipTransition::AddReplacement("owner".into())
        );
        assert_eq!(
            channel_membership_transition("bot", Some("bot")).unwrap(),
            ChannelMembershipTransition::Ready
        );
        assert_eq!(
            channel_membership_transition("owner", Some("member")),
            Err("identity_rotation_channel_membership_role_conflict".into())
        );
    }
}

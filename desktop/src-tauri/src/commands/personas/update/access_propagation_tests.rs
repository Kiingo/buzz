//! Tests for which instances follow a definition access edit.

use super::*;

const TEAMMATE: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const OTHER: &str = "2222222222222222222222222222222222222222222222222222222222222222";

fn definition(respond_to: Option<&str>, allowlist: &[&str]) -> AgentDefinition {
    AgentDefinition {
        id: "persona-1".to_string(),
        display_name: "Atlas".to_string(),
        avatar_url: None,
        system_prompt: String::new(),
        runtime: None,
        model: None,
        provider: None,
        name_pool: vec![],
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        team_catalog_source: None,
        env_vars: Default::default(),
        respond_to: respond_to.map(str::to_string),
        respond_to_allowlist: allowlist.iter().map(|s| s.to_string()).collect(),
        parallelism: None,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn instance(pubkey: &str, persona_id: Option<&str>, access: Access) -> ManagedAgentRecord {
    let mut record = definition(None, &[]).into_agent_record();
    record.pubkey = pubkey.to_string();
    record.name = format!("agent-{pubkey}");
    record.slug = None;
    record.persona_id = persona_id.map(str::to_string);
    record.respond_to = access.0;
    record.respond_to_allowlist = access.1;
    record
}

fn owner_only() -> Access {
    (RespondTo::OwnerOnly, vec![])
}

fn allowlist(keys: &[&str]) -> Access {
    (
        RespondTo::Allowlist,
        keys.iter().map(|s| s.to_string()).collect(),
    )
}

#[test]
fn unset_definition_access_is_the_owner_only_mint_default() {
    assert_eq!(
        definition_access(&definition(None, &[])),
        Some(owner_only())
    );
    assert_eq!(
        definition_access(&definition(Some("allowlist"), &[TEAMMATE])),
        Some(allowlist(&[TEAMMATE]))
    );
    assert_eq!(definition_access(&definition(Some("bogus"), &[])), None);
}

#[test]
fn inheriting_instance_follows_definition_from_owner_only_to_allowlist() {
    // The reported bug: the card editor saved Selected people on the
    // definition while the running instance stayed owner-only.
    let records = vec![instance("a", Some("persona-1"), owner_only())];
    let followers = instances_following_access(
        &records,
        "persona-1",
        &owner_only(),
        &allowlist(&[TEAMMATE]),
    );
    assert_eq!(followers, vec![("a".to_string(), "agent-a".to_string())]);
}

#[test]
fn individually_customized_and_unrelated_records_keep_their_access() {
    let records = vec![
        // Customized on the instance: not on the definition's old access.
        instance("custom", Some("persona-1"), allowlist(&[OTHER])),
        // Another definition's instance.
        instance("other", Some("persona-2"), owner_only()),
        // The key-less definition record itself.
        instance("", Some("persona-1"), owner_only()),
    ];
    let followers = instances_following_access(
        &records,
        "persona-1",
        &owner_only(),
        &allowlist(&[TEAMMATE]),
    );
    assert!(followers.is_empty(), "{followers:?}");
}

#[test]
fn allowlist_match_ignores_order_and_case() {
    let upper = TEAMMATE.to_ascii_uppercase();
    let records = vec![instance(
        "a",
        Some("persona-1"),
        allowlist(&[upper.as_str(), OTHER]),
    )];
    let followers = instances_following_access(
        &records,
        "persona-1",
        &allowlist(&[OTHER, TEAMMATE]),
        &owner_only(),
    );
    assert_eq!(followers.len(), 1);
}

#[test]
fn unchanged_definition_access_touches_nothing() {
    let records = vec![instance("a", Some("persona-1"), owner_only())];
    assert!(
        instances_following_access(&records, "persona-1", &owner_only(), &owner_only()).is_empty()
    );
}

#[test]
fn update_request_carries_only_access_fields() {
    let request = access_update_request("a", &allowlist(&[TEAMMATE]));
    assert_eq!(request.pubkey, "a");
    assert_eq!(request.respond_to, Some(RespondTo::Allowlist));
    assert_eq!(
        request.respond_to_allowlist,
        Some(vec![TEAMMATE.to_string()])
    );
    assert!(request.name.is_none() && request.model.is_none() && request.env_vars.is_none());
    assert!(request.system_prompt.is_none() && request.agent_command.is_none());

    let narrowed = access_update_request("a", &owner_only());
    assert_eq!(narrowed.respond_to, Some(RespondTo::OwnerOnly));
    assert_eq!(narrowed.respond_to_allowlist, None);
}

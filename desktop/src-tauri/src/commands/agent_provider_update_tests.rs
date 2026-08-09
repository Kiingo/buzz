use super::*;
use crate::{
    commands::agent_provider_update::{
        apply_definition_prompt_revisions, apply_provider_prompt_revision, provider_update_required,
    },
    managed_agents::{BackendKind, ManagedAgentRecord},
};

#[test]
fn provider_profile_edit_increments_revision_and_keeps_provider() {
    let current = BackendKind::Provider {
        id: "example".to_string(),
        config: serde_json::json!({
            "harness": "first",
            "model_mode": "auto",
            "profile_revision": 4
        }),
        name: Some("Example Compute".to_string()),
        summary: Vec::new(),
    };
    let requested = BackendKind::Provider {
        id: "example".to_string(),
        config: serde_json::json!({
            "harness": "second",
            "model_mode": "auto",
            "profile_revision": 99
        }),
        name: Some("Example Compute".to_string()),
        summary: Vec::new(),
    };

    let updated = updated_provider_backend(&current, &requested)
        .expect("provider update should validate")
        .expect("changed profile should produce an update");
    let BackendKind::Provider { id, config, .. } = updated else {
        panic!("provider update changed execution kind")
    };
    assert_eq!(id, "example");
    assert_eq!(config["profile_revision"], 5);
    assert_eq!(config["harness"], "second");
}

#[test]
fn provider_profile_edit_ignores_client_revision_only_change() {
    let current = BackendKind::Provider {
        id: "example".to_string(),
        config: serde_json::json!({"harness": "first", "profile_revision": 4}),
        name: None,
        summary: Vec::new(),
    };
    let requested = BackendKind::Provider {
        id: "example".to_string(),
        config: serde_json::json!({"harness": "first", "profile_revision": 400}),
        name: None,
        summary: Vec::new(),
    };

    assert_eq!(
        updated_provider_backend(&current, &requested).unwrap(),
        None
    );
}

#[test]
fn provider_profile_edit_rejects_provider_or_location_move() {
    let current = BackendKind::Provider {
        id: "example".to_string(),
        config: serde_json::json!({}),
        name: None,
        summary: Vec::new(),
    };
    let other = BackendKind::Provider {
        id: "other".to_string(),
        config: serde_json::json!({}),
        name: None,
        summary: Vec::new(),
    };

    assert!(updated_provider_backend(&current, &other).is_err());
    assert!(updated_provider_backend(&current, &BackendKind::Local).is_err());
}

#[test]
fn provider_presentation_update_does_not_increment_profile_revision() {
    let current = BackendKind::Provider {
        id: "example".to_string(),
        config: serde_json::json!({"harness": "codex", "profile_revision": 4}),
        name: None,
        summary: Vec::new(),
    };
    let requested = BackendKind::Provider {
        id: "example".to_string(),
        config: serde_json::json!({"harness": "codex", "profile_revision": 999}),
        name: Some("Example Compute".to_string()),
        summary: vec![crate::managed_agents::ProviderPresentationItem {
            label: "Harness".to_string(),
            value: "Codex CLI".to_string(),
        }],
    };

    let updated = updated_provider_backend(&current, &requested)
        .unwrap()
        .expect("presentation should be persisted");
    let BackendKind::Provider {
        config,
        name,
        summary,
        ..
    } = updated
    else {
        panic!("provider update changed execution kind")
    };
    assert_eq!(config["profile_revision"], 4);
    assert_eq!(name.as_deref(), Some("Example Compute"));
    assert_eq!(summary[0].value, "Codex CLI");
}

#[test]
fn provider_prompt_set_replace_and_clear_each_increment_revision() {
    let mut backend = BackendKind::Provider {
        id: "example".to_string(),
        config: serde_json::json!({"harness": "codex", "profile_revision": 4}),
        name: None,
        summary: Vec::new(),
    };

    assert!(
        apply_provider_prompt_revision(&backend.clone(), &mut backend, None, Some("first"))
            .expect("prompt set should apply")
    );
    assert_eq!(backend_config_revision(&backend), 5);
    assert!(apply_provider_prompt_revision(
        &backend.clone(),
        &mut backend,
        Some("first"),
        Some("second")
    )
    .expect("prompt replacement should apply"));
    assert_eq!(backend_config_revision(&backend), 6);
    assert!(
        apply_provider_prompt_revision(&backend.clone(), &mut backend, Some("second"), None)
            .expect("prompt clear should apply")
    );
    assert_eq!(backend_config_revision(&backend), 7);
}

#[test]
fn unchanged_prompt_and_presentation_only_edits_do_not_increment_revision() {
    let current = BackendKind::Provider {
        id: "example".to_string(),
        config: serde_json::json!({"harness": "codex", "profile_revision": 4}),
        name: None,
        summary: Vec::new(),
    };
    let mut next = BackendKind::Provider {
        id: "example".to_string(),
        config: serde_json::json!({"harness": "codex", "profile_revision": 4}),
        name: Some("Renamed provider".to_string()),
        summary: Vec::new(),
    };

    assert!(
        !apply_provider_prompt_revision(&current, &mut next, Some("same"), Some("same"))
            .expect("unchanged prompt should be a no-op")
    );
    assert_eq!(backend_config_revision(&next), 4);
    assert!(
        !apply_provider_prompt_revision(&current, &mut next, Some("same"), Some(" same "))
            .expect("normalization-only prompt edit should be a no-op")
    );
    assert_eq!(backend_config_revision(&next), 4);
}

#[test]
fn prompt_change_shares_an_already_incremented_profile_revision() {
    let current = BackendKind::Provider {
        id: "example".to_string(),
        config: serde_json::json!({"harness": "codex", "profile_revision": 4}),
        name: None,
        summary: Vec::new(),
    };
    let mut next = BackendKind::Provider {
        id: "example".to_string(),
        config: serde_json::json!({"harness": "claude-code", "profile_revision": 5}),
        name: None,
        summary: Vec::new(),
    };

    assert!(
        apply_provider_prompt_revision(&current, &mut next, Some("old"), Some("new"))
            .expect("combined edit should apply")
    );
    assert_eq!(backend_config_revision(&next), 5);
}

#[test]
fn definition_prompt_change_revisions_only_linked_provider_instances() {
    let mut linked = provider_record("linked", Some("persona-1"), 4);
    let unrelated = provider_record("unrelated", Some("persona-2"), 8);
    let mut local = provider_record("local", Some("persona-1"), 3);
    local.backend = BackendKind::Local;
    let mut records = vec![linked.clone(), unrelated, local];

    let targets = apply_definition_prompt_revisions(
        &mut records,
        "persona-1",
        "old instructions",
        "new instructions",
    )
    .expect("definition prompt revision should apply");

    assert_eq!(targets, vec!["linked".to_string()]);
    assert_eq!(backend_config_revision(&records[0].backend), 5);
    assert_eq!(backend_config_revision(&records[1].backend), 8);
    assert_eq!(records[2].backend, BackendKind::Local);
    linked.backend = records[0].backend.clone();
    assert!(apply_definition_prompt_revisions(
        std::slice::from_mut(&mut linked),
        "persona-1",
        "new instructions",
        " new instructions ",
    )
    .expect("equivalent prompt should compare after normalization")
    .is_empty());
}

#[test]
fn definition_prompt_clear_increments_each_linked_provider_once() {
    let mut records = vec![
        provider_record("first", Some("persona-1"), 1),
        provider_record("second", Some("persona-1"), 6),
    ];

    let targets =
        apply_definition_prompt_revisions(&mut records, "persona-1", "old instructions", "   ")
            .expect("definition prompt clear should apply");

    assert_eq!(targets, vec!["first".to_string(), "second".to_string()]);
    assert_eq!(backend_config_revision(&records[0].backend), 2);
    assert_eq!(backend_config_revision(&records[1].backend), 7);
}

#[test]
fn local_prompt_edits_do_not_enter_the_remote_provider_update_path() {
    let mut previous = provider_record("local", None, 1);
    previous.backend = BackendKind::Local;
    previous.system_prompt = Some("old".to_string());
    let mut next = previous.clone();
    next.system_prompt = Some("new".to_string());

    assert!(!provider_update_required(&next, &previous));

    previous.backend = BackendKind::Provider {
        id: "example".to_string(),
        config: serde_json::json!({"profile_revision": 1}),
        name: None,
        summary: Vec::new(),
    };
    next.backend = previous.backend.clone();
    assert!(provider_update_required(&next, &previous));
}

fn provider_record(
    pubkey: &str,
    persona_id: Option<&str>,
    profile_revision: u64,
) -> ManagedAgentRecord {
    let mut record: ManagedAgentRecord = serde_json::from_value(serde_json::json!({
        "pubkey": pubkey,
        "name": pubkey,
        "relay_url": "",
        "acp_command": "",
        "agent_command": "",
        "agent_args": [],
        "mcp_command": "",
        "turn_timeout_seconds": 0,
        "system_prompt": null,
        "created_at": "",
        "updated_at": "",
        "last_started_at": null,
        "last_stopped_at": null,
        "last_exit_code": null,
        "last_error": null
    }))
    .expect("managed agent fixture should deserialize");
    record.persona_id = persona_id.map(str::to_string);
    record.backend = BackendKind::Provider {
        id: "example".to_string(),
        config: serde_json::json!({
            "harness": "codex",
            "profile_revision": profile_revision
        }),
        name: None,
        summary: Vec::new(),
    };
    record
}

fn backend_config_revision(backend: &BackendKind) -> u64 {
    let BackendKind::Provider { config, .. } = backend else {
        panic!("expected provider backend")
    };
    config["profile_revision"]
        .as_u64()
        .expect("provider revision should be numeric")
}

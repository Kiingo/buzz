use super::*;
use crate::managed_agents::BackendKind;

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

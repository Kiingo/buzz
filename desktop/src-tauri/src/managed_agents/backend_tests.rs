use super::*;
use crate::managed_agents::discovery::command_search;

#[test]
fn execution_profile_ownership_requires_a_literal_true_schema_extension() {
    let info = |marker: serde_json::Value| serde_json::json!({"config_schema": {"x-buzz-owns-execution-profile": marker}});
    assert!(provider_owns_execution_profile(&info(serde_json::json!(
        true
    ))));
    for marker in [
        serde_json::json!(false),
        serde_json::json!("true"),
        serde_json::json!(1),
        serde_json::Value::Null,
    ] {
        assert!(!provider_owns_execution_profile(&info(marker)));
    }
    assert!(!provider_owns_execution_profile(&serde_json::json!({})));
}

#[test]
fn deployment_refuses_execution_profile_ownership_drift() {
    let owning = serde_json::json!({
        "config_schema": {"x-buzz-owns-execution-profile": true}
    });
    assert!(validate_execution_profile_ownership(&owning, true).is_ok());
    assert!(validate_execution_profile_ownership(&owning, false)
        .unwrap_err()
        .contains("ownership changed"));
}

#[test]
fn redact_secrets_replaces_nsec() {
    let s = "key=nsec1abc123def456 other";
    let r = redact_secrets(s);
    assert!(r.contains("[REDACTED]"));
    assert!(!r.contains("nsec1abc123def456"));
}

#[test]
fn redact_secrets_replaces_token() {
    let s = r#"{"token":"sprt_tok_xyz789"}"#;
    let r = redact_secrets(s);
    assert!(r.contains("[REDACTED]"));
    assert!(!r.contains("sprt_tok_xyz789"));
}

#[test]
fn redact_secrets_with_extras_scrubs_user_env_values() {
    // If a provider echoes back a user-supplied API key in its error
    // output, the desktop must not surface that secret unredacted via
    // `last_error`. We scrub the literal values that came from the
    // request's `agent.env_vars`.
    let secret = "sk-ant-api03-abc123def456";
    let stderr = format!("auth failed with key {secret} on host api.anthropic.com");
    let r = redact_secrets_with(&stderr, &[secret]);
    assert!(r.contains("[REDACTED]"));
    assert!(!r.contains(secret));
}

#[test]
fn redact_secrets_with_extras_skips_short_values() {
    // Don't scrub values shorter than 4 chars — too noisy.
    let r = redact_secrets_with("error code: 42", &["42"]);
    assert!(r.contains("42"));
}

/// GitHub tokens are recognised by shape, so one that never passed through
/// our environment — embedded in a remote URL an installer echoes — is
/// still scrubbed. The scan runs to the next whitespace or quote, so the
/// rest of the URL goes with it; over-redaction is the safe direction.
#[test]
fn redact_secrets_with_scrubs_github_token_prefixes() {
    for token in [
        "ghp_abcdefghij0123456789",
        "gho_abcdefghij0123456789",
        "ghu_abcdefghij0123456789",
        "ghs_abcdefghij0123456789",
        "ghr_abcdefghij0123456789",
        "github_pat_abcdefghij0123456789",
    ] {
        let r = redact_secrets_with(&format!("cloning https://{token}@github.com/o/r now"), &[]);
        assert!(!r.contains(token), "leaked {token}: {r}");
        assert!(r.contains("[REDACTED]"), "got: {r}");
        assert!(r.contains("cloning"), "scan must stop at whitespace: {r}");
        assert!(r.ends_with(" now"), "scan must stop at whitespace: {r}");
    }
}

#[test]
fn redact_secrets_with_extras_terminates_when_value_substring_of_marker() {
    // Regression: an earlier impl used `while let Some(pos) = find(value)`
    // which never terminates if the user's env value is a substring of
    // the replacement marker `[REDACTED]` — each replacement
    // reintroduces the same text. Now uses `str::replace` (single-pass).
    for value in ["REDACTED", "EDACTE", "REDA", "ACTED"] {
        let r = redact_secrets_with(&format!("leak={value}"), &[value]);
        assert!(r.contains("[REDACTED]"));
    }
}

#[test]
fn redact_secrets_with_extras_handles_overlapping_secrets() {
    // Longer entries get scrubbed first so the substring "abc12" isn't
    // matched before "abc123" is consumed.
    let s = "key1=abc123 key2=abc12";
    let r = redact_secrets_with(s, &["abc12", "abc123"]);
    assert!(!r.contains("abc123"));
    assert!(!r.contains("abc12 "));
}

#[test]
fn env_secrets_from_request_extracts_string_values() {
    let req = serde_json::json!({
        "op": "deploy",
        "agent": {
            "env_vars": {
                "ANTHROPIC_API_KEY": "sk-ant-test",
                "EMPTY": "",
                "NUMERIC": 42,
            },
        },
    });
    let secrets = env_secrets_from_request(&req);
    assert!(secrets.iter().any(|v| v == "sk-ant-test"));
    // Empty and non-string values are filtered out.
    assert_eq!(secrets.len(), 1);
}

#[test]
fn env_secrets_from_request_handles_missing_shape() {
    assert!(env_secrets_from_request(&serde_json::json!({})).is_empty());
    assert!(env_secrets_from_request(&serde_json::json!({"agent": {}})).is_empty());
    assert!(env_secrets_from_request(&serde_json::json!({"agent": {"env_vars": null}})).is_empty());
}

#[test]
fn redact_env_values_in_scrubs_map_values() {
    let mut env = std::collections::BTreeMap::new();
    env.insert("ANTHROPIC_API_KEY".to_string(), "sk-ant-real".to_string());
    env.insert("EMPTY".to_string(), String::new());
    let stderr = "auth=sk-ant-real failed; other context";
    let r = redact_env_values_in(stderr, &env);
    assert!(!r.contains("sk-ant-real"));
    assert!(r.contains("[REDACTED]"));
}

#[test]
fn env_secrets_from_request_includes_resolved_launch_maps() {
    let req = serde_json::json!({
        "agent": {
            "env_vars": {"LEGACY": "legacy-secret"},
            "launch": {
                "env": {"PERSONA": "persona-secret"},
                "policy_env": {"POLICY": "policy-secret"}
            }
        }
    });
    let secrets = env_secrets_from_request(&req);
    assert_eq!(secrets.len(), 3);
    for secret in ["legacy-secret", "persona-secret", "policy-secret"] {
        assert!(secrets.iter().any(|candidate| candidate == secret));
    }
}

#[cfg(unix)]
fn write_test_provider(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[cfg(unix)]
#[test]
fn provider_deploy_negotiates_and_deploys_the_same_staged_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let provider = directory.path().join("provider");
    let log = directory.path().join("invocations");
    let body = format!(
        r#"read request
printf '%s\n' "$0" >> '{}'
case "$request" in
  *\"op\":\"info\"*) printf '%s\n' '{{"ok":true,"name":"test","version":"1.0.0","protocol_version":1,"description":"test provider","config_schema":{{}}}}' ;;
  *\"op\":\"deploy\"*) printf '%s\n' '{{"ok":true,"agent_id":"remote-1"}}' ;;
esac"#,
        log.display()
    );
    write_test_provider(&provider, &body);

    let id = provider_deploy(
        &provider,
        &serde_json::json!({}),
        &serde_json::json!({}),
        false,
    )
    .expect("staged deploy");
    assert_eq!(id, "remote-1");
    let paths: Vec<_> = std::fs::read_to_string(log)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();
    assert_eq!(paths.len(), 2);
    assert_eq!(paths[0], paths[1]);
    assert_ne!(Path::new(&paths[0]), provider);
    assert!(
        !Path::new(&paths[0]).exists(),
        "staging directory must be deleted"
    );
}

#[cfg(unix)]
fn replacement_provider() -> &'static str {
    r#"#!/bin/sh
set -eu
read request
case "$request" in
  *\"op\":\"info\"*) printf '%s\n' '{"ok":true,"name":"replacement","version":"9.9.9","protocol_version":1,"description":"replacement provider","config_schema":{}}' ;;
  *\"op\":\"deploy\"*) printf '%s\n' '{"ok":true,"agent_id":"replacement-bytes-ran"}' ;;
esac
"#
}

#[cfg(unix)]
#[test]
fn provider_deploy_uses_staged_bytes_after_same_inode_source_rewrite() {
    use std::os::unix::fs::MetadataExt;

    let directory = tempfile::tempdir().unwrap();
    let provider = directory.path().join("provider");
    let replacement = directory.path().join("replacement");
    std::fs::write(&replacement, replacement_provider()).unwrap();
    let body = format!(
        r#"read request
case "$request" in
  *\"op\":\"info\"*)
    cat '{}' > '{}'
    chmod 700 '{}'
    printf '%s\n' '{{"ok":true,"name":"original","version":"1.0.0","protocol_version":1,"description":"original provider","config_schema":{{}}}}'
    ;;
  *\"op\":\"deploy\"*) printf '%s\n' '{{"ok":true,"agent_id":"original-staged-bytes"}}' ;;
esac"#,
        replacement.display(),
        provider.display(),
        provider.display(),
    );
    write_test_provider(&provider, &body);
    let inode_before = std::fs::metadata(&provider).unwrap().ino();

    let id = provider_deploy(
        &provider,
        &serde_json::json!({}),
        &serde_json::json!({}),
        false,
    )
    .expect("deploy from immutable staged copy");

    assert_eq!(id, "original-staged-bytes");
    assert_eq!(
        std::fs::metadata(&provider).unwrap().ino(),
        inode_before,
        "test must rewrite the source binary in place"
    );
    assert_eq!(
        std::fs::read_to_string(&provider).unwrap(),
        replacement_provider(),
        "source pathname must contain replacement bytes before deploy"
    );
}

#[cfg(unix)]
#[test]
fn provider_deploy_uses_staged_bytes_after_source_pathname_replacement() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let directory = tempfile::tempdir().unwrap();
    let provider = directory.path().join("provider");
    let replacement = directory.path().join("replacement");
    std::fs::write(&replacement, replacement_provider()).unwrap();
    std::fs::set_permissions(&replacement, std::fs::Permissions::from_mode(0o700)).unwrap();
    let body = format!(
        r#"read request
case "$request" in
  *\"op\":\"info\"*)
    mv '{}' '{}'
    printf '%s\n' '{{"ok":true,"name":"original","version":"1.0.0","protocol_version":1,"description":"original provider","config_schema":{{}}}}'
    ;;
  *\"op\":\"deploy\"*) printf '%s\n' '{{"ok":true,"agent_id":"original-staged-bytes"}}' ;;
esac"#,
        replacement.display(),
        provider.display(),
    );
    write_test_provider(&provider, &body);
    let inode_before = std::fs::metadata(&provider).unwrap().ino();

    let id = provider_deploy(
        &provider,
        &serde_json::json!({}),
        &serde_json::json!({}),
        false,
    )
    .expect("deploy from immutable staged copy");

    assert_eq!(id, "original-staged-bytes");
    assert_ne!(
        std::fs::metadata(&provider).unwrap().ino(),
        inode_before,
        "test must replace the source pathname with a different inode"
    );
    assert_eq!(
        std::fs::read_to_string(&provider).unwrap(),
        replacement_provider(),
        "source pathname must contain replacement bytes before deploy"
    );
}

#[cfg(unix)]
#[test]
fn provider_deploy_refuses_mismatch_before_sending_agent_secret() {
    let directory = tempfile::tempdir().unwrap();
    let provider = directory.path().join("provider");
    let marker = directory.path().join("deploy-received");
    let body = format!(
        r#"read request
case "$request" in
  *\"op\":\"info\"*) printf '%s\n' '{{"ok":true,"name":"test","version":"3.0.0","protocol_version":3,"description":"test provider","config_schema":{{}}}}' ;;
  *\"op\":\"deploy\"*) touch '{}'; printf '%s\n' '{{"ok":true,"agent_id":"bad"}}' ;;
esac"#,
        marker.display()
    );
    write_test_provider(&provider, &body);

    let error = provider_deploy(
        &provider,
        &serde_json::json!({"private_key_nsec": "nsec1must-not-cross"}),
        &serde_json::json!({}),
        false,
    )
    .unwrap_err();
    assert!(error.contains("protocol version 3"), "{error}");
    assert!(!marker.exists());
    assert!(!error.contains("nsec1must-not-cross"));
}

#[cfg(unix)]
#[test]
fn provider_deploy_requires_an_explicit_integer_protocol_version() {
    let directory = tempfile::tempdir().unwrap();
    let provider = directory.path().join("provider");
    write_test_provider(
        &provider,
        r#"read request
printf '%s\n' '{"ok":true,"version":"1.0.0"}'"#,
    );

    let error = provider_deploy(
        &provider,
        &serde_json::json!({}),
        &serde_json::json!({}),
        false,
    )
    .unwrap_err();
    assert!(
        error.contains("missing integer protocol_version"),
        "{error}"
    );
}

#[test]
fn provider_info_requires_the_complete_flat_wire_shape() {
    let complete = serde_json::json!({
        "ok": true,
        "name": "kubernetes",
        "version": "1.0.0",
        "protocol_version": 1,
        "description": "Kubernetes provider",
        "config_schema": {}
    });
    assert_eq!(
        validate_provider_info(&complete).unwrap(),
        ProviderProtocolInfo {
            version: 1,
            supports_confirmed_delete: false,
            supports_preflight: false
        }
    );

    let mut missing = complete.clone();
    missing.as_object_mut().unwrap().remove("config_schema");
    assert!(validate_provider_info(&missing)
        .unwrap_err()
        .contains("config_schema"));

    let mut nested = complete;
    nested.as_object_mut().unwrap().insert(
        "provider".into(),
        serde_json::json!({"protocol_version": 1}),
    );
    assert!(validate_provider_info(&nested)
        .unwrap_err()
        .contains("unknown field provider"));
}

#[test]
fn provider_info_accepts_only_the_narrow_protocol_v2_delete_capability() {
    let v2 = serde_json::json!({
        "ok": true,
        "name": "example",
        "version": "2.0.0",
        "protocol_version": 2,
        "description": "Example provider",
        "config_schema": {},
        "capabilities": {"lifecycle_operations": ["delete"]}
    });
    assert_eq!(
        validate_provider_info(&v2).unwrap(),
        ProviderProtocolInfo {
            version: 2,
            supports_confirmed_delete: true,
            supports_preflight: false
        }
    );

    let mut no_delete = v2.clone();
    no_delete["capabilities"]["lifecycle_operations"] = serde_json::json!([]);
    assert_eq!(
        validate_provider_info(&no_delete).unwrap(),
        ProviderProtocolInfo {
            version: 2,
            supports_confirmed_delete: false,
            supports_preflight: false
        }
    );

    for invalid in [
        serde_json::json!({
            "ok": true, "name": "example", "version": "2.0.0",
            "protocol_version": 2, "description": "Example provider",
            "config_schema": {},
            "capabilities": {"lifecycle_operations": ["status"]}
        }),
        serde_json::json!({
            "ok": true, "name": "example", "version": "2.0.0",
            "protocol_version": 2, "description": "Example provider",
            "config_schema": {},
            "capabilities": {"lifecycle_operations": ["delete", "delete"]}
        }),
        serde_json::json!({
            "ok": true, "name": "example", "version": "2.0.0",
            "protocol_version": 2, "description": "Example provider",
            "config_schema": {},
            "capabilities": {"lifecycle_operations": ["delete"], "status": true}
        }),
        serde_json::json!({
            "ok": true, "name": "example", "version": "1.0.0",
            "protocol_version": 1, "description": "Example provider",
            "config_schema": {},
            "capabilities": {"lifecycle_operations": ["delete"]}
        }),
    ] {
        assert!(validate_provider_info(&invalid).is_err());
    }
}

#[test]
fn validate_provider_config_rejects_secret_key() {
    let cfg = serde_json::json!({"api_key": "val"});
    assert!(validate_provider_config(&cfg).is_err());
}

#[test]
fn validate_provider_config_rejects_nested() {
    let cfg = serde_json::json!({"region": {"us": "east"}});
    assert!(validate_provider_config(&cfg).is_err());
}

#[test]
fn validate_provider_config_accepts_scalars() {
    let cfg = serde_json::json!({"region": "us-east-1", "tier": "standard"});
    assert!(validate_provider_config(&cfg).is_ok());
}

#[test]
fn validate_provider_config_allows_key_as_substring() {
    // "keyboard", "monkey" contain "key" as substring but not as a word segment.
    let cfg = serde_json::json!({"keyboard_layout": "us", "monkey_wrench": "tight"});
    assert!(validate_provider_config(&cfg).is_ok());
}

#[test]
fn validate_provider_config_rejects_camel_case_secrets() {
    assert!(validate_provider_config(&serde_json::json!({"apiKey": "val"})).is_err());
    assert!(validate_provider_config(&serde_json::json!({"accessToken": "val"})).is_err());
    assert!(validate_provider_config(&serde_json::json!({"clientSecret": "val"})).is_err());
    // ALL-CAPS variants
    assert!(validate_provider_config(&serde_json::json!({"apiKEY": "val"})).is_err());
    assert!(validate_provider_config(&serde_json::json!({"accessTOKEN": "val"})).is_err());
}

#[test]
fn split_config_key_handles_all_styles() {
    assert_eq!(split_config_key("apiKey"), vec!["api", "key"]);
    assert_eq!(split_config_key("access_token"), vec!["access", "token"]);
    assert_eq!(split_config_key("keyboard"), vec!["keyboard"]);
    assert_eq!(split_config_key("client-secret"), vec!["client", "secret"]);
    // Acronym runs stay together
    assert_eq!(split_config_key("APIKey"), vec!["api", "key"]);
    assert_eq!(split_config_key("apiKEY"), vec!["api", "key"]);
    assert_eq!(split_config_key("accessTOKEN"), vec!["access", "token"]);
    assert_eq!(split_config_key("MyAPIKey"), vec!["my", "api", "key"]);
}

#[test]
fn provider_filename_strips_the_windows_extension() {
    assert_eq!(
        provider_id_from_filename("buzz-backend-kubernetes"),
        Some("kubernetes")
    );
    assert_eq!(
        provider_id_from_filename("buzz-backend-kubernetes.exe"),
        Some("kubernetes")
    );
    assert_eq!(
        provider_id_from_filename("buzz-backend-kubernetes.EXE"),
        Some("kubernetes")
    );
    assert_eq!(
        provider_id_from_filename("buzz-backend-kubernetes.bat"),
        Some("kubernetes")
    );
    assert_eq!(
        provider_id_from_filename("buzz-backend-kubernetes.CMD"),
        Some("kubernetes")
    );
    assert_eq!(
        provider_id_from_filename("buzz-backend-my-provider"),
        Some("my-provider")
    );
    assert_eq!(provider_id_from_filename("other"), None);
}

#[test]
fn command_discovery_dirs_include_all_spawn_search_sources_without_duplicates() {
    let workspace = PathBuf::from("workspace");
    let path = PathBuf::from("path");
    let managed = PathBuf::from("managed");
    let login = PathBuf::from("login");
    let nvm = PathBuf::from("nvm");

    assert_eq!(
        command_search::merge_command_discovery_dirs([
            vec![workspace.clone(), path.clone()],
            vec![path, managed.clone()],
            vec![login.clone()],
            vec![managed, nvm.clone()],
        ]),
        vec![
            workspace,
            PathBuf::from("path"),
            PathBuf::from("managed"),
            login,
            nvm
        ]
    );
}

#[test]
fn acp_command_filename_supports_windows_shims_and_rejects_extensionless_windows_files() {
    assert_eq!(
        acp_command_from_filename("buzz-janet-acp.EXE", true),
        Some("buzz-janet-acp")
    );
    assert_eq!(
        acp_command_from_filename("buzz-janet-acp.cmd", true),
        Some("buzz-janet-acp")
    );
    assert_eq!(
        acp_command_from_filename("buzz-janet-acp.BAT", true),
        Some("buzz-janet-acp")
    );
    assert_eq!(acp_command_from_filename("buzz-janet-acp", true), None);
    assert_eq!(
        acp_command_from_filename("buzz-janet-acp", false),
        Some("buzz-janet-acp")
    );
    assert_eq!(acp_command_from_filename("buzz-acp.exe", true), None);
}

#[test]
fn discovers_only_namespaced_acp_commands() {
    let dir = tempfile::tempdir().expect("temp dir");
    for command in [
        "buzz-janet-acp",
        "buzz-acp",
        "buzz--acp",
        "janet-acp",
        "buzz-janet-helper",
    ] {
        let filename = if cfg!(windows) {
            format!("{command}.cmd")
        } else {
            command.to_string()
        };
        let path = dir.path().join(filename);
        std::fs::write(&path, "#!/bin/sh\n").expect("write fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&path).expect("metadata").permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&path, permissions).expect("chmod fixture");
        }
    }

    let candidates = discover_acp_command_candidates_in([dir.path().to_path_buf()], |command| {
        Some(dir.path().join(command))
    });
    assert_eq!(
        candidates
            .into_iter()
            .map(|(command, _)| command)
            .collect::<Vec<_>>(),
        vec!["buzz-janet-acp"]
    );
}

#[test]
fn acp_command_discovery_deduplicates_path_entries() {
    let first = tempfile::tempdir().expect("first temp dir");
    let second = tempfile::tempdir().expect("second temp dir");
    let command = "buzz-janet-acp";
    let filename = if cfg!(windows) {
        format!("{command}.cmd")
    } else {
        command.to_string()
    };
    for dir in [first.path(), second.path()] {
        let path = dir.join(&filename);
        std::fs::write(&path, "#!/bin/sh\n").expect("write fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&path).expect("metadata").permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&path, permissions).expect("chmod fixture");
        }
    }

    let resolved = second.path().join(&filename);
    let candidates = discover_acp_command_candidates_in(
        [first.path().to_path_buf(), second.path().to_path_buf()],
        |_| Some(resolved.clone()),
    );
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].0, "buzz-janet-acp");
    assert_eq!(candidates[0].1, resolved);
}

#[test]
fn resolve_provider_binary_rejects_invalid_ids() {
    // Path traversal
    assert!(resolve_provider_binary("../evil").is_err());
    // Empty
    assert!(resolve_provider_binary("").is_err());
    // Uppercase
    assert!(resolve_provider_binary("MyProvider").is_err());
    // Spaces
    assert!(resolve_provider_binary("my provider").is_err());
    // Shell metacharacters
    assert!(resolve_provider_binary("foo;rm -rf /").is_err());
    // Valid format but not on PATH — should fail with "not found"
    assert!(resolve_provider_binary("nonexistent-test-id-12345").is_err());
}

#[test]
fn resolve_provider_binary_accepts_valid_id_format() {
    // Valid ID format should pass validation. If the binary happens to
    // exist on PATH, Ok is returned; otherwise Err contains "not found"
    // (not "invalid provider ID"). Either outcome proves validation passed.
    match resolve_provider_binary("zzz-nonexistent-test-provider") {
        Ok(_) => {} // unlikely but fine — binary exists
        Err(e) => assert!(
            e.contains("not found"),
            "expected 'not found' error, got: {e}"
        ),
    }
}

#[test]
fn portable_acp_aliases_exclude_paths_arguments_and_platform_metacharacters() {
    for command in ["buzz-acp", "buzz-janet-acp", "buzz-Team_2-acp"] {
        assert!(is_portable_acp_command(command), "{command}");
    }
    for command in [
        "",
        "buzz--acp",
        "/tmp/buzz-janet-acp",
        r"C:\buzz-janet-acp.cmd",
        "buzz-../evil-acp",
        "buzz-a b-acp",
        "buzz-a&b-acp",
        "buzz-a%PATH%-acp",
        "buzz-a\nb-acp",
        "buzz-a\u{202e}b-acp",
        "other-command",
        "buzz-janet-acp.exe",
    ] {
        assert!(!is_portable_acp_command(command), "{command:?}");
    }
}

#[test]
fn provider_info_accepts_preflight_alongside_delete_once_each() {
    let base = |operations: serde_json::Value| {
        serde_json::json!({
            "ok": true, "name": "example", "version": "2.1.0",
            "protocol_version": 2, "description": "Example provider",
            "config_schema": {},
            "capabilities": {"lifecycle_operations": operations}
        })
    };
    assert_eq!(
        validate_provider_info(&base(serde_json::json!(["delete", "preflight"]))).unwrap(),
        ProviderProtocolInfo {
            version: 2,
            supports_confirmed_delete: true,
            supports_preflight: true
        }
    );
    assert_eq!(
        validate_provider_info(&base(serde_json::json!(["preflight"]))).unwrap(),
        ProviderProtocolInfo {
            version: 2,
            supports_confirmed_delete: false,
            supports_preflight: true
        }
    );
    assert!(validate_provider_info(&base(serde_json::json!(["preflight", "preflight"]))).is_err());
    assert!(validate_provider_info(&base(serde_json::json!(["delete", "status"]))).is_err());
}

#[cfg(unix)]
fn deploy_failure_provider(directory: &Path, deploy_response: &str) -> PathBuf {
    let provider = directory.join("provider");
    let body = format!(
        r#"read request
case "$request" in
  *\"op\":\"info\"*) printf '%s\n' '{{"ok":true,"name":"test","version":"2.0.0","protocol_version":2,"description":"test provider","config_schema":{{}},"capabilities":{{"lifecycle_operations":["delete"]}}}}' ;;
  *\"op\":\"deploy\"*) printf '%s\n' '{deploy_response}' ;;
  *) printf '%s\n' '{{"ok":false,"error":"operation_unsupported"}}' ;;
esac"#
    );
    write_test_provider(&provider, &body);
    provider
}

#[cfg(unix)]
#[test]
fn provider_deploy_reporting_keeps_only_an_explicit_absent_remote_state() {
    let directory = tempfile::tempdir().unwrap();
    let absent = deploy_failure_provider(
        directory.path(),
        r#"{"ok":false,"error":"subscription missing","remote_state":"absent"}"#,
    );
    let failure = provider_deploy_reporting(
        &absent,
        &serde_json::json!({}),
        &serde_json::json!({}),
        false,
        "",
        Err("no owner keys".to_string()),
    )
    .unwrap_err();
    assert_eq!(
        failure,
        ProviderDeployFailure {
            message: "subscription missing".to_string(),
            remote_absent: true
        }
    );
    // The legacy entry point still reports the plain message.
    assert_eq!(
        provider_deploy(
            &absent,
            &serde_json::json!({}),
            &serde_json::json!({}),
            false
        )
        .unwrap_err(),
        "subscription missing"
    );

    for response in [
        r#"{"ok":false,"error":"timeout talking to service"}"#,
        r#"{"ok":false,"error":"x","remote_state":"present"}"#,
        r#"{"ok":false,"error":"x","remote_state":true}"#,
    ] {
        let other = tempfile::tempdir().unwrap();
        let provider = deploy_failure_provider(other.path(), response);
        let failure = provider_deploy_reporting(
            &provider,
            &serde_json::json!({}),
            &serde_json::json!({}),
            false,
            "",
            Err("no owner keys".to_string()),
        )
        .unwrap_err();
        assert!(!failure.remote_absent, "{response}");
    }
}

#[cfg(unix)]
#[test]
fn provider_deploy_reporting_redacts_secrets_from_failure_text() {
    let directory = tempfile::tempdir().unwrap();
    let provider = deploy_failure_provider(
        directory.path(),
        r#"{"ok":false,"error":"bad nsec1must-not-cross","remote_state":"absent"}"#,
    );
    let failure = provider_deploy_reporting(
        &provider,
        &serde_json::json!({"private_key_nsec": "nsec1must-not-cross"}),
        &serde_json::json!({}),
        false,
        "",
        Err("no owner keys".to_string()),
    )
    .unwrap_err();
    assert!(
        !failure.message.contains("nsec1must-not-cross"),
        "{failure:?}"
    );
}

// ── Owner-proven deploy: deploy_prepare → owner proof → deploy_submit ───────

#[cfg(unix)]
const PROVEN_INFO: &str = r#"{"ok":true,"name":"test","version":"2.1.0","protocol_version":2,"description":"test provider","config_schema":{},"capabilities":{"lifecycle_operations":["delete","preflight"]}}"#;

/// A v2 provider that prepares a body for `body_agent` from
/// [`proven_agent`] and [`proven_config`], hashing it the way the server does
/// (its keys are written already sorted), and logs every request it receives.
#[cfg(unix)]
fn owner_proof_provider(
    directory: &Path,
    body_agent: &str,
    prepare_failure: Option<&str>,
) -> PathBuf {
    let provider = directory.join("provider");
    let prepare = match prepare_failure {
        Some(failure) => format!("printf '%s\\n' '{failure}'"),
        None => r#"rid=$(printf '%s' "$request" | sed -n 's/.*"request_id":"\([0-9a-f-]*\)".*/\1/p')
    body='BODY'
    if command -v sha256sum >/dev/null 2>&1; then hash=$(printf '%s' "$body" | sha256sum | cut -d' ' -f1); else hash=$(printf '%s' "$body" | shasum -a 256 | cut -d' ' -f1); fi
    printf '%s\n' '{"ok":true,"request_id":"'"$rid"'","prepared_body":'"$body"',"payload_sha256":"'"$hash"'","agent_public_key":"AGENT","community_id":"chat.example.com"}'"#
            .replace(
                "BODY",
                // Sorted keys (serde_json's map is ordered), so the shell's
                // hash of this text is the canonical hash.
                &serde_json::to_string(&proven_body(body_agent, "RID"))
                    .unwrap()
                    .replace("RID", r#"'"$rid"'"#),
            )
            .replace("AGENT", body_agent),
    };
    let body = r#"read request
printf '%s\n' "$request" >> 'LOG'
case "$request" in
  *\"op\":\"info\"*) printf '%s\n' 'INFO' ;;
  *\"op\":\"deploy_prepare\"*)
    PREPARE ;;
  *\"op\":\"deploy_submit\"*) printf '%s\n' '{"ok":true,"agent_id":"remote-proven","state":"running"}' ;;
  *\"op\":\"deploy\"*) printf '%s\n' '{"ok":true,"agent_id":"unsigned"}' ;;
esac"#
        .replace("INFO", PROVEN_INFO)
        .replace("PREPARE", &prepare)
        .replace("LOG", &directory.join("requests").display().to_string());
    write_test_provider(&provider, &body);
    provider
}

/// The provision body a provider prepares for [`proven_agent`] and
/// [`proven_config`], in the full allowed shape.
#[cfg(unix)]
fn proven_body(agent_public_key: &str, request_id: &str) -> serde_json::Value {
    serde_json::json!({
        "contract_version": 1,
        "request_id": request_id,
        "idempotency_key": "idem-1",
        "community_id": "chat.example.com",
        "relay_url": "wss://chat.example.com",
        "agent_public_key": agent_public_key,
        "display_name": "Agent",
        "provider_config": {"harness": "codex"},
        "owner_attestation": "[]",
        "identity_envelope": {
            "version": 2, "algorithm": "x25519-chacha20poly1305", "key_id": "k1",
            "ephemeral_public_key": "ZXBo", "nonce": "bm9uY2U=", "ciphertext": "Y2lwaGVy",
            "associated_data_sha256": "0".repeat(64),
        },
        "execution_profile": {
            "version": 1, "execution_location": "kiingo-compute",
            "execution": {
                "version": 2,
                "harness": {"mode": "specific", "id": "codex"},
                "model": {"mode": "auto"},
                "reasoning": {"mode": "auto"},
                "service_tier": {"mode": "auto"},
            },
            "capability_catalog_version": "2026-10-01", "profile_revision": 1,
        },
        "agent_instructions": {"version": 1, "profile_revision": 1, "system_prompt": "Be brief."},
        "response_policy": {"version": 1, "respond_to": "owner-only", "respond_to_allowlist": []},
        "capability_policy": {
            "version": 1, "assigned_tools": [], "assigned_skills": [],
            "managed_compute_capabilities": [],
        },
    })
}

#[cfg(unix)]
fn proven_agent() -> serde_json::Value {
    serde_json::json!({
        "name": "Agent",
        "relay_url": "wss://chat.example.com",
        "system_prompt": "Be brief.",
    })
}

#[cfg(unix)]
fn proven_config() -> serde_json::Value {
    serde_json::json!({"harness": "codex"})
}

#[cfg(unix)]
fn logged_requests(directory: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(directory.join("requests"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[cfg(unix)]
fn test_owner(keys: &nostr::Keys) -> Result<crate::managed_agents::DeployOwner, String> {
    Ok(crate::managed_agents::DeployOwner {
        keys: keys.clone(),
        provider_id: "kiingo".to_string(),
    })
}

#[cfg(unix)]
#[test]
fn provider_deploy_submits_the_prepared_body_with_a_signed_owner_proof() {
    let directory = tempfile::tempdir().unwrap();
    let agent = "c".repeat(64);
    let provider = owner_proof_provider(directory.path(), &agent, None);
    let keys = nostr::Keys::generate();
    let agent_id = provider_deploy_reporting(
        &provider,
        &proven_agent(),
        &proven_config(),
        false,
        &agent,
        test_owner(&keys),
    )
    .expect("owner-proven deploy");
    assert_eq!(agent_id, "remote-proven");

    let requests = logged_requests(directory.path());
    let ops: Vec<_> = requests.iter().map(|r| r["op"].clone()).collect();
    assert_eq!(
        ops,
        vec!["info", "deploy_prepare", "deploy_submit"],
        "no unsigned deploy"
    );
    let (prepare, submit) = (&requests[1], &requests[2]);
    assert_eq!(prepare["agent"], proven_agent());
    assert_eq!(prepare["provider_config"], proven_config());
    let request_id = prepare["request_id"].as_str().unwrap();

    let mut keys_sent: Vec<_> = submit.as_object().unwrap().keys().cloned().collect();
    keys_sent.sort();
    assert_eq!(
        keys_sent,
        ["op", "owner_proof", "prepared_body", "request_id"]
    );
    assert_eq!(submit["request_id"], request_id);
    assert_eq!(
        submit["prepared_body"],
        proven_body(&agent, request_id),
        "the prepared body goes back unchanged"
    );

    let proof: nostr::Event = serde_json::from_value(submit["owner_proof"].clone()).unwrap();
    assert!(proof.verify().is_ok());
    assert_eq!(proof.pubkey, keys.public_key(), "signed by the owner");
    assert_eq!(proof.kind.as_u16(), 27_236);
    assert_eq!(proof.content, "buzz-provider-owner-v1");
    let tag = |name: &str| {
        proof
            .tags
            .iter()
            .map(|tag| tag.as_slice())
            .find(|tag| tag.first().map(String::as_str) == Some(name))
            .map(|tag| tag[1].clone())
    };
    assert_eq!(proof.tags.len(), 7);
    assert_eq!(tag("action").as_deref(), Some("provision"));
    assert_eq!(tag("provider").as_deref(), Some("kiingo"));
    assert_eq!(tag("request").as_deref(), Some(request_id));
    assert_eq!(tag("agent").as_deref(), Some(agent.as_str()));
    assert_eq!(tag("community").as_deref(), Some("chat.example.com"));
    assert_eq!(tag("payload").map(|hash| hash.len()), Some(64));
    assert_eq!(
        tag("expires"),
        Some((proof.created_at.as_secs() + 300).to_string())
    );
}

#[cfg(unix)]
#[test]
fn provider_deploy_without_owner_keys_fails_closed_before_submitting() {
    let directory = tempfile::tempdir().unwrap();
    let agent = "c".repeat(64);
    let provider = owner_proof_provider(directory.path(), &agent, None);
    let failure = provider_deploy_reporting(
        &provider,
        &proven_agent(),
        &proven_config(),
        false,
        &agent,
        Err("identity is in recovery mode".to_string()),
    )
    .unwrap_err();
    assert!(failure.message.contains("couldn't sign"), "{failure:?}");
    assert!(!failure.remote_absent);
    let ops: Vec<_> = logged_requests(directory.path())
        .iter()
        .map(|r| r["op"].clone())
        .collect();
    assert_eq!(
        ops,
        vec!["info", "deploy_prepare"],
        "nothing submitted or deployed unsigned"
    );
}

#[cfg(unix)]
#[test]
fn provider_deploy_refuses_a_body_prepared_for_another_agent() {
    let directory = tempfile::tempdir().unwrap();
    let provider = owner_proof_provider(directory.path(), &"d".repeat(64), None);
    let failure = provider_deploy_reporting(
        &provider,
        &serde_json::json!({}),
        &serde_json::json!({}),
        false,
        &"c".repeat(64),
        test_owner(&nostr::Keys::generate()),
    )
    .unwrap_err();
    assert!(failure.message.contains("different agent"), "{failure:?}");
    assert_eq!(
        logged_requests(directory.path()).len(),
        2,
        "nothing submitted"
    );
}

#[cfg(unix)]
#[test]
fn provider_deploy_prepare_failure_is_the_deploy_failure() {
    let directory = tempfile::tempdir().unwrap();
    let provider = owner_proof_provider(
        directory.path(),
        "",
        Some(r#"{"ok":false,"error":"subscription missing","remote_state":"absent"}"#),
    );
    let failure = provider_deploy_reporting(
        &provider,
        &serde_json::json!({}),
        &serde_json::json!({}),
        false,
        &"c".repeat(64),
        test_owner(&nostr::Keys::generate()),
    )
    .unwrap_err();
    assert_eq!(
        failure,
        ProviderDeployFailure {
            message: "subscription missing".to_string(),
            remote_absent: true,
        }
    );
    assert_eq!(
        logged_requests(directory.path()).len(),
        2,
        "no fallback deploy"
    );
}

#[cfg(unix)]
#[test]
fn provider_without_deploy_prepare_gets_the_single_deploy() {
    let directory = tempfile::tempdir().unwrap();
    let provider = owner_proof_provider(
        directory.path(),
        "",
        Some(r#"{"ok":false,"error":"operation_unsupported"}"#),
    );
    let agent_id = provider_deploy_reporting(
        &provider,
        &serde_json::json!({}),
        &serde_json::json!({}),
        false,
        &"c".repeat(64),
        test_owner(&nostr::Keys::generate()),
    )
    .expect("fallback deploy");
    assert_eq!(agent_id, "unsigned");
    let ops: Vec<_> = logged_requests(directory.path())
        .iter()
        .map(|r| r["op"].clone())
        .collect();
    assert_eq!(ops, vec!["info", "deploy_prepare", "deploy"]);
}

#[cfg(unix)]
#[test]
fn provider_deploy_refuses_to_sign_instructions_the_desktop_did_not_send() {
    let directory = tempfile::tempdir().unwrap();
    let agent = "c".repeat(64);
    let provider = owner_proof_provider(directory.path(), &agent, None);
    let mut asked = proven_agent();
    asked["system_prompt"] = "Only answer the owner.".into();
    let failure = provider_deploy_reporting(
        &provider,
        &asked,
        &proven_config(),
        false,
        &agent,
        test_owner(&nostr::Keys::generate()),
    )
    .unwrap_err();
    assert!(
        failure.message.contains("different instructions"),
        "{failure:?}"
    );
    assert_eq!(
        logged_requests(directory.path()).len(),
        2,
        "nothing signed or submitted"
    );
}

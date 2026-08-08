use sha2::{Digest, Sha256};

const PROVIDER_PROTOCOL_VERSIONS: &[u64] = &[1, 2];

pub(crate) fn validate_provider_info(info: &serde_json::Value) -> Result<u64, String> {
    let object = info
        .as_object()
        .ok_or_else(|| "provider info response must be a JSON object".to_string())?;
    let actual_version = object
        .get("protocol_version")
        .and_then(serde_json::Value::as_u64);
    if !actual_version.is_some_and(|version| PROVIDER_PROTOCOL_VERSIONS.contains(&version)) {
        return Err(match actual_version {
            Some(version) => {
                format!("unsupported provider protocol version {version}; desktop supports 1 and 2")
            }
            None => "provider info response missing integer protocol_version".to_string(),
        });
    }
    if object.get("ok") != Some(&serde_json::Value::Bool(true)) {
        return Err("provider info response must contain ok: true".to_string());
    }
    for field in ["name", "version", "description"] {
        if object
            .get(field)
            .is_none_or(|value| value.as_str().is_none_or(str::is_empty))
        {
            return Err(format!(
                "provider info response missing non-empty string {field}"
            ));
        }
    }
    if !object
        .get("config_schema")
        .is_some_and(serde_json::Value::is_object)
    {
        return Err("provider info response missing object config_schema".to_string());
    }

    const V1_FIELDS: &[&str] = &[
        "ok",
        "name",
        "version",
        "protocol_version",
        "description",
        "config_schema",
    ];
    const V2_FIELDS: &[&str] = &[
        "ok",
        "name",
        "version",
        "protocol_version",
        "description",
        "config_schema",
        "capabilities",
    ];
    let version = actual_version.unwrap_or_default();
    let fields = if version == 1 { V1_FIELDS } else { V2_FIELDS };
    if let Some(field) = object
        .keys()
        .find(|field| !fields.contains(&field.as_str()))
    {
        return Err(format!(
            "provider info response contains unknown field {field}"
        ));
    }
    if version == 2 {
        let capabilities = object
            .get("capabilities")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| "provider v2 info response missing object capabilities".to_string())?;
        const CAPABILITY_FIELDS: &[&str] = &[
            "owns_execution_profile",
            "lifecycle_operations",
            "connection_status",
            "connection_scope_message",
            "self_check",
            "presentation",
        ];
        if let Some(field) = capabilities
            .keys()
            .find(|field| !CAPABILITY_FIELDS.contains(&field.as_str()))
        {
            return Err(format!(
                "provider v2 capabilities contain unknown field {field}"
            ));
        }
        if !capabilities
            .get("owns_execution_profile")
            .is_some_and(serde_json::Value::is_boolean)
        {
            return Err(
                "provider v2 capabilities missing boolean owns_execution_profile".to_string(),
            );
        }
        let operations = capabilities
            .get("lifecycle_operations")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| {
                "provider v2 capabilities missing lifecycle_operations array".to_string()
            })?;
        const OPERATIONS: &[&str] = &["status", "pause", "resume", "delete", "reconcile"];
        if operations.iter().any(|operation| {
            operation
                .as_str()
                .is_none_or(|value| !OPERATIONS.contains(&value))
        }) {
            return Err("provider v2 capabilities contain unsupported lifecycle operation".into());
        }
        if let Some(message) = capabilities.get("connection_scope_message") {
            if message
                .as_str()
                .is_none_or(|value| value.is_empty() || value.len() > 1_000)
            {
                return Err("provider v2 connection_scope_message must be a bounded string".into());
            }
        }
        if capabilities
            .get("self_check")
            .is_some_and(|value| !value.is_boolean())
        {
            return Err("provider v2 self_check must be a boolean".into());
        }
        if let Some(status) = capabilities.get("connection_status") {
            validate_provider_connection_status(status)?;
        }
        if let Some(presentation) = capabilities.get("presentation") {
            validate_provider_presentation(presentation)?;
        }
    }
    Ok(version)
}

fn validate_provider_presentation(presentation: &serde_json::Value) -> Result<(), String> {
    let object = presentation
        .as_object()
        .ok_or_else(|| "provider v2 presentation must be an object".to_string())?;
    if object.keys().any(|field| field != "summary_fields") {
        return Err("provider v2 presentation contains an unknown field".into());
    }
    let fields = object
        .get("summary_fields")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "provider v2 presentation summary_fields must be an array".to_string())?;
    if fields.len() > 8 {
        return Err("provider v2 presentation contains too many summary fields".into());
    }
    for field in fields {
        let field = field.as_object().ok_or_else(|| {
            "provider v2 presentation summary field must be an object".to_string()
        })?;
        const FIELD_NAMES: &[&str] = &["field", "label", "empty_label"];
        if field
            .keys()
            .any(|name| !FIELD_NAMES.contains(&name.as_str()))
        {
            return Err("provider v2 presentation summary field contains an unknown field".into());
        }
        if field
            .get("field")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|value| value.is_empty() || value.len() > 64)
        {
            return Err("provider v2 presentation summary field is invalid".into());
        }
        for optional in ["label", "empty_label"] {
            if field.get(optional).is_some_and(|value| {
                value
                    .as_str()
                    .is_none_or(|value| value.is_empty() || value.len() > 128)
            }) {
                return Err(format!(
                    "provider v2 presentation summary field {optional} is invalid"
                ));
            }
        }
    }
    Ok(())
}

fn validate_provider_connection_status(status: &serde_json::Value) -> Result<(), String> {
    let object = status
        .as_object()
        .ok_or_else(|| "provider v2 connection_status must be an object".to_string())?;
    const FIELDS: &[&str] = &["field", "states"];
    if object.keys().any(|field| !FIELDS.contains(&field.as_str())) {
        return Err("provider v2 connection_status contains an unknown field".into());
    }
    if object
        .get("field")
        .and_then(serde_json::Value::as_str)
        .is_none_or(|value| value.is_empty() || value.len() > 64)
    {
        return Err("provider v2 connection_status field is invalid".into());
    }
    let states = object
        .get("states")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "provider v2 connection_status states must be an object".to_string())?;
    if states.len() > 20 {
        return Err("provider v2 connection_status contains too many states".into());
    }
    for state in states.values() {
        let state = state
            .as_object()
            .ok_or_else(|| "provider v2 connection state must be an object".to_string())?;
        const STATE_FIELDS: &[&str] = &["status", "message", "remediation_url"];
        if state
            .keys()
            .any(|field| !STATE_FIELDS.contains(&field.as_str()))
        {
            return Err("provider v2 connection state contains an unknown field".into());
        }
        let valid_status = state
            .get("status")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| matches!(value, "connected" | "action_required" | "unavailable"));
        if !valid_status {
            return Err("provider v2 connection state status is invalid".into());
        }
        if state
            .get("message")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|value| value.is_empty() || value.len() > 1_000)
        {
            return Err("provider v2 connection state message is invalid".into());
        }
        if let Some(url) = state.get("remediation_url") {
            if !url.is_null()
                && url
                    .as_str()
                    .and_then(|value| url::Url::parse(value).ok())
                    .is_none_or(|url| url.scheme() != "https")
            {
                return Err("provider v2 connection state remediation_url is invalid".into());
            }
        }
    }
    Ok(())
}

fn canonical_provider_value(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(canonical_provider_value).collect())
        }
        serde_json::Value::Object(values) => {
            let mut entries: Vec<_> = values.iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            serde_json::Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key.clone(), canonical_provider_value(value)))
                    .collect(),
            )
        }
        _ => value.clone(),
    }
}

pub(crate) fn provider_config_sha256(config: &serde_json::Value) -> Result<String, String> {
    let canonical = serde_json::to_vec(&canonical_provider_value(config))
        .map_err(|error| format!("failed to canonicalize provider config: {error}"))?;
    Ok(hex::encode(Sha256::digest(canonical)))
}

pub(crate) fn validate_provider_presentation_snapshot(
    name: &Option<String>,
    summary: &[crate::managed_agents::ProviderPresentationItem],
) -> Result<(), String> {
    if name.as_ref().is_some_and(|value| {
        let value = value.trim();
        value.is_empty() || value.len() > 128 || value.chars().any(char::is_control)
    }) {
        return Err("provider display name is invalid".into());
    }
    if summary.len() > 8 {
        return Err("provider display summary contains too many fields".into());
    }
    if summary.iter().any(|item| {
        [&item.label, &item.value].iter().any(|value| {
            let value = value.trim();
            value.is_empty() || value.len() > 128 || value.chars().any(char::is_control)
        })
    }) {
        return Err("provider display summary contains an invalid value".into());
    }
    Ok(())
}

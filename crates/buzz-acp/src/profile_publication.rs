//! Optional kind:0 profile assertion for agents that run without a desktop.
//!
//! Desktop-managed agents get their profile from the desktop. A hosted
//! `buzz-acp` has no such publisher, so a missing or superseded kind:0 leaves
//! clients rendering the raw pubkey. When `BUZZ_ACP_PROFILE_DISPLAY_NAME` is
//! set, `buzz-acp` checks its own profile once per process and republishes it
//! only when the display name differs, preserving every other field and tag
//! (including a NIP-OA `auth` tag, which binds the pubkey, not the content).

use std::{sync::OnceLock, time::Duration};

use nostr::{EventBuilder, Filter, Kind, Tag};

use crate::relay::RestClient;

const PROFILE_DISPLAY_NAME_ENV: &str = "BUZZ_ACP_PROFILE_DISPLAY_NAME";
const PROFILE_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const PROFILE_RETRY_DELAYS: [Duration; 4] = [
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(60),
];

static STARTED: OnceLock<()> = OnceLock::new();

pub(crate) fn ensure_started(rest: &RestClient) {
    if STARTED.set(()).is_err() {
        return;
    }
    let Some(display_name) = std::env::var(PROFILE_DISPLAY_NAME_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let rest = rest.clone();
    tokio::spawn(async move {
        for delay in std::iter::once(None).chain(PROFILE_RETRY_DELAYS.iter().map(Some)) {
            if let Some(delay) = delay {
                tokio::time::sleep(*delay).await;
            }
            match ensure_display_name(&rest, &display_name).await {
                Ok(()) => return,
                Err(error) => tracing::warn!(
                    target: "buzz::profile",
                    error = %error,
                    "agent profile assertion failed; will retry"
                ),
            }
        }
        tracing::error!(target: "buzz::profile", "agent profile assertion gave up");
    });
}

async fn ensure_display_name(rest: &RestClient, display_name: &str) -> Result<(), String> {
    let own = rest.keys.public_key();
    let filter = Filter::new().kind(Kind::Metadata).author(own).limit(1);
    let response = tokio::time::timeout(PROFILE_REQUEST_TIMEOUT, rest.query(&[filter]))
        .await
        .map_err(|_| "profile query timed out".to_string())?
        .map_err(|error| format!("profile query failed: {error}"))?;
    let current = response
        .as_array()
        .ok_or("profile query returned a non-array response")?
        .iter()
        .filter_map(|value| serde_json::from_value::<nostr::Event>(value.clone()).ok())
        .filter(|event| {
            event.pubkey == own && event.kind == Kind::Metadata && event.verify().is_ok()
        })
        .max_by_key(|event| event.created_at);
    let Some((content, tags)) = profile_update(current.as_ref(), display_name) else {
        tracing::debug!(target: "buzz::profile", "agent profile already current");
        return Ok(());
    };
    // Replaceable events keep the newest created_at; never lose to the current one.
    let created_at = current
        .as_ref()
        .map_or(0, |event| event.created_at.as_secs().saturating_add(1))
        .max(nostr::Timestamp::now().as_secs());
    let event = EventBuilder::new(Kind::Metadata, content)
        .tags(tags)
        .custom_created_at(nostr::Timestamp::from(created_at))
        .sign_with_keys(&rest.keys)
        .map_err(|error| format!("profile signing failed: {error}"))?;
    tokio::time::timeout(PROFILE_REQUEST_TIMEOUT, rest.submit_event(&event))
        .await
        .map_err(|_| "profile submission timed out".to_string())?
        .map_err(|error| format!("profile submission failed: {error}"))?;
    tracing::info!(
        target: "buzz::profile",
        display_name,
        event_id = %event.id,
        "published agent profile display name"
    );
    Ok(())
}

/// Returns the profile content and tags to publish, or `None` when the
/// current profile already carries `display_name`.
fn profile_update(
    current: Option<&nostr::Event>,
    display_name: &str,
) -> Option<(String, Vec<Tag>)> {
    let mut content = current
        .and_then(|event| serde_json::from_str::<serde_json::Value>(&event.content).ok())
        .and_then(|value| match value {
            serde_json::Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();
    if content
        .get("display_name")
        .and_then(serde_json::Value::as_str)
        == Some(display_name)
    {
        return None;
    }
    content.insert("display_name".into(), display_name.into());
    let has_name = content
        .get("name")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|name| !name.trim().is_empty());
    if !has_name {
        content.insert("name".into(), display_name.into());
    }
    let tags = current.map_or_else(Vec::new, |event| event.tags.clone().to_vec());
    Some((serde_json::Value::Object(content).to_string(), tags))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    fn profile(keys: &Keys, content: &str, tags: Vec<Tag>) -> nostr::Event {
        EventBuilder::new(Kind::Metadata, content)
            .tags(tags)
            .sign_with_keys(keys)
            .unwrap()
    }

    #[test]
    fn missing_profile_publishes_display_name_and_name() {
        let (content, tags) = profile_update(None, "Kiingo Buzz").unwrap();
        let value: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"display_name": "Kiingo Buzz", "name": "Kiingo Buzz"})
        );
        assert!(tags.is_empty());
    }

    #[test]
    fn current_display_name_is_left_alone() {
        let keys = Keys::generate();
        let current = profile(&keys, r#"{"display_name":"Kiingo Buzz"}"#, vec![]);
        assert!(profile_update(Some(&current), "Kiingo Buzz").is_none());
    }

    #[test]
    fn superseded_profile_keeps_other_fields_and_tags() {
        let keys = Keys::generate();
        let auth = Tag::parse(["auth", "owner", "", "sig"]).unwrap();
        let current = profile(
            &keys,
            r#"{"name":"kiingo","picture":"https://example.com/a.png"}"#,
            vec![auth.clone()],
        );
        let (content, tags) = profile_update(Some(&current), "Kiingo Buzz").unwrap();
        let value: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "display_name": "Kiingo Buzz",
                "name": "kiingo",
                "picture": "https://example.com/a.png",
            })
        );
        assert_eq!(tags, vec![auth]);
    }

    #[test]
    fn non_object_profile_content_is_replaced() {
        let keys = Keys::generate();
        let current = profile(&keys, "[]", vec![]);
        let (content, _) = profile_update(Some(&current), "Kiingo Buzz").unwrap();
        let value: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(value["display_name"], "Kiingo Buzz");
    }
}

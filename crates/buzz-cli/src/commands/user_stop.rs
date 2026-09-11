//! A bounded read of original Stop evidence through the normal NIP-98 bridge.

use crate::client::{normalize_events, BuzzClient};
use crate::error::CliError;
use crate::validate::{parse_uuid, validate_hex64};
use serde_json::{json, Value};

fn filter(
    channel: &str,
    author: &str,
    roots: &[String],
    since: u64,
    limit: u16,
) -> Result<Value, CliError> {
    let channel = parse_uuid(channel)?;
    validate_hex64(author)?;
    if roots.is_empty()
        || roots.len() > 2
        || !(1..=16).contains(&limit)
        || i64::try_from(since)
            .ok()
            .and_then(|value| chrono::DateTime::from_timestamp(value, 0))
            .is_none()
    {
        return Err(CliError::Usage(
            "stops requires one or two roots, a valid since, and limit 1..16".into(),
        ));
    }
    for root in roots {
        validate_hex64(root)?;
    }
    Ok(
        json!({ "user_stop": true, "kinds": [9], "#h": [channel.to_string()],
        "#e": roots.iter().map(|root| root.to_ascii_lowercase()).collect::<Vec<_>>(),
        "authors": [author.to_ascii_lowercase()], "since": since, "limit": limit }),
    )
}

/// Print complete signed events even in compact mode: these are control proofs,
/// not a chat transcript. Reading does not acknowledge or execute cancellation.
pub async fn read(
    client: &BuzzClient,
    channel: &str,
    author: &str,
    roots: &[String],
    since: u64,
    limit: u16,
) -> Result<(), CliError> {
    let raw = client
        .query(&filter(channel, author, roots, since, limit)?)
        .await?;
    let events: Vec<Value> = serde_json::from_str(&raw)
        .map_err(|_| CliError::Other("invalid Stop evidence response".into()))?;
    if events.len() > usize::from(limit) {
        return Err(CliError::Other(
            "Stop evidence exceeded requested limit".into(),
        ));
    }
    println!("{}", normalize_events(&events));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_filter_is_exact_bounded_and_uses_the_generic_bridge() {
        let channel = "30000000-0000-4000-8000-000000000001";
        let author = "F".repeat(64);
        let roots = vec!["A".repeat(64), "B".repeat(64)];
        assert_eq!(
            filter(channel, &author, &roots, 100, 16).unwrap(),
            json!({
                "user_stop": true, "kinds": [9], "#h": [channel], "#e": ["a".repeat(64), "b".repeat(64)],
                "authors": ["f".repeat(64)], "since": 100, "limit": 16
            })
        );
        for limit in [0, 17] {
            assert!(filter(channel, &author, &roots, 100, limit).is_err());
        }
        assert!(filter(channel, &author, &[], 100, 16).is_err());
        assert!(filter(channel, &author, &roots, u64::MAX, 16).is_err());
        assert!(filter(channel, "not-a-key", &roots, 100, 16).is_err());
        assert!(filter(channel, &author, &["not-a-root".into()], 100, 16).is_err());
    }
}

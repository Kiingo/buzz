//! A DM is addressed to every other participant.
//!
//! The desktop app p-tags every other DM member on each message; `buzz
//! messages send` does the same so a DM from the CLI notifies (and reaches)
//! the other participants, agents included, without an explicit `--mention`.
//! These implicit tags are not deliberate mentions: they never count as a
//! floor handoff or carry relay provenance.

use crate::client::BuzzClient;

fn has_tag(event: &serde_json::Value, name: &str, value: &str) -> bool {
    event
        .get("tags")
        .and_then(|t| t.as_array())
        .is_some_and(|tags| {
            tags.iter().any(|tag| {
                let parts = tag.as_array();
                parts.and_then(|p| p.first()).and_then(|v| v.as_str()) == Some(name)
                    && parts.and_then(|p| p.get(1)).and_then(|v| v.as_str()) == Some(value)
            })
        })
}

fn first_event(raw: &str) -> Option<serde_json::Value> {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()?
        .as_array()?
        .first()
        .cloned()
}

/// Other members of `channel_id` when it is a DM; empty otherwise or when
/// the channel cannot be resolved (best effort: never blocks a send).
pub(crate) async fn other_dm_participants(
    client: &BuzzClient,
    channel_id: &str,
    self_pubkey: &str,
) -> Vec<String> {
    let metadata = serde_json::json!({"kinds": [39000], "#d": [channel_id], "limit": 1});
    let Some(meta) = client
        .query(&metadata)
        .await
        .ok()
        .as_deref()
        .and_then(first_event)
    else {
        return Vec::new();
    };
    if !has_tag(&meta, "t", "dm") {
        return Vec::new();
    }
    let roster = serde_json::json!({"kinds": [39002], "#d": [channel_id], "limit": 1});
    let Some(members) = client
        .query(&roster)
        .await
        .ok()
        .as_deref()
        .and_then(first_event)
    else {
        return Vec::new();
    };
    others(&super::messages::member_pubkeys_of(&members), self_pubkey)
}

/// `members` without `self_pubkey`, lowercase and de-duplicated.
pub(crate) fn others(members: &[String], self_pubkey: &str) -> Vec<String> {
    let me = self_pubkey.to_ascii_lowercase();
    let mut out: Vec<String> = Vec::new();
    for member in members {
        let member = member.to_ascii_lowercase();
        if member != me && !out.contains(&member) {
            out.push(member);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excludes_self_and_duplicates() {
        let me = "a".repeat(64);
        let other = "B".repeat(64);
        let members = vec![me.clone(), other.clone(), other.to_ascii_lowercase()];
        assert_eq!(others(&members, &me), vec!["b".repeat(64)]);
    }

    #[test]
    fn dm_tag_detection() {
        let dm = serde_json::json!({"tags": [["d", "x"], ["t", "dm"]]});
        let stream = serde_json::json!({"tags": [["d", "x"], ["t", "stream"]]});
        assert!(has_tag(&dm, "t", "dm"));
        assert!(!has_tag(&stream, "t", "dm"));
    }
}

//! A DM is addressed to every other participant.
//!
//! The desktop app p-tags every other DM member on each message; `buzz
//! messages send` does the same so a DM from the CLI notifies (and reaches)
//! the other participants, agents included, without an explicit `--mention`.
//! These implicit tags are not deliberate mentions: they never count as a
//! floor handoff or carry relay provenance.

use crate::client::BuzzClient;

/// Whether channel metadata declares a DM. The channel type is the FIRST `t`
/// tag; later `t` tags are labels (a `stream` channel labelled `dm` is not a DM).
fn is_dm_metadata(event: &serde_json::Value) -> bool {
    event
        .get("tags")
        .and_then(|t| t.as_array())
        .and_then(|tags| {
            tags.iter().find_map(|tag| {
                let parts = tag.as_array()?;
                (parts.first()?.as_str()? == "t").then(|| parts.get(1)?.as_str())?
            })
        })
        == Some("dm")
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
    if !is_dm_metadata(&meta) {
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
        let labelled = serde_json::json!({"tags": [["d", "x"], ["t", "stream"], ["t", "dm"]]});
        assert!(is_dm_metadata(&dm));
        assert!(!is_dm_metadata(&stream));
        assert!(
            !is_dm_metadata(&labelled),
            "only the first `t` tag is the type"
        );
    }
}

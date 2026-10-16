//! Display data sent to the renderer for a consent prompt. No key material.

use serde::Serialize;
use serde_json::Value;

use super::validate::{Operation, Requester, ValidatedRequest};

/// What a read authorization would let the broker read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReadView {
    kinds: Vec<u16>,
    /// Every channel named by a `#h` filter.
    channel_ids: Vec<String>,
    /// True when some filter is not bound to a channel.
    unbound: bool,
    search: Option<String>,
    filters_json: String,
}

/// Display data for one consent prompt. No key material.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PromptView {
    pub(super) request_id: String,
    /// `publish` or `read`.
    method: &'static str,
    action: String,
    server_action_label: Option<String>,
    kind: Option<u16>,
    content: Option<String>,
    /// Where the event is posted (`h` tag) or the channel a read is bound to.
    channel_id: Option<String>,
    /// The channel the broker reported.
    reported_channel_id: Option<String>,
    target_event_id: Option<String>,
    target_content: Option<String>,
    mentions: Vec<String>,
    is_reply: bool,
    read: Option<ReadView>,
    requester: Requester,
    deadline_ms: i64,
}

pub(super) fn prompt_view(
    request: &ValidatedRequest,
    target_content: Option<String>,
) -> PromptView {
    let mut view = PromptView {
        request_id: request.request_id.clone(),
        method: "publish",
        action: request.action.clone(),
        server_action_label: request.server_action_label.clone(),
        kind: None,
        content: None,
        channel_id: None,
        reported_channel_id: request.reported_channel_id.clone(),
        target_event_id: None,
        target_content,
        mentions: Vec::new(),
        is_reply: false,
        read: None,
        requester: request.requester.clone(),
        deadline_ms: request.deadline_ms,
    };
    match &request.operation {
        Operation::Publish {
            event,
            channel_id,
            target_event_id,
            mentions,
            ..
        } => {
            view.kind = Some(event.kind.as_u16());
            view.content = Some(event.content.clone());
            view.channel_id = channel_id.clone();
            view.target_event_id = target_event_id.clone();
            view.mentions = mentions.clone();
            view.is_reply = event.kind.as_u16() == 9
                && event
                    .tags
                    .iter()
                    .any(|tag| tag.as_slice().first().map(String::as_str) == Some("e"));
        }
        Operation::Query {
            filters,
            channel_id,
            ..
        } => {
            view.method = "read";
            view.channel_id = channel_id.clone();
            view.read = Some(read_view(filters));
        }
    }
    view
}

fn read_view(filters: &[Value]) -> ReadView {
    let mut kinds = Vec::new();
    let mut channel_ids = Vec::new();
    let mut unbound = false;
    let mut search = None;
    for filter in filters {
        for kind in filter
            .get("kinds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(kind) = kind.as_u64().and_then(|k| u16::try_from(k).ok()) {
                if !kinds.contains(&kind) {
                    kinds.push(kind);
                }
            }
        }
        match filter.get("#h").and_then(Value::as_array) {
            Some(ids) if !ids.is_empty() => {
                for id in ids.iter().filter_map(Value::as_str) {
                    if !channel_ids.iter().any(|known| known == id) {
                        channel_ids.push(id.to_string());
                    }
                }
            }
            _ => unbound = true,
        }
        if search.is_none() {
            search = filter
                .get("search")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
    }
    ReadView {
        kinds,
        channel_ids,
        unbound,
        search,
        filters_json: serde_json::to_string_pretty(filters).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn read_views_name_every_channel_and_flag_unbound_filters() {
        let view = read_view(&[
            json!({ "kinds": [9, 40002], "#h": ["a"], "limit": 50 }),
            json!({ "kinds": [9], "search": "launch" }),
        ]);
        assert_eq!(view.kinds, vec![9, 40002]);
        assert_eq!(view.channel_ids, vec!["a".to_string()]);
        assert!(view.unbound);
        assert_eq!(view.search.as_deref(), Some("launch"));
    }
}

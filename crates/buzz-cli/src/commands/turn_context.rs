//! Default reply destination supplied by the ACP harness for the current turn.
//!
//! `buzz-acp` exports `BUZZ_TURN_CONTEXT_FILE` to each agent process and,
//! while a turn runs, writes `{"channel_id": "<uuid>", "reply_to": "<hex>"|null}`
//! there. A chat message sent to that channel without `--reply-to` or
//! `--top-level` replies in the thread that triggered the turn. Another
//! channel, a missing file (no turn in progress), or a `null` target (a
//! top-level DM, answered top-level) leaves the plain top-level default.

use uuid::Uuid;

const TURN_CONTEXT_FILE_ENV: &str = "BUZZ_TURN_CONTEXT_FILE";

/// Resolve the reply target for `buzz messages send`.
///
/// An explicit `--reply-to` always wins; `--top-level` opts out of the turn
/// default; only chat messages (default kind or kind 9) are defaulted.
pub(crate) fn resolve_reply_to(
    explicit: Option<String>,
    top_level: bool,
    kind: Option<u16>,
    channel: Uuid,
) -> (Option<String>, bool) {
    if explicit.is_some() || top_level || !matches!(kind, None | Some(9)) {
        return (explicit, false);
    }
    let contents =
        std::env::var_os(TURN_CONTEXT_FILE_ENV).and_then(|path| std::fs::read_to_string(path).ok());
    let default = contents.and_then(|c| default_for_channel(&c, channel));
    let applied = default.is_some();
    (default, applied)
}

fn default_for_channel(contents: &str, channel: Uuid) -> Option<String> {
    let context: serde_json::Value = serde_json::from_str(contents).ok()?;
    let turn_channel = Uuid::parse_str(context.get("channel_id")?.as_str()?).ok()?;
    let reply_to = context.get("reply_to")?.as_str()?.to_ascii_lowercase();
    (turn_channel == channel
        && reply_to.len() == 64
        && reply_to.bytes().all(|b| b.is_ascii_hexdigit()))
    .then_some(reply_to)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(channel: Uuid, reply_to: Option<&str>) -> String {
        serde_json::json!({ "channel_id": channel.to_string(), "reply_to": reply_to }).to_string()
    }

    #[test]
    fn same_channel_defaults_to_the_turn_thread() {
        let channel = Uuid::new_v4();
        let root = "A".repeat(64);
        assert_eq!(
            default_for_channel(&context(channel, Some(&root)), channel),
            Some("a".repeat(64))
        );
    }

    #[test]
    fn other_channel_and_top_level_dm_are_unaffected() {
        let channel = Uuid::new_v4();
        let root = "a".repeat(64);
        let other = context(Uuid::new_v4(), Some(&root));
        assert_eq!(default_for_channel(&other, channel), None);
        assert_eq!(default_for_channel(&context(channel, None), channel), None);
        assert_eq!(default_for_channel("not json", channel), None);
        assert_eq!(
            default_for_channel(&context(channel, Some("short")), channel),
            None
        );
    }

    #[test]
    fn explicit_reply_top_level_and_non_chat_kinds_skip_the_default() {
        // These return before the turn context file is consulted.
        let channel = Uuid::new_v4();
        let explicit = "b".repeat(64);
        assert_eq!(
            resolve_reply_to(Some(explicit.clone()), false, None, channel),
            (Some(explicit), false)
        );
        assert_eq!(resolve_reply_to(None, true, None, channel), (None, false));
        assert_eq!(
            resolve_reply_to(None, false, Some(45001), channel),
            (None, false)
        );
    }
}

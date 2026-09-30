//! Per-turn state supplied by the ACP harness for the current agent turn.
//!
//! `buzz-acp` exports `BUZZ_TURN_CONTEXT_FILE` to each agent process and,
//! while a turn runs, writes `{"channel_id", "reply_to", "turn_id",
//! "trigger_pubkeys"}` there. Two behaviors hang off it, both limited to chat
//! messages (default kind or kind 9) sent to the turn's channel:
//!
//! - **Default thread.** Without `--reply-to` or `--top-level`, the message
//!   replies in the thread that triggered the turn. A `null` target (a
//!   top-level DM, answered top-level) leaves the plain top-level default.
//! - **Handoff.** A message that `@mention`s someone other than the sender and
//!   the turn's triggering members hands them the floor. The CLI records that
//!   in `handoff.json` beside the turn file, and refuses further chat sends to
//!   the channel in the same turn unless `--after-handoff` is passed, so an
//!   agent cannot ask a question and post the conclusion before the answer.
//!   The harness clears the marker when a turn starts or ends; the marker
//!   carries the `turn_id`, so a leftover from another turn is ignored.
//!
//! Another channel or a missing file (no turn in progress) is unaffected.

use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::error::CliError;

const TURN_CONTEXT_FILE_ENV: &str = "BUZZ_TURN_CONTEXT_FILE";
const HANDOFF_FILE_NAME: &str = "handoff.json";
const EXCERPT_CHARS: usize = 120;

/// The current turn, as seen by a chat send to its channel.
#[derive(Debug, Clone)]
pub(crate) struct TurnContext {
    dir: PathBuf,
    reply_to: Option<String>,
    turn_id: Option<String>,
    trigger_pubkeys: Vec<String>,
}

impl TurnContext {
    /// The turn context for a chat send to `channel`, if one is in progress.
    pub(crate) fn for_send(kind: Option<u16>, channel: Uuid) -> Option<Self> {
        if !matches!(kind, None | Some(9)) {
            return None;
        }
        let path = PathBuf::from(std::env::var_os(TURN_CONTEXT_FILE_ENV)?);
        let contents = std::fs::read_to_string(&path).ok()?;
        Self::parse(&path, &contents, channel)
    }

    fn parse(path: &Path, contents: &str, channel: Uuid) -> Option<Self> {
        let context: serde_json::Value = serde_json::from_str(contents).ok()?;
        let turn_channel = Uuid::parse_str(context.get("channel_id")?.as_str()?).ok()?;
        if turn_channel != channel {
            return None;
        }
        let reply_to = context
            .get("reply_to")
            .and_then(|v| v.as_str())
            .map(str::to_ascii_lowercase)
            .filter(|r| is_hex64(r));
        let turn_id = context
            .get("turn_id")
            .and_then(|v| v.as_str())
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        let trigger_pubkeys = context
            .get("trigger_pubkeys")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .map(str::to_ascii_lowercase)
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            dir: path.parent()?.to_path_buf(),
            reply_to,
            turn_id,
            trigger_pubkeys,
        })
    }

    fn handoff_path(&self) -> PathBuf {
        self.dir.join(HANDOFF_FILE_NAME)
    }

    /// This turn's recorded handoff, if any.
    fn handoff(&self) -> Option<serde_json::Value> {
        let turn_id = self.turn_id.as_deref()?;
        let contents = std::fs::read_to_string(self.handoff_path()).ok()?;
        let marker: serde_json::Value = serde_json::from_str(&contents).ok()?;
        (marker.get("turn_id")?.as_str()? == turn_id).then_some(marker)
    }

    /// Refuse a send after this turn handed the floor to someone else.
    pub(crate) fn check_handoff(&self, after_handoff: bool) -> Result<(), CliError> {
        if after_handoff {
            return Ok(());
        }
        let Some(marker) = self.handoff() else {
            return Ok(());
        };
        Err(CliError::Usage(handoff_refusal(&marker)))
    }

    /// Record a handoff if a sent message mentioned anyone other than the
    /// sender and the turn's triggering members. Best effort: a failed write
    /// only loses the guard, never the already-sent message.
    pub(crate) fn record_sent(
        &self,
        self_pubkey: &str,
        mentions: &[String],
        event_id: Option<&str>,
        content: &str,
    ) {
        let Some(turn_id) = self.turn_id.as_deref() else {
            return;
        };
        let handed = handoff_recipients(mentions, self_pubkey, &self.trigger_pubkeys);
        if handed.is_empty() {
            return;
        }
        let mut pubkeys: Vec<String> = self
            .handoff()
            .and_then(|m| m.get("pubkeys").cloned())
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        for pubkey in handed {
            if !pubkeys.contains(&pubkey) {
                pubkeys.push(pubkey);
            }
        }
        let marker = serde_json::json!({
            "turn_id": turn_id,
            "pubkeys": pubkeys,
            "event_id": event_id,
            "excerpt": excerpt(content),
        });
        let tmp = self.dir.join(format!(
            "{HANDOFF_FILE_NAME}.{}.tmp",
            Uuid::new_v4().simple()
        ));
        let written = std::fs::write(&tmp, marker.to_string())
            .and_then(|()| std::fs::rename(&tmp, self.handoff_path()));
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/// Mentioned members other than the sender and those who triggered the turn.
fn handoff_recipients(mentions: &[String], self_pubkey: &str, triggers: &[String]) -> Vec<String> {
    let self_pubkey = self_pubkey.to_ascii_lowercase();
    let mut handed: Vec<String> = Vec::new();
    for mention in mentions {
        let mention = mention.to_ascii_lowercase();
        if mention != self_pubkey && !triggers.contains(&mention) && !handed.contains(&mention) {
            handed.push(mention);
        }
    }
    handed
}

fn excerpt(content: &str) -> String {
    let flat = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= EXCERPT_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(EXCERPT_CHARS).collect();
    format!("{cut}…")
}

fn handoff_refusal(marker: &serde_json::Value) -> String {
    let count = marker
        .get("pubkeys")
        .and_then(|v| v.as_array())
        .map_or(0, Vec::len);
    let who = if count == 1 {
        "a member".to_string()
    } else {
        format!("{count} members")
    };
    let quoted = marker
        .get("excerpt")
        .and_then(|v| v.as_str())
        .filter(|e| !e.is_empty())
        .map(|e| format!(" (\"{e}\")"))
        .unwrap_or_default();
    format!(
        "not sent: you handed the floor to {who} this turn{quoted}. End your turn now; \
         their reply will wake you. Do not post a decision, summary, or wrap-up until everyone \
         you asked has answered. Pass --after-handoff only if this message does not depend on \
         their answer."
    )
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Resolve the reply target for `buzz messages send`.
///
/// An explicit `--reply-to` always wins; `--top-level` opts out of the turn
/// default; only an in-turn chat send to the turn's channel is defaulted.
pub(crate) fn resolve_reply_to(
    explicit: Option<String>,
    top_level: bool,
    turn: Option<&TurnContext>,
) -> (Option<String>, bool) {
    if explicit.is_some() || top_level {
        return (explicit, false);
    }
    let default = turn.and_then(|t| t.reply_to.clone());
    let applied = default.is_some();
    (default, applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Turn {
        dir: PathBuf,
        path: PathBuf,
    }

    impl Turn {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("buzz-cli-turn-{}", Uuid::new_v4()));
            std::fs::create_dir(&dir).unwrap();
            let path = dir.join("turn.json");
            Self { dir, path }
        }

        /// Write a turn as buzz-acp does and return its view for `channel`.
        fn publish(
            &self,
            turn_channel: Uuid,
            reply_to: Option<&str>,
            triggers: &[&str],
            channel: Uuid,
        ) -> Option<TurnContext> {
            let body = context(turn_channel, reply_to, triggers);
            std::fs::write(&self.path, &body).unwrap();
            TurnContext::parse(&self.path, &body, channel)
        }
    }

    impl Drop for Turn {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn context(channel: Uuid, reply_to: Option<&str>, triggers: &[&str]) -> String {
        serde_json::json!({
            "channel_id": channel.to_string(),
            "reply_to": reply_to,
            "turn_id": Uuid::new_v4().to_string(),
            "trigger_pubkeys": triggers,
        })
        .to_string()
    }

    const ME: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const TRIGGER: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const JUNIPER: &str = "3333333333333333333333333333333333333333333333333333333333333333";

    #[test]
    fn same_channel_defaults_to_the_turn_thread() {
        let turn = Turn::new();
        let channel = Uuid::new_v4();
        let root = "A".repeat(64);
        let ctx = turn.publish(channel, Some(&root), &[], channel).unwrap();
        assert_eq!(
            resolve_reply_to(None, false, Some(&ctx)),
            (Some("a".repeat(64)), true)
        );
    }

    #[test]
    fn other_channel_and_top_level_dm_are_unaffected() {
        let turn = Turn::new();
        let channel = Uuid::new_v4();
        let root = "a".repeat(64);
        assert!(turn
            .publish(Uuid::new_v4(), Some(&root), &[], channel)
            .is_none());
        let dm = turn.publish(channel, None, &[], channel).unwrap();
        assert_eq!(resolve_reply_to(None, false, Some(&dm)), (None, false));
        let short = turn.publish(channel, Some("short"), &[], channel).unwrap();
        assert_eq!(resolve_reply_to(None, false, Some(&short)), (None, false));
        assert!(TurnContext::parse(&turn.path, "not json", channel).is_none());
    }

    #[test]
    fn explicit_reply_top_level_and_non_chat_kinds_skip_the_default() {
        let turn = Turn::new();
        let channel = Uuid::new_v4();
        let ctx = turn
            .publish(channel, Some(&"c".repeat(64)), &[], channel)
            .unwrap();
        let explicit = "b".repeat(64);
        assert_eq!(
            resolve_reply_to(Some(explicit.clone()), false, Some(&ctx)),
            (Some(explicit), false)
        );
        assert_eq!(resolve_reply_to(None, true, Some(&ctx)), (None, false));
        // Non-chat kinds never see a turn context (checked before any read).
        assert!(TurnContext::for_send(Some(45001), channel).is_none());
    }

    #[test]
    fn handoff_then_second_send_is_refused_unless_overridden() {
        let turn = Turn::new();
        let channel = Uuid::new_v4();
        let ctx = turn.publish(channel, None, &[TRIGGER], channel).unwrap();

        // The handoff message itself (answering the trigger and passing the
        // floor to the next speaker) is allowed.
        ctx.check_handoff(false).unwrap();
        ctx.record_sent(
            ME,
            &[TRIGGER.into(), JUNIPER.into()],
            Some("ee"),
            "@Juniper does an allowlist guardrail solve it for you?",
        );

        let err = ctx.check_handoff(false).unwrap_err().to_string();
        assert!(err.contains("handed the floor"), "{err}");
        assert!(err.contains("--after-handoff"), "{err}");
        assert!(err.contains("allowlist guardrail"), "{err}");

        // The override lets a message that does not depend on the answer through.
        ctx.check_handoff(true).unwrap();
    }

    #[test]
    fn answering_the_trigger_or_self_is_not_a_handoff() {
        let turn = Turn::new();
        let channel = Uuid::new_v4();
        let ctx = turn.publish(channel, None, &[TRIGGER], channel).unwrap();
        // A callback mention of the delegator who woke us, then more posts.
        ctx.record_sent(ME, &[TRIGGER.to_uppercase(), ME.into()], None, "done");
        ctx.check_handoff(false).unwrap();
        ctx.record_sent(ME, &[], None, "follow-up");
        ctx.check_handoff(false).unwrap();
        assert!(!turn.dir.join(HANDOFF_FILE_NAME).exists());
    }

    #[test]
    fn handoff_is_scoped_to_the_turn_channel_and_turn() {
        let turn = Turn::new();
        let channel = Uuid::new_v4();
        let ctx = turn.publish(channel, None, &[TRIGGER], channel).unwrap();
        ctx.record_sent(ME, &[JUNIPER.into()], None, "@Juniper thoughts?");
        ctx.check_handoff(false).unwrap_err();

        // Another channel has no turn context, so nothing is refused there.
        assert!(turn
            .publish(channel, None, &[TRIGGER], Uuid::new_v4())
            .is_none());

        // The next turn gets a new turn_id; a leftover marker is inert even if
        // the harness had not cleared it.
        let next = turn.publish(channel, None, &[JUNIPER], channel).unwrap();
        assert!(turn.dir.join(HANDOFF_FILE_NAME).exists());
        next.check_handoff(false).unwrap();
    }

    #[test]
    fn repeated_handoffs_accumulate_recipients() {
        let turn = Turn::new();
        let channel = Uuid::new_v4();
        let ctx = turn.publish(channel, None, &[TRIGGER], channel).unwrap();
        let other = "4".repeat(64);
        ctx.record_sent(ME, &[JUNIPER.into()], None, "a");
        ctx.record_sent(ME, &[other.clone(), JUNIPER.into()], None, "b");
        let marker = ctx.handoff().unwrap();
        assert_eq!(marker["pubkeys"], serde_json::json!([JUNIPER, other]));
        assert!(ctx
            .check_handoff(false)
            .unwrap_err()
            .to_string()
            .contains("2 members"));
    }

    #[test]
    fn sends_outside_a_turn_have_no_context_and_are_never_refused() {
        // No test publishes a turn for this fresh channel, so whether or not
        // BUZZ_TURN_CONTEXT_FILE is set in the environment, there is no turn.
        let channel = Uuid::new_v4();
        assert!(TurnContext::for_send(None, channel).is_none());
        assert_eq!(resolve_reply_to(None, false, None), (None, false));
        // A turn file written by an older harness (no turn_id) never refuses.
        let turn = Turn::new();
        let legacy =
            serde_json::json!({ "channel_id": channel.to_string(), "reply_to": null }).to_string();
        let ctx = TurnContext::parse(&turn.path, &legacy, channel).unwrap();
        ctx.record_sent(ME, &[JUNIPER.into()], None, "@Juniper?");
        ctx.check_handoff(false).unwrap();
    }

    #[test]
    fn long_excerpts_are_truncated() {
        let long = "word ".repeat(100);
        let e = excerpt(&long);
        assert_eq!(e.chars().count(), EXCERPT_CHARS + 1);
        assert!(e.ends_with('…'));
    }
}

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
//!   Parallel sends in one turn serialize on an advisory lock on
//!   `handoff.lock` in the same directory, held from the check until the
//!   marker is written, so two sends cannot both pass the check before either
//!   records a handoff. The OS drops the lock if the holder exits.
//!
//! Another channel or a missing file (no turn in progress) is unaffected.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::error::CliError;

const TURN_CONTEXT_FILE_ENV: &str = "BUZZ_TURN_CONTEXT_FILE";
const HANDOFF_FILE_NAME: &str = "handoff.json";
const EXCERPT_CHARS: usize = 120;
const FLOOR_LOCK_FILE_NAME: &str = "handoff.lock";
const FLOOR_LOCK_TIMEOUT: Duration = Duration::from_secs(60);
const FLOOR_LOCK_POLL: Duration = Duration::from_millis(25);

/// Exclusive hold on the turn's floor, released when dropped (or when the
/// process exits).
#[derive(Debug)]
pub(crate) struct FloorLock {
    _file: std::fs::File,
}

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

    /// Serialize this send's handoff check, send, and marker write with any
    /// other send in the same turn. Hold the result until after
    /// [`Self::record_sent`]. Best effort like the marker itself: a turn file
    /// without a `turn_id` or a lock the filesystem cannot provide yields no
    /// lock; only a holder that outlasts the timeout refuses the send.
    pub(crate) async fn lock_floor(&self) -> Result<Option<FloorLock>, CliError> {
        self.lock_floor_within(FLOOR_LOCK_TIMEOUT).await
    }

    async fn lock_floor_within(&self, timeout: Duration) -> Result<Option<FloorLock>, CliError> {
        if self.turn_id.is_none() {
            return Ok(None);
        }
        let Ok(file) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.dir.join(FLOOR_LOCK_FILE_NAME))
        else {
            return Ok(None);
        };
        let deadline = Instant::now() + timeout;
        loop {
            // Called through the trait: std's inherent `File::try_lock` is
            // newer than this crate's MSRV.
            match fs4::FileExt::try_lock(&file) {
                Ok(()) => return Ok(Some(FloorLock { _file: file })),
                Err(fs4::TryLockError::WouldBlock) if Instant::now() < deadline => {
                    tokio::time::sleep(FLOOR_LOCK_POLL).await;
                }
                Err(fs4::TryLockError::WouldBlock) => {
                    return Err(CliError::Other(format!(
                        "not sent: another message send in this turn has held the channel for \
                         over {}s; retry once it finishes",
                        timeout.as_secs()
                    )));
                }
                Err(fs4::TryLockError::Error(_)) => return Ok(None),
            }
        }
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

    /// One in-turn chat send as `run_send` performs it: lock, check, send,
    /// record. Logs the order of the checks and returns whether it was sent.
    async fn locked_send(
        ctx: &TurnContext,
        handoff: bool,
        log: &std::sync::Mutex<Vec<bool>>,
    ) -> bool {
        let _floor = ctx.lock_floor().await.unwrap();
        let allowed = ctx.check_handoff(false).is_ok();
        log.lock().unwrap().push(handoff);
        // Widen the check-to-record window a real network send would have.
        tokio::time::sleep(Duration::from_millis(20)).await;
        if allowed {
            let mentions: Vec<String> = if handoff {
                vec![JUNIPER.into()]
            } else {
                vec![]
            };
            ctx.record_sent(ME, &mentions, None, "@Juniper thoughts?");
        }
        allowed
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn parallel_sends_see_a_handoff_recorded_by_the_other() {
        for round in 0..10 {
            let turn = Turn::new();
            let channel = Uuid::new_v4();
            // Each send is its own process, with its own view and lock handle.
            let a = turn.publish(channel, None, &[TRIGGER], channel).unwrap();
            let b = TurnContext::parse(
                &turn.path,
                &std::fs::read_to_string(&turn.path).unwrap(),
                channel,
            )
            .unwrap();
            let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let (la, lb) = (log.clone(), log.clone());
            // Alternate which send starts first; both race for the floor.
            let (handoff, plain) = if round % 2 == 0 {
                let h = tokio::spawn(async move { locked_send(&a, true, &la).await });
                (
                    h,
                    tokio::spawn(async move { locked_send(&b, false, &lb).await }),
                )
            } else {
                let p = tokio::spawn(async move { locked_send(&b, false, &lb).await });
                (
                    tokio::spawn(async move { locked_send(&a, true, &la).await }),
                    p,
                )
            };
            let (handoff, plain) = (handoff.await.unwrap(), plain.await.unwrap());
            assert!(handoff, "nothing precedes the handoff that could refuse it");
            if log.lock().unwrap()[0] {
                assert!(!plain, "a send checked after the handoff must be refused");
            } else {
                assert!(plain, "a send checked before the handoff goes out");
            }
        }
    }

    #[tokio::test]
    async fn floor_lock_is_exclusive_and_released_on_error() {
        let turn = Turn::new();
        let channel = Uuid::new_v4();
        let ctx = turn.publish(channel, None, &[TRIGGER], channel).unwrap();
        let short = Duration::from_millis(60);

        let held = ctx.lock_floor().await.unwrap().expect("in-turn lock");
        let err = ctx.lock_floor_within(short).await.unwrap_err().to_string();
        assert!(err.contains("another message send"), "{err}");
        ctx.record_sent(ME, &[JUNIPER.into()], None, "@Juniper thoughts?");
        drop(held);

        // A refused send returns early with `?`; its lock goes with it.
        async fn send(ctx: &TurnContext) -> Result<(), CliError> {
            let _floor = ctx.lock_floor().await?;
            ctx.check_handoff(false)?;
            Ok(())
        }
        send(&ctx).await.unwrap_err();
        assert!(ctx.lock_floor_within(short).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn no_floor_lock_without_a_turn_id() {
        let turn = Turn::new();
        let channel = Uuid::new_v4();
        let legacy =
            serde_json::json!({ "channel_id": channel.to_string(), "reply_to": null }).to_string();
        let ctx = TurnContext::parse(&turn.path, &legacy, channel).unwrap();
        assert!(ctx.lock_floor().await.unwrap().is_none());
        assert!(!turn.dir.join(FLOOR_LOCK_FILE_NAME).exists());
    }

    #[test]
    fn long_excerpts_are_truncated() {
        let long = "word ".repeat(100);
        let e = excerpt(&long);
        assert_eq!(e.chars().count(), EXCERPT_CHARS + 1);
        assert!(e.ends_with('…'));
    }
}

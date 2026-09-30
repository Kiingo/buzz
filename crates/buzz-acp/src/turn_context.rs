//! Per-turn reply destination shared with the agent's tools.
//!
//! Each agent process is spawned with [`TURN_CONTEXT_FILE_ENV`] naming a file
//! in a private directory. While a turn runs, the harness writes the turn's
//! channel and default reply target there; `buzz messages send` reads it and,
//! when the target channel matches and no `--reply-to`/`--top-level` is given,
//! replies in the thread that triggered the turn. The file is removed when the
//! turn ends, so work outside a turn keeps the CLI's plain top-level default.
//!
//! A process runs one turn at a time (pool slots are checked out exclusively),
//! but the returning turn's guard may drop after the next turn has published.
//! A generation counter under a mutex keeps a stale guard from removing the
//! newer turn's file.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use buzz_core::kind::KIND_AGENT_INVOCATION;
use uuid::Uuid;

use crate::queue::{parse_thread_tags, FlushBatch, PromptProfileLookup};

/// Environment variable naming the per-process turn context file.
pub(crate) const TURN_CONTEXT_FILE_ENV: &str = "BUZZ_TURN_CONTEXT_FILE";

/// Default reply target for ordinary chat posts in this turn's channel.
///
/// Mirrors the reply destination the prompt supplies in `<context>`:
///   - DM: thread replies answer the trigger; top-level DMs stay top-level.
///   - Human-facing channel turn: the thread root, or the triggering top-level
///     event (which becomes the root).
///   - Agent-only channel turn: the triggering event, so the answer stays in
///     the thread that woke the agent (nesting is allowed there).
///
/// Authenticated invocations carry no chat trigger and get no default.
pub(crate) fn default_reply_to(
    batch: &FlushBatch,
    is_dm: bool,
    profile_lookup: Option<&PromptProfileLookup>,
) -> Option<String> {
    let trigger = &batch.events.last()?.event;
    if trigger.kind.as_u16() as u32 == KIND_AGENT_INVOCATION {
        return None;
    }
    let tags = parse_thread_tags(trigger);
    let trigger_id = trigger.id.to_hex();
    if is_dm {
        return tags.root_event_id.is_some().then_some(trigger_id);
    }
    crate::queue::resolve_reply_anchor(&trigger.pubkey.to_hex(), &tags, &trigger_id, profile_lookup)
        .or(Some(trigger_id))
}

struct Inner {
    dir: PathBuf,
    path: PathBuf,
    generation: Mutex<u64>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The turn context file owned by one agent process.
#[derive(Clone)]
pub(crate) struct TurnContextFile {
    inner: Option<Arc<Inner>>,
}

impl TurnContextFile {
    /// Create a private directory for a new agent process. On failure the
    /// process simply runs without a turn context (plain CLI defaults).
    pub(crate) fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("buzz-turn-{}", Uuid::new_v4().simple()));
        let builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        let builder = {
            let mut builder = builder;
            std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
            builder
        };
        if let Err(error) = builder.create(&dir) {
            tracing::warn!(%error, "turn context directory unavailable");
            return Self { inner: None };
        }
        let path = dir.join("turn.json");
        Self {
            inner: Some(Arc::new(Inner {
                dir,
                path,
                generation: Mutex::new(0),
            })),
        }
    }

    /// Path exported to the agent process, if the directory exists.
    pub(crate) fn path(&self) -> Option<&Path> {
        self.inner.as_ref().map(|inner| inner.path.as_path())
    }

    /// Publish this turn's context; it is removed when the guard drops.
    pub(crate) fn publish(&self, channel_id: Uuid, reply_to: Option<&str>) -> TurnContextGuard {
        let Some(inner) = self.inner.clone() else {
            return TurnContextGuard {
                inner: None,
                generation: 0,
            };
        };
        let body = serde_json::json!({
            "channel_id": channel_id.to_string(),
            "reply_to": reply_to,
        })
        .to_string();
        let mut generation = lock(&inner.generation);
        *generation += 1;
        let tmp = inner.dir.join("turn.json.tmp");
        if let Err(error) =
            std::fs::write(&tmp, body).and_then(|()| std::fs::rename(&tmp, &inner.path))
        {
            tracing::warn!(%error, "failed to write turn context");
            let _ = std::fs::remove_file(&inner.path);
        }
        let current = *generation;
        drop(generation);
        TurnContextGuard {
            inner: Some(inner),
            generation: current,
        }
    }
}

fn lock(generation: &Mutex<u64>) -> std::sync::MutexGuard<'_, u64> {
    generation
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Removes the turn context when the turn ends, unless a newer turn replaced it.
pub(crate) struct TurnContextGuard {
    inner: Option<Arc<Inner>>,
    generation: u64,
}

impl Drop for TurnContextGuard {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.take() {
            let generation = lock(&inner.generation);
            if *generation == self.generation {
                let _ = std::fs::remove_file(&inner.path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use nostr::{EventBuilder, EventId, Keys, Kind, Tag};

    use super::*;
    use crate::queue::{BatchEvent, PromptProfile};

    fn message(keys: &Keys, root: Option<EventId>, mention: Option<&Keys>) -> nostr::Event {
        let mut tags = vec![];
        if let Some(root) = root {
            tags.push(Tag::parse(["e", &root.to_hex(), "", "root"]).unwrap());
            tags.push(Tag::parse(["e", &root.to_hex(), "", "reply"]).unwrap());
        }
        if let Some(mention) = mention {
            tags.push(Tag::parse(["p", &mention.public_key().to_hex()]).unwrap());
        }
        EventBuilder::new(Kind::Custom(9), "hi")
            .tags(tags)
            .sign_with_keys(keys)
            .unwrap()
    }

    fn batch(event: nostr::Event) -> FlushBatch {
        FlushBatch {
            channel_id: Uuid::new_v4(),
            events: vec![BatchEvent {
                event,
                prompt_tag: "test".into(),
                received_at: Instant::now(),
            }],
            cancelled_events: vec![],
            cancel_reason: None,
        }
    }

    fn agents(keys: &[&Keys]) -> PromptProfileLookup {
        keys.iter()
            .map(|k| {
                (
                    k.public_key().to_hex(),
                    PromptProfile {
                        display_name: None,
                        nip05_handle: None,
                        is_agent: true,
                    },
                )
            })
            .collect()
    }

    #[test]
    fn agent_handoff_inside_a_thread_defaults_into_that_thread() {
        // The production failure: an agent @mentions another agent in a
        // thread. The turn is agent-only, so the prompt carries no anchor, but
        // the default must still keep the answer in the thread.
        let (juniper, marlowe) = (Keys::generate(), Keys::generate());
        let root = EventId::all_zeros();
        let trigger = message(&juniper, Some(root), Some(&marlowe));
        let trigger_id = trigger.id.to_hex();
        let lookup = agents(&[&juniper, &marlowe]);
        assert_eq!(
            default_reply_to(&batch(trigger), false, Some(&lookup)),
            Some(trigger_id)
        );
    }

    #[test]
    fn human_thread_defaults_to_root_and_top_level_to_trigger() {
        let human = Keys::generate();
        let root = EventId::all_zeros();
        let threaded = message(&human, Some(root), None);
        assert_eq!(
            default_reply_to(&batch(threaded), false, None),
            Some(root.to_hex())
        );
        let top = message(&human, None, None);
        let top_id = top.id.to_hex();
        assert_eq!(default_reply_to(&batch(top), false, None), Some(top_id));
    }

    #[test]
    fn dm_top_level_stays_top_level_and_dm_thread_replies_to_trigger() {
        let human = Keys::generate();
        let top = message(&human, None, None);
        assert_eq!(default_reply_to(&batch(top), true, None), None);
        let threaded = message(&human, Some(EventId::all_zeros()), None);
        let id = threaded.id.to_hex();
        assert_eq!(default_reply_to(&batch(threaded), true, None), Some(id));
    }

    #[test]
    fn guard_removes_file_unless_a_newer_turn_replaced_it() {
        let file = TurnContextFile::new();
        let path = file.path().unwrap().to_path_buf();
        let channel = Uuid::new_v4();
        let first = file.publish(channel, Some("aa"));
        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["channel_id"], channel.to_string());
        assert_eq!(written["reply_to"], "aa");

        let second = file.publish(channel, None);
        drop(first);
        assert!(path.exists(), "stale guard must not remove the newer turn");
        drop(second);
        assert!(!path.exists());

        let dir = path.parent().unwrap().to_path_buf();
        drop(file);
        assert!(
            !dir.exists(),
            "dropping the last handle removes the directory"
        );
    }
}

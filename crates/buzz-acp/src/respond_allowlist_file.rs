//! Optional respond-to allowlist entries read from a file.
//!
//! `BUZZ_ACP_RESPOND_TO_ALLOWLIST_FILE` names a file of 64-character hex
//! pubkeys, one per line (`#` comments and blank lines ignored). In
//! `allowlist` mode these keys are accepted in addition to
//! `BUZZ_ACP_RESPOND_TO_ALLOWLIST`, so an operator can grant or revoke access
//! by rewriting the file instead of restarting the agent. The file is re-read
//! at most every [`RELOAD_INTERVAL`]; an unreadable file keeps the last good
//! set rather than widening or silently emptying access. DM hardening in the
//! author gate is unaffected: the file never applies inside DMs.

use std::{
    collections::HashSet,
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

pub(crate) const RESPOND_TO_ALLOWLIST_FILE_ENV: &str = "BUZZ_ACP_RESPOND_TO_ALLOWLIST_FILE";
const RELOAD_INTERVAL: Duration = Duration::from_secs(15);

struct Loaded {
    keys: HashSet<String>,
    checked_at: Option<Instant>,
}

static STATE: OnceLock<Mutex<Loaded>> = OnceLock::new();

fn parse(contents: &str) -> HashSet<String> {
    contents
        .lines()
        .map(|line| line.split('#').next().unwrap_or_default().trim())
        .filter(|key| key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .collect()
}

fn refresh(state: &mut Loaded, path: &Path, now: Instant) {
    if state
        .checked_at
        .is_some_and(|checked| now.duration_since(checked) < RELOAD_INTERVAL)
    {
        return;
    }
    state.checked_at = Some(now);
    match std::fs::read_to_string(path) {
        Ok(contents) => {
            let keys = parse(&contents);
            if keys != state.keys {
                tracing::info!(keys = keys.len(), "respond-to allowlist file reloaded");
                state.keys = keys;
            }
        }
        Err(error) => {
            tracing::warn!(%error, "respond-to allowlist file unreadable; keeping last set");
        }
    }
}

/// Whether `author` (lowercase hex) is listed in the allowlist file, if one
/// is configured.
pub(crate) fn contains(author: &str) -> bool {
    let Some(path) = std::env::var_os(RESPOND_TO_ALLOWLIST_FILE_ENV) else {
        return false;
    };
    let state = STATE.get_or_init(|| {
        Mutex::new(Loaded {
            keys: HashSet::new(),
            checked_at: None,
        })
    });
    let mut state = match state.lock() {
        Ok(state) => state,
        Err(poisoned) => poisoned.into_inner(),
    };
    refresh(&mut state, Path::new(&path), Instant::now());
    state.keys.contains(author)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_keys_ignoring_comments_blanks_and_malformed_lines() {
        let a = "a".repeat(64);
        let b = "B".repeat(64);
        let contents = format!(
            "# header\n{a}\n\n  {b}  # trailing\nnot-a-key\n{}\n",
            "c".repeat(63)
        );
        assert_eq!(parse(&contents), HashSet::from([a, "b".repeat(64)]));
    }

    #[test]
    fn reloads_after_the_interval_and_keeps_last_set_when_unreadable() {
        let dir = std::env::temp_dir().join(format!("acp-allowlist-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("allowlist.txt");
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        std::fs::write(&path, format!("{a}\n")).unwrap();
        let mut state = Loaded {
            keys: HashSet::new(),
            checked_at: None,
        };
        let start = Instant::now();
        refresh(&mut state, &path, start);
        assert!(state.keys.contains(&a));

        std::fs::write(&path, format!("{b}\n")).unwrap();
        refresh(&mut state, &path, start + Duration::from_secs(1));
        assert!(state.keys.contains(&a), "reload is throttled");
        refresh(&mut state, &path, start + RELOAD_INTERVAL);
        assert_eq!(state.keys, HashSet::from([b.clone()]));

        std::fs::remove_file(&path).unwrap();
        refresh(&mut state, &path, start + RELOAD_INTERVAL * 2);
        assert_eq!(
            state.keys,
            HashSet::from([b]),
            "unreadable file keeps last set"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

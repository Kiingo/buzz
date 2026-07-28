//! Where an install's output goes: the install log file (complete history) and
//! the live output line in the UI (current progress).
//!
//! Both destinations hang off the same drain seam in
//! [`super::install_capture`], and both are best-effort: an install must never
//! fail because a log write or an event emit did.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::install_capture::{LineObserver, Throttle};
use crate::managed_agents::InstallStepResult;

/// One install command's result: what the UI shows, and the log-scale copy of
/// the same output for the log file.
pub(super) struct InstallOutcome {
    pub(super) step: InstallStepResult,
    pub(super) log_stdout: String,
    pub(super) log_stderr: String,
}

impl InstallOutcome {
    /// A step Buzz synthesized rather than ran — a failed prerequisite, or the
    /// post-install verification. Its own message is the whole record.
    pub(super) fn synthesized(step: InstallStepResult) -> Self {
        Self {
            log_stdout: step.stdout.clone(),
            log_stderr: step.stderr.clone(),
            step,
        }
    }
}

/// Payload of the `acp-install-output` event.
///
/// `attempt` lets the UI drop a line that belongs to a superseded retry:
/// without it, a line emitted just before attempt 2 starts can sit under the
/// spinner while attempt 2 runs.
#[derive(Serialize, Clone)]
pub(super) struct InstallOutputEvent {
    pub(super) runtime_id: String,
    pub(super) attempt: u32,
    pub(super) line: String,
}

/// Emits one live output event. Boxed rather than holding an `AppHandle` so the
/// reporter is constructible — and assertable — without a Tauri app.
type EmitEvent = Arc<dyn Fn(InstallOutputEvent) + Send + Sync>;

/// At most four live-output events per second. Coalescing is by dropping, not
/// buffering: the UI shows only the newest line, so a queued backlog would
/// display stale progress.
const LIVE_LINE_INTERVAL: Duration = Duration::from_millis(250);

pub(super) struct InstallReporter {
    runtime_id: String,
    log_path: Option<PathBuf>,
    emit: Option<EmitEvent>,
    throttle: Arc<Throttle>,
}

impl InstallReporter {
    /// The reporter a real install command uses: it writes the install log and
    /// emits live output events through `app`.
    ///
    /// A log path that cannot be resolved degrades to no log rather than failing
    /// the install — a user with a broken app-data directory still needs the
    /// install itself to work.
    pub(super) fn for_command(app: &tauri::AppHandle, runtime_id: &str) -> Self {
        let log_path = crate::managed_agents::storage::install_log_path(app, runtime_id).ok();
        let app = app.clone();
        let emit: EmitEvent = Arc::new(move |event| {
            use tauri::Emitter;
            let _ = app.emit("acp-install-output", event);
        });
        Self::new(runtime_id, log_path, Some(emit))
    }

    pub(super) fn new(
        runtime_id: &str,
        log_path: Option<PathBuf>,
        emit: Option<EmitEvent>,
    ) -> Self {
        Self {
            runtime_id: runtime_id.to_string(),
            log_path,
            emit,
            throttle: Arc::new(Throttle::new(LIVE_LINE_INTERVAL)),
        }
    }

    /// The log file to point the user at, once something has been written to it.
    /// `None` when this install has no log — the failure message then omits the
    /// pointer rather than naming a file that does not exist.
    pub(super) fn log_path(&self) -> Option<String> {
        let path = self.log_path.as_ref()?;
        path.exists().then(|| path.display().to_string())
    }

    /// Observer for one attempt's drains, or `None` when nothing is listening.
    pub(super) fn line_observer(&self, attempt: u32) -> Option<LineObserver> {
        let emit = Arc::clone(self.emit.as_ref()?);
        let throttle = Arc::clone(&self.throttle);
        let runtime_id = self.runtime_id.clone();
        Some(Arc::new(move |line: &str| {
            if throttle.allows(Instant::now()) {
                emit(InstallOutputEvent {
                    runtime_id: runtime_id.clone(),
                    attempt,
                    line: line.to_string(),
                });
            }
        }))
    }

    /// Record one executed attempt of a step.
    pub(super) fn record_attempt(&self, attempt: u32, outcome: &InstallOutcome) {
        self.write_record(Some(attempt), outcome);
    }

    /// Push a synthesized step onto `steps` and record it. Routing every step
    /// through here is what keeps the log complete: a step that reaches the UI
    /// without passing this function is invisible in the file.
    pub(super) fn record_step(&self, steps: &mut Vec<InstallStepResult>, step: InstallStepResult) {
        self.write_record(None, &InstallOutcome::synthesized(step.clone()));
        steps.push(step);
    }

    /// Append one record. Best-effort by contract: a full disk or a revoked
    /// permission degrades the diagnostics, it does not fail the install.
    fn write_record(&self, attempt: Option<u32>, outcome: &InstallOutcome) {
        let Some(path) = self.log_path.as_ref() else {
            return;
        };
        let record = render_record(attempt, outcome);
        if let Ok(mut file) = crate::managed_agents::storage::open_install_log_file(path) {
            let _ = file.write_all(record.as_bytes());
        }
    }
}

/// One self-contained record. Each is capped independently by the log-scale
/// capture that produced it, so an early attempt that printed megabytes cannot
/// push a later attempt — or the verification step that explains the failure —
/// out of the file.
fn render_record(attempt: Option<u32>, outcome: &InstallOutcome) -> String {
    let step = &outcome.step;
    let attempt = attempt.map_or_else(|| "-".to_string(), |n| n.to_string());
    let exit = step
        .exit_code
        .map_or_else(|| "none".to_string(), |code| code.to_string());
    let mut record = format!(
        "=== {} step={} attempt={attempt} success={} exit={exit}\n$ {}\n",
        chrono::Utc::now().to_rfc3339(),
        step.step,
        step.success,
        redact(&step.command),
    );
    for (label, text) in [
        ("stdout", &outcome.log_stdout),
        ("stderr", &outcome.log_stderr),
    ] {
        if !text.trim().is_empty() {
            record.push_str(&format!("--- {label} ---\n{}\n", redact(text)));
        }
    }
    if let Some(hint) = &step.hint {
        record.push_str(&format!("--- hint ---\n{}\n", redact(hint)));
    }
    record
}

/// Scrub known secret shapes before anything reaches disk. Install output can
/// echo a registry token or a signing key from the environment it ran in, and
/// this file is written unattended.
fn redact(text: &str) -> String {
    crate::managed_agents::redact_secrets_with(text, &[])
}

#[cfg(test)]
#[path = "install_report_tests.rs"]
mod tests;

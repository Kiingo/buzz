//! Execution of runtime install commands: spawning the built command,
//! draining its output under a timeout, and retrying transient failures.
//!
//! Command *construction* stays in the parent module (`install_shell_command`,
//! `install_powershell_command`, `build_install_command`); this module owns
//! only what happens once a `Command` exists.

use std::collections::VecDeque;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::managed_agents::InstallStepResult;

/// Maximum number of attempts for a transient-looking install command.
const INSTALL_MAX_ATTEMPTS: u32 = 3;

/// Absolute wall-clock ceiling for a single install command.
///
/// This is a ceiling, not an inactivity timeout: nothing observable
/// distinguishes a hung installer from one silently transferring a large
/// artifact (the Goose step downloads a ~79MB release asset with no progress
/// output, and npm at its default log level prints only at the end), so silence
/// alone never kills an install. The previous 300s wall killed
/// slow-but-working installs — Windows Defender scanning every file npm
/// extracts pushes past it routinely (#2401).
///
/// The cost of a larger ceiling: skipping onboarding does not cancel a running
/// install and a per-runtime guard rejects a second one, so this is also the
/// longest a user who skipped a genuinely *hung* install waits before Install
/// works again in Settings. User-facing cancellation is the product-level fix.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(900);

/// How long the ceiling waits for the output drains to finish after killing the
/// install's process group. The kill closes the pipe write ends, so the drains
/// normally end within microseconds; this bound only covers a descendant that
/// escaped the group and still holds one open. Such a process must not hold the
/// install — and the concurrency guard behind it — open past the ceiling.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

/// Run an install command, retrying transient failures with backoff.
///
/// Runtime installs pull artifacts over the network — Goose's `curl … | bash`
/// fetches a native release-asset tarball from GitHub's CDN with no retry of
/// its own, and the npm adapter installs hit the registry. A single blip there
/// currently fails onboarding outright. This retries a command that ran to
/// completion but exited nonzero (the transient-download signature) up to
/// `INSTALL_MAX_ATTEMPTS` times. Failures with no exit code — a timeout or a
/// shell that never spawned — are not retried, since re-running them just costs
/// the user more time without a plausible path to success.
pub(super) fn run_install_command_with_retry(step: &str, command: &str) -> InstallStepResult {
    run_install_with_retry(
        INSTALL_MAX_ATTEMPTS,
        |_attempt| run_install_command(step, command),
        std::thread::sleep,
    )
}

/// Core retry loop, decoupled from the real command runner and clock so it can
/// be unit-tested without spawning shells or sleeping. `run` receives the
/// 1-based attempt number.
fn run_install_with_retry(
    max_attempts: u32,
    mut run: impl FnMut(u32) -> InstallStepResult,
    mut sleep: impl FnMut(std::time::Duration),
) -> InstallStepResult {
    let mut attempt = 1;
    loop {
        let result = run(attempt);
        if result.success || !install_failure_is_retryable(&result) || attempt >= max_attempts {
            return if attempt > 1 && !result.success {
                annotate_retry_attempts(result, attempt)
            } else {
                result
            };
        }
        sleep(install_retry_backoff(attempt));
        attempt += 1;
    }
}

/// Only retry commands that actually ran and exited nonzero — the signature of
/// a transient download failure. A missing exit code means the command timed
/// out or the shell failed to spawn, neither of which a retry is likely to fix.
fn install_failure_is_retryable(result: &InstallStepResult) -> bool {
    !result.success && result.exit_code.is_some()
}

/// Linear backoff: 3s before attempt 2, 6s before attempt 3.
fn install_retry_backoff(attempt: u32) -> std::time::Duration {
    std::time::Duration::from_secs(3 * attempt as u64)
}

/// Prefix the surfaced error so the UI shows the install was retried rather than
/// failed on a single unlucky attempt.
fn annotate_retry_attempts(mut result: InstallStepResult, attempts: u32) -> InstallStepResult {
    result.stderr = format!(
        "install failed after {attempts} attempts (retried with backoff)\n{}",
        result.stderr
    );
    result
}

/// Build the install command and point it at a writable working directory.
///
/// A packaged desktop launch inherits `/` as its working directory, and
/// installers that write relative to the CWD then fail on a read-only root, so
/// they run from Buzz's own default workdir instead (#2245).
///
/// This is the only command builder [`run_install_command`] calls, so anything
/// it spawns is guaranteed to carry the workdir — which is what makes the
/// working directory assertable without spawning a real login shell.
fn prepare_install_command(command: &str) -> Result<std::process::Command, String> {
    let mut cmd = super::build_install_command(command)?;
    if let Some(workdir) = crate::managed_agents::default_agent_workdir() {
        cmd.current_dir(workdir);
    }
    Ok(cmd)
}

fn run_install_command(step: &str, command: &str) -> InstallStepResult {
    let mut cmd = match prepare_install_command(command) {
        Ok(cmd) => cmd,
        Err(hint) => {
            return InstallStepResult {
                step: step.to_string(),
                command: command.to_string(),
                success: false,
                stdout: String::new(),
                stderr: "no suitable shell found for install commands".to_string(),
                exit_code: None,
                hint: Some(hint),
            };
        }
    };

    let child = match cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            return InstallStepResult {
                step: step.to_string(),
                command: command.to_string(),
                success: false,
                stdout: String::new(),
                stderr: format!("failed to spawn shell: {e}"),
                exit_code: None,
                hint: None,
            };
        }
    };

    await_install_child(step, command, child, INSTALL_TIMEOUT)
}

/// Drain a spawned install child's output into bounded buffers and wait for it
/// to exit, killing it at `timeout`.
///
/// Split from the spawn so the timing-sensitive half is testable without a real
/// login shell: shell startup alone can outlast a short test ceiling on a
/// loaded machine. Production always passes [`INSTALL_TIMEOUT`].
fn await_install_child(
    step: &str,
    command: &str,
    mut child: std::process::Child,
    timeout: Duration,
) -> InstallStepResult {
    // Drain stdout/stderr on background threads to prevent pipe buffer
    // deadlock. Each drain feeds a bounded sink the main thread can read at any
    // time, so a timeout can still surface whatever the install printed before
    // it stalled.
    let stdout_sink = BoundedOutput::shared();
    let stderr_sink = BoundedOutput::shared();
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let (drained_tx, drained_rx) = std::sync::mpsc::channel();

    let stdout_thread = std::thread::spawn({
        let (sink, done) = (Arc::clone(&stdout_sink), drained_tx.clone());
        move || {
            if let Some(pipe) = stdout_pipe {
                drain_into(pipe, &sink);
            }
            let _ = done.send(());
        }
    });
    let stderr_thread = std::thread::spawn({
        let (sink, done) = (Arc::clone(&stderr_sink), drained_tx);
        move || {
            if let Some(pipe) = stderr_pipe {
                drain_into(pipe, &sink);
            }
            let _ = done.send(());
        }
    });

    // Save the PID before moving `child` into the wait thread so we can
    // kill the process on timeout.
    let child_pid = child.id();

    let (tx, rx) = std::sync::mpsc::channel();
    let wait_thread = std::thread::spawn(move || {
        let status = child.wait();
        let _ = tx.send(status);
    });

    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            // Ceiling reached: kill the install's whole process group — the
            // install shell is a session leader (`setsid` in its `pre_exec`), so
            // signalling only the leader would leave descendants running and
            // holding the output pipes open.
            let _ = crate::managed_agents::terminate_process(child_pid);
            drop(rx);
            let _ = wait_thread.join();
            // The kill closes the pipes, so the drains normally end at once.
            // Any that don't are left detached rather than holding the install
            // (and the concurrency guard behind it) open past the ceiling —
            // their sinks are read under the lock either way.
            await_drains(&drained_rx, DRAIN_GRACE);
            return failed_with_capture(
                step,
                command,
                timeout_message(timeout),
                &stdout_sink,
                &stderr_sink,
            );
        }

        match rx.recv_timeout(Duration::from_millis(200).min(remaining)) {
            Ok(Ok(status)) => {
                let _ = wait_thread.join();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return InstallStepResult {
                    step: step.to_string(),
                    command: command.to_string(),
                    success: status.success(),
                    stdout: render_sink(&stdout_sink),
                    stderr: render_sink(&stderr_sink),
                    exit_code: status.code(),
                    hint: None,
                };
            }
            Ok(Err(e)) => {
                let _ = wait_thread.join();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return failed_with_capture(
                    step,
                    command,
                    format!("failed to check process status: {e}"),
                    &stdout_sink,
                    &stderr_sink,
                );
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // Still running; loop and check deadline again.
                continue;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                // wait_thread dropped sender without sending — shouldn't happen.
                let _ = wait_thread.join();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return failed_with_capture(
                    step,
                    command,
                    "internal error: wait thread disconnected".to_string(),
                    &stdout_sink,
                    &stderr_sink,
                );
            }
        }
    }
}

/// Bounded capture of one output stream: the first [`BoundedOutput::HEAD`]
/// bytes, the last [`BoundedOutput::TAIL`] bytes, and the total byte count.
///
/// Two properties matter. Output of any size costs a fixed amount of memory —
/// an installer that prints megabytes cannot grow the process. And because the
/// sink is *shared* with the draining reader instead of being returned by it,
/// whatever arrived before a stall is readable at the ceiling, which is exactly
/// when the output is most needed.
struct BoundedOutput {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total: usize,
}

type SharedOutput = Arc<Mutex<BoundedOutput>>;

impl BoundedOutput {
    /// The head keeps the command's opening context; the tail keeps the error
    /// that usually trails. Everything between them is replaced by a marker
    /// naming the omitted byte count.
    const HEAD: usize = 512;
    const TAIL: usize = 1024;

    fn shared() -> SharedOutput {
        Arc::new(Mutex::new(Self {
            head: Vec::new(),
            tail: VecDeque::new(),
            total: 0,
        }))
    }

    /// Absorb one read. Chunk boundaries are irrelevant to the result: the head
    /// fills first, the remainder rolls through the tail window.
    fn push(&mut self, chunk: &[u8]) {
        self.total += chunk.len();
        let head_room = Self::HEAD.saturating_sub(self.head.len()).min(chunk.len());
        let (head_part, tail_part) = chunk.split_at(head_room);
        self.head.extend_from_slice(head_part);
        self.tail.extend(tail_part);
        while self.tail.len() > Self::TAIL {
            self.tail.pop_front();
        }
    }

    fn render(&self) -> String {
        let tail: Vec<u8> = self.tail.iter().copied().collect();
        if self.total <= Self::HEAD + Self::TAIL {
            // Nothing was dropped, so head followed by tail is the whole stream.
            let mut whole = self.head.clone();
            whole.extend_from_slice(&tail);
            return decode(&whole);
        }
        // Both ends are cut at arbitrary byte offsets, so trim any partial
        // character rather than emitting replacement chars. The marker counts
        // every dropped byte, including those trims.
        let head = utf8_prefix(&self.head);
        let tail = utf8_suffix(&tail);
        let omitted = self.total - head.len() - tail.len();
        format!(
            "{}\n... ({omitted} bytes omitted) ...\n{}",
            decode(head),
            decode(tail)
        )
    }
}

/// Read `pipe` to EOF, feeding fixed-size chunks into `sink`. Read errors end
/// the drain — a broken pipe means the child is gone and there is nothing left
/// to capture.
fn drain_into(mut pipe: impl Read, sink: &SharedOutput) {
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => return,
            Ok(n) => {
                if let Ok(mut sink) = sink.lock() {
                    sink.push(&chunk[..n]);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        }
    }
}

/// Render a sink even if its drain thread panicked mid-write — a poisoned lock
/// must not cost the diagnostics.
fn render_sink(sink: &SharedOutput) -> String {
    sink.lock().unwrap_or_else(|p| p.into_inner()).render()
}

/// Wait up to `grace` in total for both drains to signal completion. Returns
/// early on timeout, leaving any straggler detached.
fn await_drains(done: &std::sync::mpsc::Receiver<()>, grace: Duration) {
    let deadline = Instant::now() + grace;
    for _ in 0..2 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if done.recv_timeout(remaining).is_err() {
            return;
        }
    }
}

/// A failure carrying whatever the drains captured, with `reason` leading
/// stderr so the surfaced message names the failure before the install's own
/// output.
fn failed_with_capture(
    step: &str,
    command: &str,
    reason: String,
    stdout: &SharedOutput,
    stderr: &SharedOutput,
) -> InstallStepResult {
    let captured = render_sink(stderr);
    InstallStepResult {
        step: step.to_string(),
        command: command.to_string(),
        success: false,
        stdout: render_sink(stdout),
        stderr: if captured.is_empty() {
            reason
        } else {
            format!("{reason}\n{captured}")
        },
        exit_code: None,
        hint: None,
    }
}

/// Name the limit that fired and its value, so a ceiling kill is
/// distinguishable from the installer's own failure.
fn timeout_message(timeout: Duration) -> String {
    let secs = timeout.as_secs();
    let limit = if secs >= 60 {
        format!("{}-minute", secs / 60)
    } else {
        format!("{secs}-second")
    };
    format!("install command exceeded the {limit} ceiling and was terminated")
}

fn decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Drop a trailing partial UTF-8 sequence, keeping mid-stream invalid bytes for
/// the lossy decode to mark.
fn utf8_prefix(bytes: &[u8]) -> &[u8] {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes,
        Err(e) if e.error_len().is_none() => &bytes[..e.valid_up_to()],
        Err(_) => bytes,
    }
}

/// Drop leading UTF-8 continuation bytes — at most three can precede a
/// character start.
fn utf8_suffix(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .take(3)
        .take_while(|b| *b & 0b1100_0000 == 0b1000_0000)
        .count();
    &bytes[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── install retry ─────────────────────────────────────────────────────────

    /// Build an `InstallStepResult` with just the fields the retry loop reads.
    fn step_result(success: bool, exit_code: Option<i32>, stderr: &str) -> InstallStepResult {
        InstallStepResult {
            step: "cli".to_string(),
            command: "curl … | bash".to_string(),
            success,
            stdout: String::new(),
            stderr: stderr.to_string(),
            exit_code,
            hint: None,
        }
    }

    #[test]
    fn test_retryable_only_for_nonzero_exit() {
        // Ran to completion but exited nonzero — the transient-download signature.
        assert!(install_failure_is_retryable(&step_result(
            false,
            Some(1),
            ""
        )));
        // No exit code — timeout or shell-never-spawned; retry won't help.
        assert!(!install_failure_is_retryable(&step_result(false, None, "")));
        // Success is never retryable.
        assert!(!install_failure_is_retryable(&step_result(
            true,
            Some(0),
            ""
        )));
    }

    #[test]
    fn test_retry_backoff_is_linear() {
        assert_eq!(install_retry_backoff(1), std::time::Duration::from_secs(3));
        assert_eq!(install_retry_backoff(2), std::time::Duration::from_secs(6));
    }

    #[test]
    fn test_retry_stops_on_first_success() {
        let mut calls = 0;
        let mut sleeps = 0;
        let result = run_install_with_retry(
            3,
            |_| {
                calls += 1;
                step_result(true, Some(0), "")
            },
            |_| sleeps += 1,
        );
        assert!(result.success);
        assert_eq!(calls, 1, "a first-attempt success must not re-run");
        assert_eq!(sleeps, 0, "no backoff sleep when nothing is retried");
    }

    #[test]
    fn test_retry_recovers_after_transient_failure() {
        let mut calls = 0;
        let result = run_install_with_retry(
            3,
            |attempt| {
                calls += 1;
                // Fail the first attempt with a nonzero exit, then succeed.
                step_result(attempt >= 2, Some(if attempt >= 2 { 0 } else { 1 }), "blip")
            },
            |_| {},
        );
        assert!(result.success);
        assert_eq!(calls, 2, "should retry once then succeed");
        // A recovered install must not carry the retry-failure annotation.
        assert!(!result.stderr.contains("attempts"));
    }

    #[test]
    fn test_retry_does_not_retry_unretryable_failure() {
        let mut calls = 0;
        let result = run_install_with_retry(
            3,
            |_| {
                calls += 1;
                step_result(false, None, "timed out")
            },
            |_| {},
        );
        assert!(!result.success);
        assert_eq!(calls, 1, "a failure with no exit code must not be retried");
        assert_eq!(
            result.stderr, "timed out",
            "unretried failure is unannotated"
        );
    }

    #[test]
    fn test_retry_exhausts_attempts_and_annotates() {
        let mut calls = 0;
        let mut sleeps = 0;
        let result = run_install_with_retry(
            3,
            |_| {
                calls += 1;
                step_result(false, Some(1), "download failed")
            },
            |_| sleeps += 1,
        );
        assert!(!result.success);
        assert_eq!(calls, 3, "must try exactly max_attempts times");
        assert_eq!(
            sleeps, 2,
            "backoff sleeps between attempts, not after the last"
        );
        assert!(
            result.stderr.contains("after 3 attempts"),
            "exhausted retries must surface the attempt count, got: {}",
            result.stderr
        );
        assert!(
            result.stderr.contains("download failed"),
            "original stderr must be preserved"
        );
    }

    // ── install working directory ─────────────────────────────────────────────

    /// Every install child must run from Buzz's writable default workdir. A
    /// packaged launch inherits `/`, where installers that write relative to
    /// the CWD fail on a read-only root (#2245).
    ///
    /// Asserts the prepared `Command` rather than spawning one: `run_install_command`
    /// would start a real login shell, which is neither hermetic nor fast.
    #[test]
    fn test_prepared_install_command_uses_default_workdir() {
        let expected = crate::managed_agents::default_agent_workdir()
            .expect("a default workdir must resolve on any test host");

        let cmd = prepare_install_command("echo test").expect("install shell must resolve");

        assert_eq!(cmd.get_current_dir(), Some(expected.as_path()));
    }

    // ── output capture ────────────────────────────────────────────────────────

    /// Feed `chunks` through a sink in order and render it.
    fn capture(chunks: &[&[u8]]) -> String {
        let sink = BoundedOutput::shared();
        for chunk in chunks {
            sink.lock().unwrap().push(chunk);
        }
        render_sink(&sink)
    }

    /// Output within the cap is passed through byte-for-byte — no marker, no loss.
    #[test]
    fn test_capture_leaves_short_output_untouched() {
        let short = "a".repeat(1536);

        assert_eq!(capture(&[short.as_bytes()]), short);
    }

    /// Over the cap, both ends survive and the middle is replaced by a marker
    /// naming the omitted byte count — the head keeps the command's opening
    /// context and the tail keeps the error that usually trails.
    #[test]
    fn test_capture_over_cap_keeps_head_and_tail_with_marker() {
        let input = format!(
            "{}{}{}",
            "H".repeat(512),
            "M".repeat(4000),
            "T".repeat(1024)
        );

        let out = capture(&[input.as_bytes()]);

        assert!(out.starts_with(&"H".repeat(512)));
        assert!(out.ends_with(&"T".repeat(1024)));
        assert!(
            out.contains("... (4000 bytes omitted) ..."),
            "marker must name the omitted byte count, got: {out}"
        );
    }

    /// The rendered result depends only on the byte stream, not on how the
    /// reads happened to split it — a real drain sees arbitrary chunk sizes.
    #[test]
    fn test_capture_is_independent_of_chunk_boundaries() {
        let input = "x".repeat(9000);
        let one_shot = capture(&[input.as_bytes()]);

        let chunked: Vec<&[u8]> = input.as_bytes().chunks(7).collect();

        assert_eq!(capture(&chunked), one_shot);
    }

    /// Truncation must not split a multi-byte character. Both cut points land
    /// mid-codepoint here; the partial bytes are dropped rather than decoded
    /// into replacement chars.
    #[test]
    fn test_capture_does_not_split_multibyte_characters() {
        // "é" is 2 bytes, so every candidate cut index lands mid-character.
        let input = "é".repeat(4000);

        let out = capture(&[input.as_bytes()]);

        assert!(out.contains("bytes omitted"), "input must exceed the cap");
        assert!(!out.contains('\u{fffd}'), "no replacement chars: {out}");
    }

    /// Memory stays flat regardless of how much the installer prints: the
    /// rendered result of a 4MiB stream is no larger than that of a 6KiB one.
    #[test]
    fn test_capture_of_huge_output_stays_bounded() {
        let chunk = vec![b'z'; 8192];
        let sink = BoundedOutput::shared();
        for _ in 0..512 {
            sink.lock().unwrap().push(&chunk);
        }

        let out = render_sink(&sink);

        assert!(
            out.len() < 2048,
            "4MiB of output must render bounded, got {} bytes",
            out.len()
        );
        assert!(out.contains("bytes omitted"));
    }

    // ── install ceiling ───────────────────────────────────────────────────────

    /// The ceiling is Will's ruling: 15 minutes, and the error names the limit
    /// that fired so a ceiling kill is not mistaken for the installer's own
    /// failure.
    #[test]
    fn test_ceiling_is_fifteen_minutes_and_error_names_it() {
        assert_eq!(INSTALL_TIMEOUT, Duration::from_secs(900));
        assert!(
            timeout_message(INSTALL_TIMEOUT).contains("15-minute"),
            "got: {}",
            timeout_message(INSTALL_TIMEOUT)
        );
    }

    /// Spawn `script` under `sh` as a process-group leader with piped output —
    /// the same shape [`run_install_command`] hands to
    /// [`await_install_child`], minus the login shell whose own startup can
    /// outlast a short test ceiling.
    #[cfg(unix)]
    fn spawn_group_leader(script: &str) -> std::process::Child {
        use std::os::unix::process::CommandExt;

        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.arg("-c").arg(script);
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("sh must spawn")
    }

    /// A command killed by the ceiling must surface what it printed before
    /// stalling — that partial output is the only evidence of where the install
    /// got stuck — and must stay unretryable, since re-running a hang just
    /// costs the user another ceiling.
    #[cfg(unix)]
    #[test]
    fn test_ceiling_returns_captured_output_and_stays_unretryable() {
        let child = spawn_group_leader("echo out-before-hang; echo err-before-hang >&2; sleep 60");

        let started = Instant::now();
        let result = await_install_child("cli", "install", child, Duration::from_secs(5));

        assert!(!result.success);
        assert_eq!(result.exit_code, None, "a killed command has no exit code");
        assert!(
            !install_failure_is_retryable(&result),
            "a ceiling kill must not be retried"
        );
        assert!(
            result.stdout.contains("out-before-hang"),
            "stdout captured before the stall must survive, got: {:?}",
            result.stdout
        );
        assert!(
            result.stderr.contains("5-second ceiling"),
            "stderr must name the ceiling that actually fired, got: {:?}",
            result.stderr
        );
        assert!(
            result.stderr.contains("err-before-hang"),
            "stderr captured before the stall must survive, got: {:?}",
            result.stderr
        );
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "the ceiling must not wait on the hung command's own exit"
        );
    }

    /// A failure whose stream captured nothing surfaces the reason alone — no
    /// dangling separator from an empty capture.
    #[test]
    fn test_failure_with_no_captured_output_reports_only_the_reason() {
        let result = failed_with_capture(
            "cli",
            "curl … | bash",
            "boom".to_string(),
            &BoundedOutput::shared(),
            &BoundedOutput::shared(),
        );

        assert_eq!(result.stdout, "");
        assert_eq!(result.stderr, "boom");
    }

    /// The install shell is a process-group leader, and its descendants inherit
    /// the output pipes. Killing only the leader leaves them running and the
    /// drains blocked on a pipe nobody will close, so the ceiling kills the
    /// whole group.
    #[cfg(unix)]
    #[test]
    fn test_ceiling_kills_descendants_holding_the_output_pipe() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pidfile = dir.path().join("descendant.pid");
        let child = spawn_group_leader(&format!(
            "sh -c 'echo $$ > {pid}; sleep 60' & echo leader-up; sleep 60",
            pid = pidfile.display()
        ));

        let started = Instant::now();
        let result = await_install_child("cli", "install", child, Duration::from_secs(5));

        assert!(!result.success);
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "the drains must not block on a descendant's inherited pipe"
        );

        let pid: u32 = std::fs::read_to_string(&pidfile)
            .expect("the descendant must have recorded its pid")
            .trim()
            .parse()
            .expect("pid must parse");
        // Signal delivery is asynchronous; allow the group a moment to die.
        for _ in 0..30 {
            if !crate::managed_agents::process_is_running(pid) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("descendant {pid} survived the ceiling kill — the group was not signalled");
    }
}

use super::*;
use crate::commands::agent_discovery::install_capture::{drain_into, Capture};
use std::sync::Mutex;

/// Stands in for the real `app.package_info().version`, which needs a Tauri app.
const TEST_APP_VERSION: &str = "9.9.9";

/// A reporter with a started log session in a temp dir, and the emitted events
/// captured.
struct Harness {
    _dir: tempfile::TempDir,
    log: PathBuf,
    reporter: InstallReporter,
    events: Arc<Mutex<Vec<InstallOutputEvent>>>,
}

fn harness() -> Harness {
    harness_at(None)
}

/// A harness whose log lives in `dir`, or in a fresh temp dir when `dir` is
/// `None`. Passing a directory lets a test seed a previous run's file first.
fn harness_at(dir: Option<tempfile::TempDir>) -> Harness {
    let dir = dir.unwrap_or_else(|| tempfile::tempdir().expect("tempdir"));
    let log = dir.path().join("install-goose.log");
    let events: Arc<Mutex<Vec<InstallOutputEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let emit: EmitEvent = {
        let events = Arc::clone(&events);
        Arc::new(move |event| events.lock().unwrap().push(event))
    };
    Harness {
        reporter: InstallReporter::new(
            "goose",
            InstallLog::start(&log, "goose", TEST_APP_VERSION),
            Some(emit),
        ),
        _dir: dir,
        log,
        events,
    }
}

/// A reporter with no log file and nothing listening — the degraded shape.
fn silent_reporter() -> InstallReporter {
    InstallReporter::new("goose", None, None)
}

fn step(name: &str, success: bool, stderr: &str) -> InstallStepResult {
    InstallStepResult {
        step: name.to_string(),
        command: "curl … | bash".to_string(),
        success,
        stdout: String::new(),
        stderr: stderr.to_string(),
        exit_code: Some(if success { 0 } else { 1 }),
        hint: None,
    }
}

/// An executed attempt whose log copy differs from the UI copy — the real shape,
/// since the two views are capped differently.
fn outcome(name: &str, success: bool, log_stdout: &str) -> InstallOutcome {
    InstallOutcome {
        step: step(name, success, ""),
        log_stdout: log_stdout.to_string(),
        log_stderr: String::new(),
    }
}

impl Harness {
    fn log_contents(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }

    /// The emitted lines in order, with a clear signal rendered as `None`.
    fn lines(&self) -> Vec<Option<String>> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.line.clone())
            .collect()
    }

    fn events(&self) -> Vec<InstallOutputEvent> {
        self.events.lock().unwrap().clone()
    }
}

// ── the log records history the UI does not keep ─────────────────────────────

/// Every attempt is recorded, not just the one the UI surfaces. Reproducing an
/// install failure means seeing whether attempts 1 and 2 failed the same way.
#[test]
fn test_log_records_every_attempt_not_only_the_last() {
    let h = harness();

    h.reporter
        .record_attempt(1, &outcome("cli", false, "attempt-one-output"));
    h.reporter
        .record_attempt(2, &outcome("cli", false, "attempt-two-output"));

    let log = h.log_contents();
    assert!(log.contains("attempt-one-output"), "got: {log}");
    assert!(log.contains("attempt-two-output"), "got: {log}");
    assert!(
        log.contains("attempt=1") && log.contains("attempt=2"),
        "got: {log}"
    );
}

/// A first attempt that printed a huge amount must not push later records out of
/// the file. Records are capped individually by the log-scale capture that
/// produced them, so the run's total is bounded by steps × attempts × cap rather
/// than by one runaway attempt.
///
/// The flood goes through a real [`Capture`] rather than straight into the
/// record, so this exercises the cap that actually bounds a record.
#[test]
fn test_first_attempt_overflow_does_not_erase_later_records() {
    let h = harness();
    // Through the real drain, so the record is bounded by the cap that bounds a
    // production record rather than by a string this test chose.
    let capture = Capture::new();
    drain_into(vec![b'F'; 4 * 1024 * 1024].as_slice(), &capture, None);

    h.reporter
        .record_attempt(1, &outcome("cli", false, &capture.log()));
    h.reporter
        .record_attempt(2, &outcome("cli", false, "second-attempt-detail"));
    h.reporter.record_step(
        &mut Vec::new(),
        step("verify", false, "verification-detail"),
    );

    let log = h.log_contents();
    assert!(
        log.contains("bytes omitted at cap"),
        "the flooded record must be marked as cut"
    );
    assert!(
        log.contains("second-attempt-detail"),
        "a later attempt must survive an earlier flood"
    );
    assert!(
        log.contains("verification-detail"),
        "the synthesized step explaining the failure must survive too"
    );
    assert!(
        log.len() < 4 * 1024 * 1024,
        "4MiB of first-attempt output must not reach the file, got {} bytes",
        log.len()
    );
}

/// A step Buzz synthesizes — a failed prerequisite, or post-install
/// verification — reaches the log as well as the UI. `record_step` is the only
/// path that guarantees this, which is why callers use it instead of
/// `steps.push`.
#[test]
fn test_recording_a_synthesized_step_logs_it_and_keeps_it_for_the_ui() {
    let h = harness();
    let mut steps = Vec::new();

    h.reporter
        .record_step(&mut steps, step("verify", false, "still-not-usable"));

    assert_eq!(steps.len(), 1, "the UI must still receive the step");
    assert!(h.log_contents().contains("still-not-usable"));
}

// ── one file per run ─────────────────────────────────────────────────────────

/// A run opens with a header naming the runtime and the environment the run
/// happened in, so a file holding one run of several steps is identifiable as
/// that run rather than a stream of records — and a failure report says which
/// app version and OS produced it without a second round trip to the user.
#[test]
fn test_a_run_opens_with_a_header_naming_the_runtime_app_version_and_os() {
    let h = harness();
    let log = h.log_contents();

    assert!(
        log.starts_with(&format!(
            "=== install run runtime=goose app={TEST_APP_VERSION} os={} started=",
            std::env::consts::OS
        )),
        "got: {log}"
    );
}

/// A new run does not append to the previous run's file: it starts a fresh one
/// and keeps the previous as `.1`. Reading a log has to mean reading one run —
/// records accumulated across runs are indistinguishable from retries within
/// one.
#[test]
fn test_a_new_run_starts_a_fresh_file_and_keeps_the_previous_as_dot_one() {
    let first = harness();
    first
        .reporter
        .record_attempt(1, &outcome("cli", false, "previous-run-output"));
    let previous = first.log.clone();
    let dir = first._dir;
    drop(first.reporter);

    let second = harness_at(Some(dir));
    second
        .reporter
        .record_attempt(1, &outcome("cli", false, "current-run-output"));

    let log = second.log_contents();
    assert!(log.contains("current-run-output"), "got: {log}");
    assert!(
        !log.contains("previous-run-output"),
        "the new run's file must not carry the previous run's records: {log}"
    );
    let rotated = std::fs::read_to_string(previous.with_extension("log.1")).expect("read .1");
    assert!(
        rotated.contains("previous-run-output"),
        "the previous run must remain readable as .1: {rotated}"
    );
}

/// Each executed attempt records how long it ran. A 15-minute ceiling is only
/// diagnosable if the file says which attempt consumed the time.
#[test]
fn test_an_executed_attempt_records_its_own_duration() {
    let h = harness();

    h.reporter.start_attempt();
    h.reporter.record_attempt(1, &outcome("cli", true, "done"));
    h.reporter
        .record_step(&mut Vec::new(), step("verify", true, ""));

    let log = h.log_contents();
    assert!(
        log.contains("attempt=1") && log.contains("elapsed=0."),
        "an executed attempt must carry its duration: {log}"
    );
    assert!(
        log.contains("attempt=- ") && log.contains("elapsed=-"),
        "a synthesized step never ran, so it has no duration: {log}"
    );
}

// ── redaction ────────────────────────────────────────────────────────────────

/// Secrets that an installer echoed must not land on disk. The log is written
/// unattended, so scrubbing happens at the write, not at the read.
#[test]
fn test_log_redacts_secrets_before_writing() {
    let h = harness();
    let leak = "npm ERR! token nsec1qqqqqqqqqqsecretvalue failed";

    h.reporter.record_attempt(1, &outcome("cli", false, leak));

    let log = h.log_contents();
    assert!(!log.contains("nsec1qqqqqqqqqqsecretvalue"), "got: {log}");
    assert!(log.contains("[REDACTED]"), "got: {log}");
}

/// The environment's own secrets are scrubbed too, by *name* rather than shape.
/// An install inherits Buzz's environment and installers echo it back — npm
/// prints its resolved config on an auth failure — and a token with no
/// recognizable prefix would otherwise reach the file verbatim.
#[test]
fn test_log_redacts_an_environment_secret_with_no_recognizable_prefix() {
    let secret = "0e8f31c5a4b7d296e5f1a";
    // Set before the reporter is built: the snapshot is taken at construction.
    std::env::set_var("BUZZ_TEST_REGISTRY_TOKEN", secret);
    let h = harness();
    std::env::remove_var("BUZZ_TEST_REGISTRY_TOKEN");

    h.reporter.record_attempt(
        1,
        &outcome("cli", false, &format!("npm ERR! _authToken={secret}")),
    );

    let log = h.log_contents();
    assert!(!log.contains(secret), "got: {log}");
    assert!(log.contains("[REDACTED]"), "got: {log}");
}

/// A live line carries the same scrubbing as the log record. The line is
/// rendered verbatim in the UI, so a leak there is as visible as one on disk.
#[test]
fn test_a_live_line_is_redacted_before_it_is_emitted() {
    let h = harness();

    let observer = h.reporter.line_observer().expect("an observer");
    observer("fetching with token nsec1qqqqqqqqqqleaked");

    let lines = h.lines();
    assert_eq!(lines.len(), 1);
    let line = lines[0].clone().expect("a line, not a clear signal");
    assert!(!line.contains("nsec1qqqqqqqqqqleaked"), "got: {line}");
    assert!(line.contains("[REDACTED]"), "got: {line}");
}

// ── the log pointer ──────────────────────────────────────────────────────────

/// The path is available as soon as the run's session opens, because the file
/// exists from that moment — the header is already in it. A failure before any
/// step ran still points the user at a real file.
#[test]
fn test_log_path_is_available_from_the_start_of_the_run() {
    let h = harness();

    assert_eq!(h.reporter.log_path(), Some(h.log.display().to_string()));
}

/// A reporter with no log — an unresolvable app-data directory — records
/// nothing and reports no path, but must not panic or fail the install.
#[test]
fn test_reporter_without_a_log_records_nothing_and_reports_no_path() {
    let reporter = silent_reporter();
    let mut steps = Vec::new();

    reporter.start_attempt();
    reporter.record_attempt(1, &outcome("cli", false, "output"));
    reporter.record_step(&mut steps, step("verify", false, "detail"));

    assert_eq!(reporter.log_path(), None);
    assert_eq!(steps.len(), 1, "the UI path is unaffected by a missing log");
}

/// A log path inside a directory that no longer exists cannot open a session, so
/// the run degrades to no log rather than failing.
#[test]
fn test_an_unopenable_log_degrades_to_no_log() {
    let path = PathBuf::from("/nonexistent-dir-for-test/install-goose.log");

    assert!(InstallLog::start(&path, "goose", TEST_APP_VERSION).is_none());
}

// ── live output line ─────────────────────────────────────────────────────────

/// Lines carry an install-wide monotonic sequence number, so the UI can order
/// them across steps and attempts — which a per-step retry number cannot do.
#[test]
fn test_emitted_lines_carry_their_runtime_and_a_monotonic_sequence() {
    let h = harness();

    let observer = h.reporter.line_observer().expect("an observer");
    observer("downloading");
    h.reporter.start_attempt();

    let events = h.events();
    assert_eq!(events.len(), 2);
    assert!(events.iter().all(|e| e.runtime_id == "goose"));
    assert_eq!(events[0].line.as_deref(), Some("downloading"));
    assert_eq!(events[0].seq, 0);
    assert_eq!(
        events[1].seq, 1,
        "the clear signal takes the next sequence number, so it cannot be \
         mistaken for a stale event"
    );
}

/// Starting an attempt clears the display first: the previous attempt's last
/// line is typically the failure that caused the retry, and leaving it under the
/// spinner through the backoff shows the user the past as if it were current.
#[test]
fn test_starting_an_attempt_clears_the_displayed_line() {
    let h = harness();
    let observer = h.reporter.line_observer().expect("an observer");
    observer("download failed");

    h.reporter.start_attempt();

    assert_eq!(
        h.lines(),
        vec![Some("download failed".to_string()), None],
        "the attempt boundary must emit a clear"
    );
}

/// The clear is not rate-limited, and it reopens the window: a new attempt's
/// first line goes out immediately even if it arrives inside the previous
/// attempt's window. This is the case the throttle used to swallow entirely.
#[test]
fn test_a_new_attempts_first_line_is_emitted_even_inside_the_previous_window() {
    let h = harness();
    let observer = h.reporter.line_observer().expect("an observer");
    observer("attempt one failed");

    // No wait: the previous line was emitted microseconds ago, so this is well
    // inside the 250ms window.
    h.reporter.start_attempt();
    observer("attempt two starting");

    assert_eq!(
        h.lines(),
        vec![
            Some("attempt one failed".to_string()),
            None,
            Some("attempt two starting".to_string()),
        ]
    );
}

/// A burst inside the window coalesces to one event, and the line it emits is
/// the *newest* — the display shows current progress, not the line that happened
/// to arrive when the window opened.
#[test]
fn test_a_burst_coalesces_to_the_newest_line_not_the_first() {
    let h = harness();
    let observer = h.reporter.line_observer().expect("an observer");

    observer("one");
    observer("two");
    observer("three");
    // Ends the attempt, which is when a held line is known to be the last.
    h.reporter.record_attempt(1, &outcome("cli", true, "done"));

    assert_eq!(
        h.lines(),
        vec![Some("one".to_string()), Some("three".to_string())],
        "the held line must be the newest, and it must not be lost"
    );
}

/// The throttle is per install, not per stream: stdout and stderr of one attempt
/// share one window, so an install printing on both does not double the event
/// rate.
#[test]
fn test_both_streams_of_one_attempt_share_the_rate_window() {
    let h = harness();
    let stdout = h.reporter.line_observer().expect("an observer");
    let stderr = h.reporter.line_observer().expect("an observer");

    stdout("progress");
    stderr("warning");
    h.reporter.record_attempt(1, &outcome("cli", true, "done"));

    assert_eq!(
        h.lines(),
        vec![Some("progress".to_string()), Some("warning".to_string())],
        "the second stream's line is held, not emitted immediately, and not lost"
    );
}

/// Nothing listening means no observer at all, so the drain skips line
/// reassembly entirely rather than doing the work and discarding it.
#[test]
fn test_no_observer_when_nothing_is_listening() {
    assert!(silent_reporter().line_observer().is_none());
}

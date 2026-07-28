use super::*;
use crate::commands::agent_discovery::install_capture::{drain_into, Capture};
use std::sync::Mutex;

/// A reporter writing to a temp log, with the emitted events captured.
struct Harness {
    _dir: tempfile::TempDir,
    log: PathBuf,
    reporter: InstallReporter,
    events: Arc<Mutex<Vec<InstallOutputEvent>>>,
}

fn harness() -> Harness {
    let dir = tempfile::tempdir().expect("tempdir");
    let log = dir.path().join("install-goose.log");
    let events: Arc<Mutex<Vec<InstallOutputEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let emit: EmitEvent = {
        let events = Arc::clone(&events);
        Arc::new(move |event| events.lock().unwrap().push(event))
    };
    Harness {
        reporter: InstallReporter::new("goose", Some(log.clone()), Some(emit)),
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

    fn lines(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.line.clone())
            .collect()
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

/// The log path is surfaced only once something is in the file — a message
/// pointing at a path that does not exist is worse than no pointer.
#[test]
fn test_log_path_is_absent_until_something_is_written() {
    let h = harness();

    assert_eq!(h.reporter.log_path(), None);

    h.reporter.record_attempt(1, &outcome("cli", true, "done"));

    assert_eq!(
        h.reporter.log_path(),
        Some(h.log.display().to_string()),
        "a written log must be surfaced"
    );
}

/// A reporter with no log — an unresolvable app-data directory — records
/// nothing and reports no path, but must not panic or fail the install.
#[test]
fn test_reporter_without_a_log_records_nothing_and_reports_no_path() {
    let reporter = silent_reporter();
    let mut steps = Vec::new();

    reporter.record_attempt(1, &outcome("cli", false, "output"));
    reporter.record_step(&mut steps, step("verify", false, "detail"));

    assert_eq!(reporter.log_path(), None);
    assert_eq!(steps.len(), 1, "the UI path is unaffected by a missing log");
}

/// A log path inside a directory that no longer exists fails every write. The
/// install still runs; the pointer is simply absent.
#[test]
fn test_write_failure_leaves_the_install_unaffected() {
    let reporter = InstallReporter::new(
        "goose",
        Some(PathBuf::from("/nonexistent-dir-for-test/install-goose.log")),
        None,
    );

    reporter.record_attempt(1, &outcome("cli", false, "output"));

    assert_eq!(reporter.log_path(), None);
}

// ── live output line ─────────────────────────────────────────────────────────

/// Lines drained during an attempt are emitted with that attempt's number, so
/// the UI can discard a line that belongs to a superseded retry.
#[test]
fn test_emitted_line_carries_its_runtime_and_attempt() {
    let h = harness();

    let observer = h.reporter.line_observer(2).expect("an observer");
    observer("downloading");

    let events = h.events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].runtime_id, "goose");
    assert_eq!(events[0].attempt, 2);
    assert_eq!(events[0].line, "downloading");
}

/// The throttle is per install, not per attempt or per stream: a burst across
/// two observers still coalesces, because both share one window.
#[test]
fn test_emission_is_throttled_across_attempts_and_streams() {
    let h = harness();
    let first = h.reporter.line_observer(1).expect("an observer");
    let second = h.reporter.line_observer(2).expect("an observer");

    first("one");
    first("two");
    second("three");

    assert_eq!(
        h.lines(),
        vec!["one"],
        "a burst inside the window must coalesce to the first line"
    );
}

/// Nothing listening means no observer at all, so the drain skips line
/// reassembly entirely rather than doing the work and discarding it.
#[test]
fn test_no_observer_when_nothing_is_listening() {
    assert!(silent_reporter().line_observer(1).is_none());
}

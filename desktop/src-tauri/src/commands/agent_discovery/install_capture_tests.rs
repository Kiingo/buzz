use super::*;

/// Feed `chunks` through a capture in order.
fn capture_of(chunks: &[&[u8]]) -> Capture {
    let capture = Capture::new();
    for chunk in chunks {
        capture.push(chunk);
    }
    capture
}

/// Render what the UI would show for a stream of `chunks`.
fn ui(chunks: &[&[u8]]) -> String {
    capture_of(chunks).ui()
}

// ── bounded capture ──────────────────────────────────────────────────────────

/// Output within the cap is passed through byte-for-byte — no marker, no loss.
#[test]
fn test_capture_leaves_short_output_untouched() {
    let short = "a".repeat(1536);

    assert_eq!(ui(&[short.as_bytes()]), short);
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

    let out = ui(&[input.as_bytes()]);

    assert!(out.starts_with(&"H".repeat(512)));
    assert!(out.ends_with(&"T".repeat(1024)));
    assert!(
        out.contains("... (4000 bytes omitted) ..."),
        "marker must name the omitted byte count, got: {out}"
    );
}

/// The rendered result depends only on the byte stream, not on how the reads
/// happened to split it — a real drain sees arbitrary chunk sizes.
#[test]
fn test_capture_is_independent_of_chunk_boundaries() {
    let input = "x".repeat(9000);
    let one_shot = ui(&[input.as_bytes()]);

    let chunked: Vec<&[u8]> = input.as_bytes().chunks(7).collect();

    assert_eq!(ui(&chunked), one_shot);
}

/// Truncation must not split a multi-byte character. Both cut points land
/// mid-codepoint here; the partial bytes are dropped rather than decoded into
/// replacement chars.
#[test]
fn test_capture_does_not_split_multibyte_characters() {
    // "é" is 2 bytes, so every candidate cut index lands mid-character.
    let input = "é".repeat(4000);

    let out = ui(&[input.as_bytes()]);

    assert!(out.contains("bytes omitted"), "input must exceed the cap");
    assert!(!out.contains('\u{fffd}'), "no replacement chars: {out}");
}

/// Memory stays flat regardless of how much the installer prints: the rendered
/// UI result of a 4MiB stream is no larger than that of a 6KiB one.
#[test]
fn test_capture_of_huge_output_stays_bounded() {
    let chunk = vec![b'z'; 8192];

    let capture = Capture::new();
    for _ in 0..512 {
        capture.push(&chunk);
    }

    let out = capture.ui();
    assert!(
        out.len() < 2048,
        "4MiB of output must render bounded, got {} bytes",
        out.len()
    );
    assert!(out.contains("bytes omitted"));
}

// ── the log view is separately bounded ───────────────────────────────────────

/// The log view holds output the UI view had to cut. A toast is capped for
/// readability; the log file's budget is disk, and "Full log: {path}" has to
/// point at more than the toast already showed.
#[test]
fn test_log_view_keeps_output_the_ui_view_truncates() {
    let input = format!("start{}end", "m".repeat(64 * 1024));

    let capture = capture_of(&[input.as_bytes()]);

    assert!(
        capture.ui().contains("bytes omitted"),
        "64KiB must exceed the UI cap"
    );
    assert_eq!(
        capture.log(),
        input,
        "the same output must be complete in the log view"
    );
}

/// Even the log view is bounded — a runaway installer cannot fill the disk —
/// and when it does cut, the record says so inline at the cap rather than
/// implying completeness.
#[test]
fn test_log_view_is_bounded_and_marks_its_cap() {
    let head = "H".repeat(128 * 1024);
    let middle = "M".repeat(5000);
    let tail = "T".repeat(128 * 1024);
    let input = format!("{head}{middle}{tail}");

    let capture = capture_of(&[input.as_bytes()]);

    let out = capture.log();
    assert!(
        out.len() < 300 * 1024,
        "output past the log cap must render bounded, got {} bytes",
        out.len()
    );
    assert!(out.starts_with(&head), "the log head must survive intact");
    assert!(out.ends_with(&tail), "the log tail must survive intact");
    assert!(
        out.contains("... [5000 bytes omitted at cap] ..."),
        "a cut log record must name the cap inline, got the middle: {}",
        &out[128 * 1024..(128 * 1024 + 64).min(out.len())]
    );
}

/// The two views mark their cuts differently on purpose: the toast reads as
/// prose, the log record reads as a machine-scannable annotation.
#[test]
fn test_ui_and_log_views_use_their_own_cap_markers() {
    let input = "x".repeat(300 * 1024);

    let capture = capture_of(&[input.as_bytes()]);

    assert!(
        capture.ui().contains("bytes omitted) ..."),
        "the UI marker reads as prose: {}",
        capture.ui()
    );
    assert!(capture.log().contains("bytes omitted at cap] ..."));
}

// ── line observation ─────────────────────────────────────────────────────────

/// Collect the lines a drain over `chunks` reports.
fn observed_lines(chunks: &[&[u8]]) -> Vec<String> {
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let observer: LineObserver = {
        let seen = Arc::clone(&seen);
        Arc::new(move |line: &str| seen.lock().unwrap().push(line.to_string()))
    };
    let bytes: Vec<u8> = chunks.concat();

    drain_into(bytes.as_slice(), &Capture::new(), Some(&observer));

    let observed = seen.lock().unwrap().clone();
    observed
}

/// The observer sees complete lines, reassembled across the read boundaries
/// that split them — a live output line must never show half a word.
#[test]
fn test_observer_reassembles_lines_split_across_reads() {
    let lines = observed_lines(&[b"downloa", b"ding 40%\nunpack", b"ing\n"]);

    assert_eq!(lines, vec!["downloading 40%", "unpacking"]);
}

/// A trailing line with no newline is never reported: it may still be growing,
/// and showing a half-line as if complete is worse than showing the previous
/// one.
#[test]
fn test_observer_withholds_a_line_that_has_no_newline_yet() {
    let lines = observed_lines(&[b"complete\n", b"still-writing"]);

    assert_eq!(lines, vec!["complete"]);
}

/// Blank lines carry nothing to display; progress output is full of them.
#[test]
fn test_observer_skips_blank_lines() {
    let lines = observed_lines(&[b"a\n\n  \nb\n"]);

    assert_eq!(lines, vec!["a", "b"]);
}

/// A pathological line with no newline must not grow the buffer without bound.
#[test]
fn test_observer_caps_a_pathologically_long_line() {
    let huge = "x".repeat(100_000);

    let lines = observed_lines(&[huge.as_bytes(), b"\n"]);

    assert_eq!(lines.len(), 1);
    assert!(
        lines[0].len() <= LineSplitter::MAX_LINE,
        "line must be capped, got {} bytes",
        lines[0].len()
    );
}

/// A drain with no observer still captures — the log and UI views do not
/// depend on anyone watching.
#[test]
fn test_drain_captures_without_an_observer() {
    let capture = Capture::new();

    drain_into(b"hello\n".as_slice(), &capture, None);

    assert_eq!(capture.ui(), "hello\n");
}

// ── throttle ─────────────────────────────────────────────────────────────────

/// The first line always goes out, and a second inside the window is dropped
/// rather than queued: the UI wants the newest line, not a replay.
#[test]
fn test_throttle_allows_the_first_line_and_drops_the_next_in_window() {
    let throttle = Throttle::new(Duration::from_millis(250));
    let start = Instant::now();

    assert!(throttle.allows(start));
    assert!(!throttle.allows(start + Duration::from_millis(100)));
}

/// Once the window passes, emission resumes — a long install keeps showing
/// progress.
#[test]
fn test_throttle_allows_again_after_the_window() {
    let throttle = Throttle::new(Duration::from_millis(250));
    let start = Instant::now();

    assert!(throttle.allows(start));

    assert!(throttle.allows(start + Duration::from_millis(300)));
}

/// The window is measured from the last *emitted* line, not the last attempt:
/// a stream of dropped lines must not extend the silence.
#[test]
fn test_throttle_window_runs_from_the_last_emission() {
    let throttle = Throttle::new(Duration::from_millis(250));
    let start = Instant::now();
    assert!(throttle.allows(start));

    assert!(!throttle.allows(start + Duration::from_millis(200)));

    assert!(
        throttle.allows(start + Duration::from_millis(260)),
        "a dropped line must not restart the window"
    );
}

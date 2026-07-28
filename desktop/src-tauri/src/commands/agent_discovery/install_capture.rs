//! Bounded capture of an install command's output.
//!
//! One drain per stream feeds a [`Capture`], which holds two independently
//! bounded views of the same bytes: a small one sized for an error toast and a
//! large one sized for the install log file. Both are shared with the draining
//! reader rather than returned by it, so whatever arrived before a stall is
//! readable at the ceiling — exactly when the output matters most.

use std::collections::VecDeque;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How much of each end a capture keeps, and how it names what was cut.
#[derive(Clone, Copy)]
struct Caps {
    head: usize,
    tail: usize,
    marker: fn(usize) -> String,
}

/// Sized for a UI error message: enough to identify the failure, small enough
/// to read in a toast.
const UI_CAPS: Caps = Caps {
    head: 512,
    tail: 1024,
    marker: |omitted| format!("... ({omitted} bytes omitted) ..."),
};

/// Sized for the log file, where the budget is disk rather than screen. At this
/// cap a real install log is complete in practice; the marker names the cases
/// where it is not, so the file never implies completeness it does not have.
const LOG_CAPS: Caps = Caps {
    head: 128 * 1024,
    tail: 128 * 1024,
    marker: |omitted| format!("... [{omitted} bytes omitted at cap] ..."),
};

/// Bounded capture of one stream: its first `head` bytes, its last `tail`
/// bytes, and the total byte count. Output of any size costs a fixed amount of
/// memory, so an installer that prints megabytes cannot grow the process.
struct BoundedOutput {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total: usize,
    caps: Caps,
}

type SharedOutput = Arc<Mutex<BoundedOutput>>;

impl BoundedOutput {
    fn shared(caps: Caps) -> SharedOutput {
        Arc::new(Mutex::new(Self {
            head: Vec::new(),
            tail: VecDeque::new(),
            total: 0,
            caps,
        }))
    }

    /// Absorb one read. Chunk boundaries are irrelevant to the result: the head
    /// fills first, the remainder rolls through the tail window.
    fn push(&mut self, chunk: &[u8]) {
        self.total += chunk.len();
        let head_room = self
            .caps
            .head
            .saturating_sub(self.head.len())
            .min(chunk.len());
        let (head_part, tail_part) = chunk.split_at(head_room);
        self.head.extend_from_slice(head_part);
        self.tail.extend(tail_part);
        while self.tail.len() > self.caps.tail {
            self.tail.pop_front();
        }
    }

    fn render(&self) -> String {
        let tail: Vec<u8> = self.tail.iter().copied().collect();
        if self.total <= self.caps.head + self.caps.tail {
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
            "{}\n{}\n{}",
            decode(head),
            (self.caps.marker)(omitted),
            decode(tail)
        )
    }
}

/// The two bounded views of one stream, filled by a single drain.
pub(super) struct Capture {
    ui: SharedOutput,
    log: SharedOutput,
}

impl Capture {
    pub(super) fn new() -> Self {
        Self {
            ui: BoundedOutput::shared(UI_CAPS),
            log: BoundedOutput::shared(LOG_CAPS),
        }
    }

    /// What the UI shows for this stream.
    pub(super) fn ui(&self) -> String {
        render(&self.ui)
    }

    /// What the install log records for this stream.
    pub(super) fn log(&self) -> String {
        render(&self.log)
    }

    fn push(&self, chunk: &[u8]) {
        for sink in [&self.ui, &self.log] {
            if let Ok(mut sink) = sink.lock() {
                sink.push(chunk);
            }
        }
    }
}

/// Called with each complete line an install prints, for the live output line
/// in the UI. Shared across both drain threads of one attempt.
pub(super) type LineObserver = Arc<dyn Fn(&str) + Send + Sync>;

/// Render a capture even if its drain thread panicked mid-write — a poisoned
/// lock must not cost the diagnostics.
fn render(sink: &SharedOutput) -> String {
    sink.lock().unwrap_or_else(|p| p.into_inner()).render()
}

/// Read `pipe` to EOF, feeding fixed-size chunks into `capture` and each
/// complete line to `observer`. Read errors end the drain — a broken pipe means
/// the child is gone and there is nothing left to capture.
pub(super) fn drain_into(mut pipe: impl Read, capture: &Capture, observer: Option<&LineObserver>) {
    let mut chunk = [0u8; 8192];
    let mut lines = LineSplitter::default();
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => return,
            Ok(n) => {
                capture.push(&chunk[..n]);
                if let Some(observe) = observer {
                    lines.feed(&chunk[..n], |line| observe(line));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        }
    }
}

/// Reassembles lines from arbitrary read chunks. A partial trailing line is
/// held until its newline arrives, so an observer only ever sees complete
/// lines. The buffer is capped: a program that prints megabytes without a
/// newline must not grow it without bound.
#[derive(Default)]
struct LineSplitter {
    partial: Vec<u8>,
}

impl LineSplitter {
    /// Longest line reassembled. Beyond this the excess is dropped, since the
    /// consumer displays a single truncated line anyway.
    const MAX_LINE: usize = 4096;

    fn feed(&mut self, chunk: &[u8], mut emit: impl FnMut(&str)) {
        for byte in chunk {
            if *byte == b'\n' {
                let line = String::from_utf8_lossy(&self.partial).trim().to_string();
                self.partial.clear();
                if !line.is_empty() {
                    emit(&line);
                }
            } else if self.partial.len() < Self::MAX_LINE {
                self.partial.push(*byte);
            }
        }
    }
}

/// Rate limiter for the live output line: at most one event per
/// `min_interval`. Lines arriving inside the window are dropped rather than
/// buffered — the UI shows the latest line, so a stale backlog has no value.
pub(super) struct Throttle {
    min_interval: Duration,
    last: Mutex<Option<Instant>>,
}

impl Throttle {
    pub(super) fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            last: Mutex::new(None),
        }
    }

    pub(super) fn allows(&self, now: Instant) -> bool {
        let Ok(mut last) = self.last.lock() else {
            return false;
        };
        if last.is_some_and(|prev| now.duration_since(prev) < self.min_interval) {
            return false;
        }
        *last = Some(now);
        true
    }
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
#[path = "install_capture_tests.rs"]
mod tests;

use std::{
    collections::BTreeMap,
    io::{Read as _, Write as _},
    net::{TcpListener, TcpStream},
    process::{Child, Command, ExitStatus, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use serde_json::Value;

use buzz_relay::lifecycle::StartupPhase;
use buzz_relay::startup_steps;
use buzz_relay::state::REDIS_BOOTSTRAP_FAILURE;

const VALID_RELAY_PRIVATE_KEY: &str =
    "0000000000000000000000000000000000000000000000000000000000000001";
const CHILD_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CAPTURE_BYTES: u64 = 1024 * 1024;
/// Bound on every wait for the relay to export a metric family.
const METRICS_SCRAPE_DEADLINE: Duration = Duration::from_secs(8);

struct RelayProcess {
    child: Option<Child>,
    stdout: Option<JoinHandle<CapturedStream>>,
    stderr: Option<JoinHandle<CapturedStream>>,
    scratch_dir: std::path::PathBuf,
}

struct CapturedStream {
    retained: Vec<u8>,
    total_bytes: u64,
}

impl RelayProcess {
    fn spawn(environment: &[(&str, &str)]) -> Self {
        let scratch_dir =
            std::env::temp_dir().join(format!("buzz-boot-lifecycle-{}", uuid::Uuid::new_v4()));
        let mut command = Command::new(env!("CARGO_BIN_EXE_buzz-relay"));
        command
            .env_clear()
            .env("RUST_BACKTRACE", "0")
            .env("RUST_LOG", "buzz_relay=info")
            .env("BUZZ_GIT_REPO_PATH", scratch_dir.join("repos"))
            .env("BUZZ_GIT_PACK_CACHE_PATH", scratch_dir.join("pack-cache"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (name, value) in environment {
            command.env(name, value);
        }
        let mut child = command.spawn().expect("spawn buzz-relay child process");
        let stdout = child.stdout.take().expect("relay stdout pipe");
        let stderr = child.stderr.take().expect("relay stderr pipe");
        Self {
            child: Some(child),
            stdout: Some(thread::spawn(move || capture_stream(stdout))),
            stderr: Some(thread::spawn(move || capture_stream(stderr))),
            scratch_dir,
        }
    }

    fn try_wait(&mut self) -> Option<ExitStatus> {
        self.child
            .as_mut()
            .expect("relay child")
            .try_wait()
            .expect("poll relay child")
    }

    fn wait(mut self, timeout: Duration) -> Output {
        let deadline = Instant::now() + timeout;
        let status = loop {
            if let Some(status) = self.try_wait() {
                break status;
            }
            if Instant::now() >= deadline {
                let child = self.child.as_mut().expect("relay child");
                let _ = child.kill();
                let _ = child.wait();
                panic!("buzz-relay child exceeded {timeout:?}");
            }
            thread::sleep(Duration::from_millis(10));
        };
        self.child.take();
        let output = Output {
            status,
            stdout: join_capture(self.stdout.take(), "stdout"),
            stderr: join_capture(self.stderr.take(), "stderr"),
        };
        let _ = std::fs::remove_dir_all(&self.scratch_dir);
        output
    }

    fn terminate(mut self) -> Output {
        self.child
            .as_mut()
            .expect("relay child")
            .kill()
            .expect("terminate exact relay child");
        self.wait(Duration::from_secs(2))
    }
}

impl Drop for RelayProcess {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = std::fs::remove_dir_all(&self.scratch_dir);
    }
}

fn capture_stream(mut stream: impl std::io::Read) -> CapturedStream {
    let mut retained = Vec::new();
    let mut total_bytes = 0_u64;
    let mut chunk = [0_u8; 8192];
    loop {
        let read = stream.read(&mut chunk).expect("read relay output pipe");
        if read == 0 {
            break;
        }
        total_bytes = total_bytes.saturating_add(u64::try_from(read).expect("read size fits u64"));
        let remaining = usize::try_from(MAX_CAPTURE_BYTES)
            .expect("capture ceiling fits usize")
            .saturating_sub(retained.len());
        retained.extend_from_slice(&chunk[..read.min(remaining)]);
    }
    CapturedStream {
        retained,
        total_bytes,
    }
}

fn join_capture(capture: Option<JoinHandle<CapturedStream>>, stream: &str) -> Vec<u8> {
    let capture = capture
        .expect("relay capture thread")
        .join()
        .expect("relay capture thread must not panic");
    assert!(
        capture.total_bytes <= MAX_CAPTURE_BYTES,
        "relay {stream} exceeded {MAX_CAPTURE_BYTES} bytes: {}",
        capture.total_bytes,
    );
    capture.retained
}

fn run_relay(environment: &[(&str, &str)]) -> Output {
    RelayProcess::spawn(environment).wait(CHILD_TIMEOUT)
}

fn scrape_metrics(port: u16) -> std::io::Result<String> {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(100))?;
    stream.set_read_timeout(Some(Duration::from_millis(500)))?;
    stream.write_all(b"GET /metrics HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response)
}

fn wait_for_relay_metrics(process: &mut RelayProcess, port: u16) -> String {
    wait_for_scraped_metric(process, port, "buzz_audit_enabled")
}

/// Polls the relay's own `/metrics` until `needle` appears, bounded by
/// [`METRICS_SCRAPE_DEADLINE`]. A relay that exits first is a failure, not a
/// timeout, so the panic names the real cause.
fn wait_for_scraped_metric(process: &mut RelayProcess, port: u16, needle: &str) -> String {
    let deadline = Instant::now() + METRICS_SCRAPE_DEADLINE;
    loop {
        assert!(
            process.try_wait().is_none(),
            "relay exited before exporting {needle}"
        );
        if let Ok(response) = scrape_metrics(port) {
            if response.contains(needle) {
                return response;
            }
        }
        assert!(
            Instant::now() < deadline,
            "relay did not export {needle} within {METRICS_SCRAPE_DEADLINE:?}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

/// The early lifecycle phases (crypto through metrics bind) are log-only.
/// The only startup metric families are the post-metrics-bind step gauges,
/// and no metric family or label value may name an early phase.
fn assert_no_early_lifecycle_metrics(scrape: &str) {
    let step_families = [startup_steps::CURRENT_METRIC, startup_steps::SECONDS_METRIC];
    for line in scrape.lines() {
        for phase in StartupPhase::ALL {
            assert!(
                !line.contains(&format!("\"{}\"", phase.as_str())),
                "logs-only lifecycle contract exported early phase {}: {line}",
                phase.as_str()
            );
        }
        let Some(name) = line
            .strip_prefix("# HELP ")
            .or_else(|| line.strip_prefix("# TYPE "))
            .and_then(|rest| rest.split_ascii_whitespace().next())
        else {
            continue;
        };
        if step_families.contains(&name) {
            continue;
        }
        assert!(
            !["startup", "boot", "lifecycle"]
                .iter()
                .any(|term| name.contains(term))
                && !StartupPhase::ALL
                    .iter()
                    .any(|phase| name.contains(phase.as_str())),
            "logs-only lifecycle contract emitted metric family {name}"
        );
    }
}

fn assert_auth_metrics_have_stable_boot_zeros(scrape: &str) {
    const OUTCOMES: [&str; 11] = [
        "success",
        "invalid",
        "banned",
        "ban_check_error",
        "allowlist_check_error",
        "allowlist_denied",
        "relay_membership_check_error",
        "not_relay_member",
        "timeout",
        "disconnect",
        "shutdown",
    ];

    assert!(scrape.contains("# TYPE buzz_auth_attempts_total counter"));
    assert!(scrape.contains("buzz_auth_attempts_total{method=\"nip42\"} 0"));
    assert!(scrape.contains("# TYPE buzz_auth_outcomes_total counter"));
    assert!(scrape.contains("# TYPE buzz_auth_duration_seconds histogram"));
    assert!(scrape.contains("# TYPE buzz_auth_post_terminal_frames_total counter"));
    assert!(scrape.contains("buzz_auth_post_terminal_frames_total{state=\"authenticated\"} 0"));
    assert!(scrape.contains("buzz_auth_post_terminal_frames_total{state=\"failed\"} 0"));
    assert!(scrape.contains("buzz_ws_authenticated_connections_active 0"));

    for outcome in OUTCOMES {
        assert!(scrape.contains(&format!(
            "buzz_auth_outcomes_total{{method=\"nip42\",outcome=\"{outcome}\"}} 0"
        )));
        assert!(scrape.contains(&format!(
            "buzz_auth_duration_seconds_count{{method=\"nip42\",outcome=\"{outcome}\"}} 0"
        )));
        assert!(scrape.contains(&format!(
            "buzz_auth_duration_seconds_sum{{method=\"nip42\",outcome=\"{outcome}\"}} 0"
        )));
        assert!(scrape.lines().any(|line| {
            line.starts_with("buzz_auth_duration_seconds_bucket{")
                && line.contains("le=\"+Inf\"")
                && line.contains("method=\"nip42\"")
                && line.contains(&format!("outcome=\"{outcome}\""))
                && line.ends_with(" 0")
        }));
    }
}

fn lifecycle_events(output: &Output) -> Vec<Value> {
    let mut events: Vec<Value> = output
        .stdout
        .split(|byte| *byte == b'\n')
        .chain(output.stderr.split(|byte| *byte == b'\n'))
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .filter(|event| event["event_name"] == "buzz_process_lifecycle")
        .collect();
    events.sort_by_key(|event| event["sequence"].as_u64());
    events
}

fn lifecycle_events_from(bytes: &[u8]) -> Vec<Value> {
    bytes
        .split(|byte| *byte == b'\n')
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .filter(|event| event["event_name"] == "buzz_process_lifecycle")
        .collect()
}

fn assert_accounting(events: &[Value]) {
    assert!(!events.is_empty(), "child emitted no lifecycle events");
    let boot_id = events[0]["process_boot_id"]
        .as_str()
        .expect("process_boot_id");
    let mut counts = BTreeMap::<String, (usize, usize)>::new();
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event["schema_version"], 1);
        assert_eq!(event["sequence"], u64::try_from(index + 1).unwrap());
        assert_eq!(event["process_boot_id"], boot_id);
        assert_eq!(event["track"], "startup");
        let count = counts
            .entry(event["phase"].as_str().expect("phase").to_owned())
            .or_default();
        match event["edge"].as_str() {
            Some("started") => count.0 += 1,
            Some("terminal") => count.1 += 1,
            other => panic!("unexpected lifecycle edge: {other:?}"),
        }
    }
    assert!(
        counts
            .values()
            .all(|(started, terminal)| *started == 1 && *terminal == 1),
        "every started phase must have one terminal: {counts:?}"
    );
}

fn assert_terminal(events: &[Value], phase: &str, status: &str, reason: Option<&str>) {
    let terminal = events
        .iter()
        .find(|event| event["phase"] == phase && event["edge"] == "terminal")
        .unwrap_or_else(|| panic!("missing {phase} terminal"));
    assert_eq!(terminal["status"], status);
    match reason {
        Some(reason) => assert_eq!(terminal["reason"], reason),
        None => assert!(terminal["reason"].is_null()),
    }
}

fn phases(events: &[Value]) -> Vec<&str> {
    events
        .iter()
        .filter(|event| event["edge"] == "started")
        .map(|event| event["phase"].as_str().expect("phase"))
        .collect()
}

#[test]
fn invalid_config_terminalizes_at_main_even_with_logs_disabled() {
    let output = run_relay(&[
        ("RUST_LOG", "off"),
        ("BUZZ_BIND_ADDR", "not-a-socket-address"),
    ]);
    assert!(!output.status.success());
    let events = lifecycle_events(&output);
    assert_accounting(&events);
    assert_eq!(
        phases(&events),
        [
            "process_telemetry",
            "crypto_init",
            "tracing_init",
            "config_load"
        ]
    );
    assert_terminal(&events, "config_load", "failed", Some("config_invalid"));
    assert_terminal(
        &events,
        "process_telemetry",
        "failed",
        Some("config_invalid"),
    );
    assert_eq!(lifecycle_events_from(&output.stderr), events);
    assert!(lifecycle_events_from(&output.stdout).is_empty());
}

#[test]
#[cfg(unix)]
fn config_filesystem_failure_has_a_bounded_terminal() {
    let output = run_relay(&[
        ("RUST_LOG", "off"),
        ("BUZZ_GIT_REPO_PATH", "/dev/null/not-a-directory"),
    ]);
    assert!(!output.status.success());
    let events = lifecycle_events(&output);
    assert_accounting(&events);
    assert_terminal(&events, "config_load", "failed", Some("config_invalid"));
    assert_terminal(
        &events,
        "process_telemetry",
        "failed",
        Some("config_invalid"),
    );
}

#[test]
fn invalid_config_value_has_the_same_bounded_terminal() {
    let output = run_relay(&[("RUST_LOG", "off"), ("BUZZ_DRAIN_JITTER_MS", "bogus")]);
    assert!(!output.status.success());
    let events = lifecycle_events(&output);
    assert_accounting(&events);
    assert_terminal(&events, "config_load", "failed", Some("config_invalid"));
    assert_terminal(
        &events,
        "process_telemetry",
        "failed",
        Some("config_invalid"),
    );
}

#[test]
fn configured_otlp_terminalizes_tracing_before_a_later_failure() {
    let output = run_relay(&[
        ("RUST_LOG", "off"),
        ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4317"),
        ("BUZZ_BIND_ADDR", "not-a-socket-address"),
    ]);
    assert!(!output.status.success());
    let events = lifecycle_events(&output);
    assert_accounting(&events);
    assert_terminal(&events, "tracing_init", "succeeded", None);
    assert_terminal(&events, "config_load", "failed", Some("config_invalid"));
}

#[test]
fn missing_key_stops_before_metrics_bind() {
    let output = run_relay(&[]);
    assert!(!output.status.success());
    let events = lifecycle_events(&output);
    assert_accounting(&events);
    assert_eq!(
        phases(&events),
        [
            "process_telemetry",
            "crypto_init",
            "tracing_init",
            "config_load",
            "key_load"
        ]
    );
    assert_terminal(&events, "key_load", "failed", Some("missing"));
    assert_terminal(&events, "process_telemetry", "failed", Some("missing"));
}

#[test]
fn invalid_key_uses_a_bounded_reason_without_leaking_the_value() {
    let secret = "private-key-material-that-must-not-appear";
    let output = run_relay(&[("BUZZ_RELAY_PRIVATE_KEY", secret)]);
    assert!(!output.status.success());
    let events = lifecycle_events(&output);
    assert_accounting(&events);
    assert_terminal(&events, "key_load", "failed", Some("required_invalid"));
    let combined = [output.stdout, output.stderr].concat();
    assert!(!String::from_utf8_lossy(&combined).contains(secret));
}

#[test]
fn occupied_metrics_port_has_a_typed_bind_terminal() {
    let occupied = TcpListener::bind(("0.0.0.0", 0)).expect("bind occupied port");
    let port = occupied.local_addr().expect("occupied address").port();
    let port = port.to_string();
    let output = run_relay(&[
        ("BUZZ_RELAY_PRIVATE_KEY", VALID_RELAY_PRIVATE_KEY),
        ("BUZZ_METRICS_PORT", &port),
    ]);
    assert!(!output.status.success());
    let events = lifecycle_events(&output);
    assert_accounting(&events);
    assert_terminal(&events, "metrics_bind", "failed", Some("bind"));
    assert_terminal(&events, "process_telemetry", "failed", Some("bind"));
}

#[test]
fn otlp_build_failure_is_degraded_without_leaking_endpoint_credentials() {
    let secret = "telemetry-secret-marker";
    let endpoint = format!("https://telemetry-user:{secret}@[");
    let fake_database = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake database");
    let database_url = format!(
        "postgres://buzz@127.0.0.1:{}/buzz",
        fake_database.local_addr().expect("database address").port()
    );
    let reserved = TcpListener::bind(("127.0.0.1", 0)).expect("reserve metrics port");
    let port = reserved.local_addr().expect("metrics address").port();
    drop(reserved);
    let port_value = port.to_string();
    let mut process = RelayProcess::spawn(&[
        ("OTEL_EXPORTER_OTLP_ENDPOINT", &endpoint),
        ("RUST_LOG", "buzz_relay=warn"),
        ("BUZZ_RELAY_PRIVATE_KEY", VALID_RELAY_PRIVATE_KEY),
        ("BUZZ_METRICS_PORT", &port_value),
        ("DATABASE_URL", &database_url),
    ]);
    let scrape = wait_for_relay_metrics(&mut process, port);
    assert_no_early_lifecycle_metrics(&scrape);
    let output = process.terminate();
    let events = lifecycle_events(&output);
    assert_accounting(&events);
    assert_terminal(&events, "tracing_init", "degraded", Some("exporter_build"));
    assert_terminal(
        &events,
        "process_telemetry",
        "degraded",
        Some("exporter_build"),
    );
    let combined = [output.stdout, output.stderr].concat();
    assert!(!String::from_utf8_lossy(&combined).contains(secret));
}

#[test]
fn successful_main_emits_complete_lifecycle_and_reports_current_startup_step() {
    let fake_database = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake database");
    let database_url = format!(
        "postgres://buzz@127.0.0.1:{}/buzz",
        fake_database.local_addr().expect("database address").port()
    );
    let reserved = TcpListener::bind(("127.0.0.1", 0)).expect("reserve metrics port");
    let port = reserved.local_addr().expect("metrics address").port();
    drop(reserved);
    let port_value = port.to_string();
    let mut process = RelayProcess::spawn(&[
        ("RUST_LOG", "off"),
        ("BUZZ_RELAY_PRIVATE_KEY", VALID_RELAY_PRIVATE_KEY),
        ("BUZZ_METRICS_PORT", &port_value),
        ("DATABASE_URL", &database_url),
    ]);
    let scrape = wait_for_relay_metrics(&mut process, port);
    assert_no_early_lifecycle_metrics(&scrape);
    assert_auth_metrics_have_stable_boot_zeros(&scrape);
    // The fake database accepts TCP but never speaks Postgres, so the relay
    // stays in its first post-metrics-bind step and must say so on /metrics.
    let current = format!(
        "{}{{phase=\"db_connect\"}} 1",
        startup_steps::CURRENT_METRIC
    );
    let scrape = wait_for_scraped_metric(&mut process, port, &current);
    assert!(
        !scrape.contains(&format!("{}{{", startup_steps::SECONDS_METRIC)),
        "no step has finished while the relay waits on Postgres"
    );
    assert_no_early_lifecycle_metrics(&scrape);

    let output = process.terminate();
    let events = lifecycle_events(&output);
    assert_accounting(&events);
    assert_terminal(&events, "crypto_init", "succeeded", None);
    assert_terminal(&events, "tracing_init", "succeeded", None);
    assert_terminal(&events, "config_load", "succeeded", None);
    assert_terminal(&events, "key_load", "succeeded", None);
    assert_terminal(&events, "metrics_bind", "succeeded", None);
    assert_terminal(&events, "process_telemetry", "succeeded", None);
}

/// Boot gates that need a live Postgres to reach the code under test. Named
/// `postgres_tests` so `.config/nextest.toml`'s `postgres-ci` default filter
/// discovers them structurally; the wrapper hands each test its own database
/// through `DATABASE_URL`.
mod postgres_tests {
    use super::*;

    /// The relay's overall Redis bootstrap budget across retries
    /// (`REDIS_BOOTSTRAP_TIMEOUT` in `state.rs`).
    const REDIS_BOOTSTRAP_BUDGET: Duration = Duration::from_secs(15);
    const REDIS_BOOTSTRAP_SCHEDULING_SLACK: Duration = Duration::from_secs(3);

    /// How a [`FakeRedisPeer`] treats each connection it accepts.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum FakeRedisBehavior {
        /// Complete the handshake on every connection, then read and hold PING
        /// without replying. This distinguishes a bounded checkout + PING from
        /// a refused connection, which returns before any timeout is exercised.
        HoldPing,
        /// Never answer the first connection's handshake, so the driver's
        /// connection timeout fires as it did in production, then answer every
        /// later connection's handshake and PING.
        StallFirstConnection,
    }

    /// A TCP peer that speaks just enough Redis to drive the bootstrap gate.
    /// Each accepted connection is served on its own thread, so a held
    /// connection never blocks the relay's retry from being accepted.
    struct FakeRedisPeer {
        redis_url: String,
        request_received: mpsc::Receiver<Vec<u8>>,
        stop: Arc<AtomicBool>,
        worker: Option<JoinHandle<()>>,
    }

    impl FakeRedisPeer {
        fn spawn(behavior: FakeRedisBehavior) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake Redis peer");
            listener
                .set_nonblocking(true)
                .expect("set fake Redis listener nonblocking");
            let port = listener.local_addr().expect("fake Redis address").port();
            let (request_tx, request_received) = mpsc::channel();
            let stop = Arc::new(AtomicBool::new(false));
            let worker_stop = Arc::clone(&stop);
            let worker = thread::spawn(move || {
                let mut connections = Vec::new();
                let mut accepted = 0_usize;
                while !worker_stop.load(Ordering::SeqCst) {
                    let (stream, _) = match listener.accept() {
                        Ok(accepted) => accepted,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10));
                            continue;
                        }
                        Err(error) => panic!("accept fake Redis connection: {error}"),
                    };
                    accepted += 1;
                    let stall =
                        behavior == FakeRedisBehavior::StallFirstConnection && accepted == 1;
                    let (request_tx, stop) = (request_tx.clone(), Arc::clone(&worker_stop));
                    connections.push(thread::spawn(move || {
                        serve_fake_redis_connection(stream, behavior, stall, &request_tx, &stop)
                    }));
                }
                for connection in connections {
                    connection
                        .join()
                        .expect("fake Redis connection must not panic");
                }
            });
            Self {
                redis_url: format!("redis://127.0.0.1:{port}"),
                request_received,
                stop,
                worker: Some(worker),
            }
        }

        fn redis_url(&self) -> &str {
            &self.redis_url
        }

        fn assert_request_received(&self, logs: &str) {
            let request = self
                .request_received
                .recv_timeout(Duration::from_secs(1))
                .unwrap_or_else(|_| panic!("relay must reach the fake Redis peer: {logs}"));
            assert!(!request.is_empty(), "fake Redis peer read an empty request");
        }
    }

    impl Drop for FakeRedisPeer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(worker) = self.worker.take() {
                worker.join().expect("fake Redis peer must not panic");
            }
        }
    }

    /// Serve one fake Redis connection until the client hangs up or the peer
    /// stops. `stall` reads without ever replying.
    fn serve_fake_redis_connection(
        mut stream: TcpStream,
        behavior: FakeRedisBehavior,
        stall: bool,
        request_tx: &mpsc::Sender<Vec<u8>>,
        stop: &AtomicBool,
    ) {
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("bound fake Redis read");
        let mut request = Vec::new();
        let mut holding = false;
        while !stop.load(Ordering::SeqCst) {
            let mut chunk = [0_u8; 4096];
            match stream.read(&mut chunk) {
                Ok(0) => return,
                Ok(read) => {
                    if stall || holding {
                        continue;
                    }
                    request.extend_from_slice(&chunk[..read]);
                    assert!(
                        request.len() <= 4096,
                        "fake Redis peer received an oversized request"
                    );
                    let setinfo_commands = request
                        .windows(b"SETINFO".len())
                        .filter(|window| *window == b"SETINFO")
                        .count();
                    if setinfo_commands >= 2 {
                        // redis-rs pipelines CLIENT SETINFO lib-name and
                        // lib-ver while establishing a connection. Complete
                        // that handshake so the relay reaches its explicit
                        // bootstrap PING.
                        if stream.write_all(b"+OK\r\n+OK\r\n").is_err() {
                            return;
                        }
                        request.clear();
                        continue;
                    }
                    if request
                        .windows(b"PING".len())
                        .any(|window| window == b"PING")
                    {
                        let _ = request_tx.send(std::mem::take(&mut request));
                        match behavior {
                            FakeRedisBehavior::HoldPing => holding = true,
                            FakeRedisBehavior::StallFirstConnection => {
                                if stream.write_all(b"+PONG\r\n").is_err() {
                                    return;
                                }
                            }
                        }
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => return,
            }
        }
    }

    fn reserve_closed_port() -> u16 {
        let reserved = TcpListener::bind(("127.0.0.1", 0)).expect("reserve port");
        let port = reserved.local_addr().expect("reserved address").port();
        drop(reserved);
        port
    }

    /// Runs the relay until it exits on its own, or kills it once `timeout`
    /// passes. Unlike `run_relay`, a relay that keeps serving is a result to
    /// assert on rather than a panic, which is the whole point here.
    fn run_until_exit(environment: &[(&str, &str)], timeout: Duration) -> (bool, Output) {
        let mut process = RelayProcess::spawn(environment);
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if process.try_wait().is_some() {
                return (true, process.wait(Duration::from_secs(2)));
            }
            thread::sleep(Duration::from_millis(20));
        }
        (false, process.terminate())
    }

    /// Redis is required for pub/sub fan-out, presence, and typing, but nothing
    /// in boot ever opened a command connection: `deadpool_redis` pools dial
    /// lazily and `PubSubManager::new` only allocates channels, so "Redis
    /// pub/sub connected" was logged against a dead port. A relay could
    /// therefore boot with Redis unreachable, bind its health listener, and —
    /// now that readiness answers from local lifecycle alone — advertise ready
    /// for the rest of its life. The bootstrap gate is the one-time proof that
    /// the command path has connected at least once, and it has to land before
    /// the listener binds, because binding is the one-way latch that makes this
    /// pod routable.
    ///
    /// The git conformance probe is disabled so the only remaining startup-fatal
    /// gate is the one under test.
    #[test]
    #[ignore = "requires PostgreSQL"]
    fn unreachable_redis_fails_boot_before_the_health_listener_binds() {
        let database_url = std::env::var("DATABASE_URL")
            .expect("postgres lane provides DATABASE_URL for each test process");
        let redis_url = format!("redis://127.0.0.1:{}", reserve_closed_port());
        let metrics_port = reserve_closed_port().to_string();
        let health_port = reserve_closed_port();
        let health_port_value = health_port.to_string();

        let (exited, output) = run_until_exit(
            &[
                ("BUZZ_RELAY_PRIVATE_KEY", VALID_RELAY_PRIVATE_KEY),
                ("BUZZ_METRICS_PORT", &metrics_port),
                ("BUZZ_HEALTH_PORT", &health_port_value),
                ("DATABASE_URL", &database_url),
                ("REDIS_URL", &redis_url),
                ("BUZZ_GIT_CONFORMANCE_PROBE", "false"),
            ],
            CHILD_TIMEOUT,
        );
        let logs = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );

        assert!(
            !logs.contains("Health probe listener started"),
            "the Redis bootstrap gate must run before the health listener binds: {logs}"
        );
        assert!(
            exited && !output.status.success(),
            "an unreachable Redis command path must be startup-fatal: {logs}"
        );
        assert!(
            logs.contains(REDIS_BOOTSTRAP_FAILURE),
            "the failure must name the gate that rejected boot: {logs}"
        );
        assert!(
            TcpListener::bind(("0.0.0.0", health_port)).is_ok(),
            "the health port must never have been bound"
        );
    }

    /// A peer that accepts every socket but withholds its Redis response
    /// exercises the per-attempt timeout around lazy pool checkout and PING,
    /// and the overall budget across retries: the relay keeps retrying until
    /// the budget is spent, then fails boot. Removing either bound makes this
    /// test kill a still-running relay at the deadline instead of observing a
    /// startup failure.
    #[test]
    #[ignore = "requires PostgreSQL"]
    fn hanging_redis_peer_times_out_before_the_health_listener_binds() {
        let database_url = std::env::var("DATABASE_URL")
            .expect("postgres lane provides DATABASE_URL for each test process");
        let redis_peer = FakeRedisPeer::spawn(FakeRedisBehavior::HoldPing);
        let metrics_port = reserve_closed_port().to_string();
        let health_port = reserve_closed_port();
        let health_port_value = health_port.to_string();
        let timeout = REDIS_BOOTSTRAP_BUDGET + REDIS_BOOTSTRAP_SCHEDULING_SLACK;
        let started_at = Instant::now();

        let (exited, output) = run_until_exit(
            &[
                ("BUZZ_RELAY_PRIVATE_KEY", VALID_RELAY_PRIVATE_KEY),
                ("BUZZ_METRICS_PORT", &metrics_port),
                ("BUZZ_HEALTH_PORT", &health_port_value),
                ("DATABASE_URL", &database_url),
                ("REDIS_URL", redis_peer.redis_url()),
                ("BUZZ_GIT_CONFORMANCE_PROBE", "false"),
            ],
            timeout,
        );
        let elapsed = started_at.elapsed();
        let logs = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        redis_peer.assert_request_received(&logs);

        assert!(
            elapsed >= REDIS_BOOTSTRAP_BUDGET,
            "the fake peer must hold the request through the bootstrap budget: {elapsed:?}: {logs}"
        );
        assert!(
            exited && elapsed < timeout && !output.status.success(),
            "the outer bootstrap timeout must terminate the relay within scheduling slack: {elapsed:?}: {logs}"
        );
        assert!(
            logs.contains(REDIS_BOOTSTRAP_FAILURE),
            "the timeout must report the bounded Redis bootstrap failure: {logs}"
        );
        assert!(
            !logs.contains("Health probe listener started"),
            "the health listener must not bind before Redis bootstrap succeeds: {logs}"
        );
        assert!(
            TcpListener::bind(("0.0.0.0", health_port)).is_ok(),
            "the health port must never have been bound"
        );
    }

    /// Regression for the 2026-10-21 relay boot restarts: the first Redis dial
    /// timed out after the driver's one-second connection timeout and failed
    /// boot outright. A peer that stalls only the first connection's handshake
    /// reproduces that dial; the gate must retry, connect on the next attempt
    /// and carry on with boot instead of exiting.
    ///
    /// Mutation: make the gate single-attempt again → the relay exits with
    /// [`REDIS_BOOTSTRAP_FAILURE`] after about a second → RED.
    #[test]
    #[ignore = "requires PostgreSQL"]
    fn slow_first_redis_dial_is_retried_and_boot_continues() {
        let database_url = std::env::var("DATABASE_URL")
            .expect("postgres lane provides DATABASE_URL for each test process");
        let redis_peer = FakeRedisPeer::spawn(FakeRedisBehavior::StallFirstConnection);
        let metrics_port = reserve_closed_port().to_string();
        let health_port_value = reserve_closed_port().to_string();

        let (_exited, output) = run_until_exit(
            &[
                ("BUZZ_RELAY_PRIVATE_KEY", VALID_RELAY_PRIVATE_KEY),
                ("BUZZ_METRICS_PORT", &metrics_port),
                ("BUZZ_HEALTH_PORT", &health_port_value),
                ("DATABASE_URL", &database_url),
                ("REDIS_URL", redis_peer.redis_url()),
                ("BUZZ_GIT_CONFORMANCE_PROBE", "false"),
            ],
            CHILD_TIMEOUT,
        );
        let logs = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        redis_peer.assert_request_received(&logs);

        assert!(
            logs.contains("Redis bootstrap attempt failed; retrying"),
            "the stalled first dial must be retried: {logs}"
        );
        assert!(
            logs.contains("Redis bootstrap succeeded after retry"),
            "the retry must reach the Redis command path: {logs}"
        );
        assert!(
            logs.contains("Redis command path connected"),
            "boot must continue past the Redis gate: {logs}"
        );
        assert!(
            !logs.contains(REDIS_BOOTSTRAP_FAILURE),
            "a dial that recovers within the budget must not fail boot: {logs}"
        );
    }

    /// Startup is the only owner of dependency evaluation. `/_status` just reads
    /// the cache, a readiness probe records no dependency attempt at all, and no
    /// request path may start a check — so if `main` stops spawning the sampler,
    /// this pod evaluates Postgres, Redis, and the deletion catalog exactly
    /// never: the dependency families stay absent from its scrape and `/_status`
    /// answers `not_yet_sampled` for the pod's whole life.
    ///
    /// No in-process test can fail on that, because each one drives `sample`
    /// itself. This one boots the real binary against real dependencies and
    /// reads only the relay's own `/metrics` — no probe, no `/_status`, nothing
    /// that could evaluate a dependency on the test's behalf. The first tick
    /// fires immediately, so the wait is bounded by
    /// [`METRICS_SCRAPE_DEADLINE`] and never a fixed sleep.
    ///
    /// The completion-timestamp gauge is the needle because `sample` writes it
    /// last, after the cache already serves the report: observing it proves the
    /// whole cycle ran, with no window where the counters have landed but the
    /// timestamp has not.
    #[test]
    #[ignore = "requires PostgreSQL"]
    fn startup_owns_the_dependency_sampler() {
        let database_url = std::env::var("DATABASE_URL")
            .expect("postgres lane provides DATABASE_URL for each test process");
        let redis_url = std::env::var("REDIS_URL")
            .expect("the postgres lane runs alongside Redis and exports REDIS_URL");
        let metrics_port = reserve_closed_port();
        let metrics_port_value = metrics_port.to_string();
        let health_port_value = reserve_closed_port().to_string();
        let bind_addr = format!("127.0.0.1:{}", reserve_closed_port());

        let mut process = RelayProcess::spawn(&[
            ("BUZZ_RELAY_PRIVATE_KEY", VALID_RELAY_PRIVATE_KEY),
            ("BUZZ_METRICS_PORT", &metrics_port_value),
            ("BUZZ_HEALTH_PORT", &health_port_value),
            ("BUZZ_BIND_ADDR", &bind_addr),
            ("DATABASE_URL", &database_url),
            ("REDIS_URL", &redis_url),
            ("BUZZ_GIT_CONFORMANCE_PROBE", "false"),
        ]);
        let scrape = wait_for_scraped_metric(
            &mut process,
            metrics_port,
            "buzz_readiness_dependency_sample_completed_timestamp_seconds",
        );
        let output = process.terminate();
        let logs = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );

        assert!(
            scrape.contains("buzz_readiness_dependency_checks_total{"),
            "the same cycle must publish its per-dependency outcomes: {scrape}"
        );
        assert!(
            scrape.contains("buzz_readiness_check_duration_seconds"),
            "a completed evaluation must publish its latency too: {scrape}"
        );
        assert!(
            !scrape.contains("buzz_readiness_checks_total{"),
            "no readiness probe was sent, so the sampler alone produced this: {scrape}"
        );
        assert!(
            logs.contains("Health probe listener started"),
            "the sampler must be owned by a relay that finished booting: {logs}"
        );
    }

    /// The production readiness probe gives a starting relay about 30 s
    /// before liveness restarts it. A restarted relay has to come up well
    /// inside that, so the bound here leaves room for migrations on a cold
    /// test database and nothing else.
    const MESH_RESTART_READY_BUDGET: Duration = Duration::from_secs(20);
    /// `serve` holds a 5 s routing grace, then drains with a 30 s backstop.
    const SIGTERM_EXIT_BUDGET: Duration = Duration::from_secs(45);

    /// One plain HTTP/1.0 GET against the relay's loopback health listener.
    fn http_get(port: u16, path: &str) -> std::io::Result<(u16, String)> {
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(100))?;
        stream.set_read_timeout(Some(Duration::from_millis(500)))?;
        stream.write_all(format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())?;
        let mut response = String::new();
        stream.read_to_string(&mut response)?;
        let status = response
            .split_ascii_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .ok_or_else(|| std::io::Error::other("unparseable HTTP status line"))?;
        let body = response
            .split_once("\r\n\r\n")
            .map(|(_, body)| body.to_string())
            .unwrap_or_default();
        Ok((status, body))
    }

    /// Polls `/_readiness` until it answers 200, panicking if the relay exits
    /// first or `budget` runs out. Returns how long readiness took.
    fn wait_for_readiness(
        process: &mut RelayProcess,
        health_port: u16,
        budget: Duration,
    ) -> Duration {
        let started = Instant::now();
        loop {
            assert!(
                process.try_wait().is_none(),
                "relay exited before it became ready"
            );
            if let Ok((200, _)) = http_get(health_port, "/_readiness") {
                return started.elapsed();
            }
            assert!(
                started.elapsed() < budget,
                "relay was not ready within {budget:?}"
            );
            thread::sleep(Duration::from_millis(50));
        }
    }

    /// Reads the relay's own `/_mesh` status document.
    fn mesh_status(health_port: u16) -> Value {
        let (status, body) = http_get(health_port, "/_mesh").expect("query /_mesh");
        assert_eq!(status, 200, "/_mesh must answer on a ready relay: {body}");
        serde_json::from_str(&body).expect("/_mesh returns JSON")
    }

    fn ready_record_exists(redis: &mut redis::Connection, runtime_id: &str) -> bool {
        redis::cmd("EXISTS")
            .arg(format!("mesh:ready:{runtime_id}"))
            .query::<bool>(redis)
            .expect("EXISTS on the test Redis")
    }

    /// Sends SIGTERM to this test's own relay child (never any other PID).
    fn send_sigterm(process: &RelayProcess) {
        let pid = process.child.as_ref().expect("relay child").id();
        let status = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .expect("run kill -TERM for the relay child");
        assert!(status.success(), "kill -TERM {pid} failed: {status}");
    }

    /// A relay killed without cleanup leaves its mesh ready record in Redis
    /// until the record's TTL runs out. When the replacement boots at the same
    /// advertised address, that record names this process's own address under
    /// a dead runtime id. Startup must not wait on it: readiness has to come
    /// up well inside the probe budget, the record must never become a mesh
    /// peer, and the same holds for a second restart in a row. On SIGTERM the
    /// relay must delete its own ready record, drain, and exit 0.
    #[test]
    #[ignore = "requires PostgreSQL"]
    fn mesh_restart_at_the_same_address_reaches_readiness_and_exits_cleanly() {
        let database_url = std::env::var("DATABASE_URL")
            .expect("postgres lane provides DATABASE_URL for each test process");
        let redis_url = std::env::var("REDIS_URL")
            .expect("the postgres lane runs alongside Redis and exports REDIS_URL");
        let mut redis = redis::Client::open(redis_url.as_str())
            .expect("parse REDIS_URL")
            .get_connection()
            .expect("connect to the test Redis");

        let metrics_port_value = reserve_closed_port().to_string();
        let health_port = reserve_closed_port();
        let health_port_value = health_port.to_string();
        let bind_addr = format!("127.0.0.1:{}", reserve_closed_port());
        // Every incarnation binds and advertises the same mesh address, as a
        // restarted pod does with its pod IP and fixed mesh port.
        let mesh_addr = format!("127.0.0.1:{}", reserve_closed_port());
        let environment = [
            ("BUZZ_RELAY_PRIVATE_KEY", VALID_RELAY_PRIVATE_KEY),
            ("BUZZ_METRICS_PORT", metrics_port_value.as_str()),
            ("BUZZ_HEALTH_PORT", health_port_value.as_str()),
            ("BUZZ_BIND_ADDR", bind_addr.as_str()),
            ("DATABASE_URL", database_url.as_str()),
            ("REDIS_URL", redis_url.as_str()),
            ("BUZZ_GIT_CONFORMANCE_PROBE", "false"),
            ("BUZZ_MESH", "on"),
            ("BUZZ_MESH_BIND_ADDR", mesh_addr.as_str()),
            ("BUZZ_MESH_ADVERTISE_ADDR", mesh_addr.as_str()),
        ];

        let mut dead_runtime_ids: Vec<String> = Vec::new();
        for incarnation in 0..3 {
            let mut process = RelayProcess::spawn(&environment);
            let ready_after =
                wait_for_readiness(&mut process, health_port, MESH_RESTART_READY_BUDGET);
            let status = mesh_status(health_port);
            assert_eq!(status["enabled"], true, "mesh must be on: {status}");
            let runtime_id = status["local_runtime_id"]
                .as_str()
                .expect("/_mesh names the local runtime id")
                .to_string();
            assert!(
                !dead_runtime_ids.contains(&runtime_id),
                "every boot must mint a fresh runtime id"
            );
            for dead in &dead_runtime_ids {
                assert!(
                    ready_record_exists(&mut redis, dead),
                    "the killed incarnation's record must still be live for this test to mean anything"
                );
            }
            // Let at least one reconcile pass (5 s cadence) see the stale
            // records, then check none of them became a peer.
            thread::sleep(Duration::from_secs(6));
            assert!(process.try_wait().is_none(), "relay exited after readiness");
            let status = mesh_status(health_port);
            let peers = status["peers"].as_array().expect("/_mesh lists peers");
            for peer in peers {
                let peer_id = peer["runtime_id"].as_str().unwrap_or_default();
                assert!(
                    !dead_runtime_ids.iter().any(|dead| dead == peer_id),
                    "incarnation {incarnation} adopted a dead incarnation at its own address as a peer: {status}"
                );
            }
            assert!(
                ready_record_exists(&mut redis, &runtime_id),
                "a ready relay publishes its own ready record"
            );
            assert!(
                ready_after < MESH_RESTART_READY_BUDGET,
                "incarnation {incarnation} took {ready_after:?} to become ready"
            );

            if incarnation < 2 {
                // A kill with no cleanup, as when the kubelet's grace period
                // runs out: the ready record stays behind.
                drop(process.terminate());
                dead_runtime_ids.push(runtime_id);
                continue;
            }

            send_sigterm(&process);
            let output = process.wait(SIGTERM_EXIT_BUDGET);
            let logs = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                output.status.success(),
                "SIGTERM must end in a clean exit, got {}: {logs}",
                output.status
            );
            assert!(
                !ready_record_exists(&mut redis, &runtime_id),
                "SIGTERM must delete the relay's own ready record: {logs}"
            );
            assert!(
                logs.contains("mesh ready record deleted"),
                "the drain path must report the ready record delete: {logs}"
            );
        }

        // The killed incarnations' records would otherwise sit out their TTL.
        for dead in &dead_runtime_ids {
            let _: () = redis::cmd("DEL")
                .arg(format!("mesh:ready:{dead}"))
                .query(&mut redis)
                .expect("DEL a killed incarnation's ready record");
        }
    }
}

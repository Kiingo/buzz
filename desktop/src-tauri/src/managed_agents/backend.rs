use super::validate_provider_info;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

const STDERR_CAP: usize = 65536;
/// Provider responses should be small JSON objects. Cap stdout to prevent a
/// buggy or malicious provider from OOM-ing the desktop process.
const STDOUT_CAP: usize = 1_048_576; // 1 MB
/// Invoke a provider binary: write JSON to stdin, read JSON from stdout.
///
/// Reader threads stream lines/chunks over channels so the caller can receive
/// data as it arrives and time-box the wait. No `read_to_end` — if a provider
/// daemonizes or leaves descendants holding pipes open, the caller still gets
/// all data written before the child exited and returns without leaking threads
/// (the readers drop naturally when the sender is gone and the pipe closes or
/// the desktop process exits).
pub fn invoke_provider(
    binary: &Path,
    request: &serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request_bytes = format!(
        "{}\n",
        serde_json::to_string(request).map_err(|e| e.to_string())?
    );

    let mut cmd = std::process::Command::new(binary);
    if let Some(home) = super::default_agent_workdir() {
        cmd.current_dir(home);
    }
    crate::util::configure_no_window(&mut cmd);
    let mut child = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {e}", binary.display()))?;

    // Write request and close stdin immediately so the provider sees EOF.
    let stdin_result = if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(request_bytes.as_bytes())
    } else {
        Ok(())
    };

    // Stream stdout as raw chunks over a channel. The caller appends chunks
    // to a buffer and attempts incremental JSON parsing — no dependency on
    // newlines or EOF. If a descendant holds the pipe open after the provider
    // exits, the thread blocks on the next read — but the caller already has
    // the response data and proceeds. The thread is not joined; it terminates
    // when the pipe eventually closes or the process exits.
    let (stdout_tx, stdout_rx) = mpsc::channel::<Vec<u8>>();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 8192];
            let mut reader = BufReader::new(stdout);
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if stdout_tx.send(buf[..n].to_vec()).is_err() {
                            break; // receiver dropped
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Drain stderr into a bounded channel. sync_channel(8) caps in-flight
    // chunks — the producer blocks when the buffer is full, applying natural
    // backpressure. The consumer drains during the try_wait loop and caps
    // total bytes at STDERR_CAP, so memory is bounded even for long-running
    // or malicious providers.
    let (stderr_tx, stderr_rx) = mpsc::sync_channel::<Vec<u8>>(8);
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 8192];
            let mut reader = BufReader::new(stderr);
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if stderr_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Bail early if stdin write failed — child may be in a bad state.
    if let Err(e) = stdin_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("stdin write failed: {e}"));
    }

    // Poll try_wait with a deadline, collecting stdout chunks and draining
    // stderr as data arrives. Incremental JSON parsing on stdout means we
    // capture the response even without a trailing newline or EOF.
    let timeout_secs = timeout.as_secs();
    let deadline = std::time::Instant::now() + timeout;
    let mut stdout_buf = Vec::new();
    let mut stderr_bytes = Vec::new();
    let exit_status = loop {
        // Drain stdout chunks (non-blocking), enforce byte cap.
        while stdout_buf.len() < STDOUT_CAP {
            match stdout_rx.try_recv() {
                Ok(chunk) => stdout_buf.extend_from_slice(&chunk),
                Err(_) => break,
            }
        }
        // Drain stderr chunks (non-blocking), enforce byte cap.
        while stderr_bytes.len() < STDERR_CAP {
            match stderr_rx.try_recv() {
                Ok(chunk) => stderr_bytes.extend_from_slice(&chunk),
                Err(_) => break,
            }
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                break status;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("provider timed out after {timeout_secs}s"));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("wait error: {e}"));
            }
        }
    };

    // Drain remaining stdout chunks buffered between last poll and child exit.
    // Keep draining until the channel disconnects (reader finished) or the
    // 2s deadline expires (descendant holding pipe open). Do NOT break on the
    // first timeout — a slightly delayed final chunk should still be captured.
    let drain_deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        if stdout_buf.len() >= STDOUT_CAP {
            break;
        }
        let remaining = drain_deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match stdout_rx.recv_timeout(remaining.min(Duration::from_millis(100))) {
            Ok(chunk) => stdout_buf.extend_from_slice(&chunk),
            Err(mpsc::RecvTimeoutError::Disconnected) => break, // reader done
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Keep waiting until the full drain deadline expires.
                if std::time::Instant::now() >= drain_deadline {
                    break;
                }
            }
        }
    }

    // Final stderr drain (non-blocking, cap already enforced).
    while stderr_bytes.len() < STDERR_CAP {
        match stderr_rx.try_recv() {
            Ok(chunk) => stderr_bytes.extend_from_slice(&chunk),
            Err(_) => break,
        }
    }
    stderr_bytes.truncate(STDERR_CAP);
    stdout_buf.truncate(STDOUT_CAP);

    let stderr = String::from_utf8_lossy(&stderr_bytes);
    let env_secrets = env_secrets_from_request(request);
    let env_secret_refs: Vec<&str> = env_secrets.iter().map(String::as_str).collect();
    let stderr_redacted = redact_secrets_with(&stderr, &env_secret_refs);

    let exit_info = exit_status
        .code()
        .map(|c| format!("exit code {c}"))
        .unwrap_or_else(|| "killed by signal".to_string());

    // Fail on non-zero exit regardless of stdout content. A provider that
    // crashes mid-deploy may flush partial JSON before dying — trusting that
    // output would be worse than surfacing the failure.
    let exited_ok = exit_status.success();
    if !exited_ok {
        let stderr_snippet = &stderr_redacted[..stderr_redacted.len().min(4096)];
        if stderr_snippet.is_empty() {
            return Err(format!("provider failed ({exit_info}, empty stderr)"));
        } else {
            return Err(format!(
                "provider failed ({exit_info}). stderr: {stderr_snippet}"
            ));
        }
    }

    // Incremental JSON parse: try each line, then try the entire buffer.
    // Handles providers that emit JSON on a single line (common) as well as
    // providers that write JSON without a trailing newline.
    let stdout_str = String::from_utf8_lossy(&stdout_buf);
    let response: serde_json::Value = stdout_str
        .lines()
        .find_map(|line| serde_json::from_str(line).ok())
        .or_else(|| serde_json::from_str(stdout_str.trim()).ok())
        .ok_or_else(|| {
            let stderr_snippet = &stderr_redacted[..stderr_redacted.len().min(4096)];
            if stderr_snippet.is_empty() {
                format!("provider produced no JSON response ({exit_info}, empty stderr)")
            } else {
                format!(
                    "provider produced no JSON response ({exit_info}). stderr: {stderr_snippet}"
                )
            }
        })?;

    if response.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let error = provider_error_text(response.get("error"))?;
        return Err(redact_secrets_with(&error, &env_secret_refs));
    }

    Ok(response)
}

fn provider_error_text(error: Option<&serde_json::Value>) -> Result<String, String> {
    let Some(error) = error else {
        return Ok("Provider request failed".to_string());
    };
    if let Some(value) = error.as_str() {
        return Ok(value.chars().take(1_000).collect());
    }
    let object = error
        .as_object()
        .ok_or_else(|| "provider error must be a string or structured error object".to_string())?;
    const FIELDS: &[&str] = &["code", "message", "remediation_url", "correlation_id"];
    if object.keys().any(|field| !FIELDS.contains(&field.as_str())) {
        return Err("provider structured error contains an unknown field".into());
    }
    let code = object
        .get("code")
        .and_then(serde_json::Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 160
                && value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || "_-".contains(character))
        })
        .ok_or_else(|| "provider structured error code is invalid".to_string())?;
    let message = object
        .get("message")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 1_000)
        .unwrap_or(code);
    let mut parts = vec![message.to_string()];
    if let Some(remediation) = object
        .get("remediation_url")
        .and_then(serde_json::Value::as_str)
    {
        let parsed = url::Url::parse(remediation)
            .map_err(|_| "provider structured error remediation_url is invalid".to_string())?;
        if parsed.scheme() != "https" || remediation.len() > 2_048 {
            return Err("provider structured error remediation_url is invalid".into());
        }
        parts.push(format!("Open: {remediation}"));
    }
    if let Some(correlation) = object
        .get("correlation_id")
        .and_then(serde_json::Value::as_str)
    {
        if correlation.is_empty()
            || correlation.len() > 160
            || !correlation
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "_-".contains(character))
        {
            return Err("provider structured error correlation_id is invalid".into());
        }
        parts.push(format!("Support ID: {correlation}"));
    }
    Ok(parts.join(" "))
}

/// Split a config key into lowercase words on `_`, `-`, `.`, and camelCase boundaries.
///
/// Handles acronyms: consecutive uppercase runs stay together until a lowercase follows.
/// "apiKey" → ["api", "key"], "apiKEY" → ["api", "key"], "APIKey" → ["api", "key"],
/// "access_token" → ["access", "token"], "keyboard" → ["keyboard"],
/// "clientSecret" → ["client", "secret"].
fn split_config_key(key: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = key.chars().collect();
    for (i, &ch) in chars.iter().enumerate() {
        if ch == '_' || ch == '-' || ch == '.' {
            if !current.is_empty() {
                words.push(current.to_lowercase());
                current.clear();
            }
        } else if ch.is_uppercase() {
            // Start a new word on: (a) transition from lowercase to uppercase, or
            // (b) uppercase followed by lowercase (end of acronym run, e.g. "APIKey" → "API" + "Key").
            let prev_lower =
                !current.is_empty() && current.chars().last().is_some_and(|c| c.is_lowercase());
            let acronym_end = !current.is_empty()
                && current.chars().last().is_some_and(|c| c.is_uppercase())
                && chars.get(i + 1).is_some_and(|c| c.is_lowercase());
            if prev_lower || acronym_end {
                words.push(current.to_lowercase());
                current.clear();
            }
            current.push(ch);
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        words.push(current.to_lowercase());
    }
    words
}

#[cfg(test)]
fn redact_secrets(s: &str) -> String {
    redact_secrets_with(s, &[])
}

/// Like the (test-only) prefix-only `redact_secrets`, but also redacts
/// every occurrence of each
/// `extras` entry verbatim. Used to scrub user-supplied env values out of
/// provider stderr/JSON-error text — providers may echo their request
/// back in failure messages, and persona/agent `env_vars` may carry API
/// keys that the desktop just persisted via `last_error`.
///
/// Entries shorter than 4 chars are skipped: too noisy to scrub blindly
/// (would match every short token in normal log output). Entries are
/// applied in decreasing length order so superstrings get scrubbed before
/// substrings — protects against partial overlap leaks.
pub(crate) fn redact_secrets_with(s: &str, extras: &[&str]) -> String {
    let mut result = s.to_string();

    // Extras: longest first to avoid partial-overlap leaks. We use
    // `str::replace` (single-pass, non-overlapping) instead of a `find` +
    // `replace_range` loop — the loop variant would never terminate if a
    // user-supplied env value happened to be a substring of the
    // replacement marker (e.g. value="REDACTED" or "EDACTE").
    let mut sorted: Vec<&str> = extras.iter().copied().filter(|v| v.len() >= 4).collect();
    sorted.sort_by_key(|v| std::cmp::Reverse(v.len()));
    sorted.dedup();
    for value in sorted {
        if !value.is_empty() {
            result = result.replace(value, "[REDACTED]");
        }
    }

    // Then prefix-based scrubbing. This loop *can* re-scan because each
    // replacement shortens the buffer past the matched prefix — the
    // replacement marker `[REDACTED]` contains none of these prefixes, so
    // progress is guaranteed. Any prefix added here must preserve that.
    //
    // GitHub tokens are recognised by shape as well as by variable name: a
    // token reaches output from outside our environment too — embedded in a
    // git remote URL an installer echoes, say — where no name-based rule can
    // see it.
    for prefix in &[
        "nsec1",
        "sprt_tok_",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
    ] {
        while let Some(pos) = result.find(prefix) {
            let end = result[pos..]
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
                .map(|i| pos + i)
                .unwrap_or(result.len());
            result.replace_range(pos..end, "[REDACTED]");
        }
    }
    result
}

/// Collect string values from every environment map a deploy request can
/// carry. Providers may echo any of these values in diagnostics, including
/// definition/baked values that exist only in the resolved launch block.
fn env_secrets_from_request(request: &serde_json::Value) -> Vec<String> {
    let agent = request.get("agent");
    let maps = [
        agent.and_then(|value| value.get("env_vars")),
        agent
            .and_then(|value| value.get("launch"))
            .and_then(|value| value.get("env")),
        agent
            .and_then(|value| value.get("launch"))
            .and_then(|value| value.get("policy_env")),
    ];

    maps.into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_object)
        .flat_map(|map| map.values())
        .filter_map(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(String::from)
        .collect()
}

/// Public-in-crate helper: redact every non-empty value from `env` (plus
/// the standard nsec/sprt_tok prefix scrubbing) out of `s`. Used by
/// callers that already have a flat env map handy — e.g. model discovery
/// formatting child stderr into a frontend-visible error.
pub(crate) fn redact_env_values_in(
    s: &str,
    env: &std::collections::BTreeMap<String, String>,
) -> String {
    let values: Vec<&str> = env
        .values()
        .filter(|v| !v.is_empty())
        .map(String::as_str)
        .collect();
    redact_secrets_with(s, &values)
}

/// Copy a resolved provider into a private staging directory while hashing
/// exactly the bytes copied. The staged file becomes non-writable before either
/// invocation, closing the path replacement and in-place rewrite races.
fn stage_provider(
    binary: &Path,
) -> Result<(tempfile::TempDir, PathBuf, String, std::fs::File), String> {
    let directory = tempfile::Builder::new()
        .prefix("buzz-provider-")
        .tempdir()
        .map_err(|error| format!("failed to create provider staging directory: {error}"))?;
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let staged_path = directory.path().join(format!("provider{suffix}"));
    let mut source = std::fs::File::open(binary)
        .map_err(|error| format!("failed to open provider for staging: {error}"))?;
    let mut staged = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staged_path)
        .map_err(|error| format!("failed to create staged provider: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = source
            .read(&mut buffer)
            .map_err(|error| format!("failed to read provider for staging: {error}"))?;
        if count == 0 {
            break;
        }
        staged
            .write_all(&buffer[..count])
            .map_err(|error| format!("failed to write staged provider: {error}"))?;
        hasher.update(&buffer[..count]);
    }
    staged
        .sync_all()
        .map_err(|error| format!("failed to sync staged provider: {error}"))?;

    let mut permissions = staged
        .metadata()
        .map_err(|error| format!("failed to inspect staged provider: {error}"))?
        .permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o500);
    }
    #[cfg(not(unix))]
    permissions.set_readonly(true);
    std::fs::set_permissions(&staged_path, permissions)
        .map_err(|error| format!("failed to protect staged provider: {error}"))?;
    drop(staged);
    verify_provider_platform_signature(&staged_path)?;

    #[cfg(windows)]
    let execution_guard = {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            // Permit CreateProcess to read the image while denying replacement,
            // writes, and deletion until both invocations finish.
            .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
            .open(&staged_path)
    };
    #[cfg(not(windows))]
    let execution_guard = std::fs::File::open(&staged_path);
    let execution_guard = execution_guard
        .map_err(|error| format!("failed to lock staged provider for execution: {error}"))?;
    Ok((
        directory,
        staged_path,
        hex::encode(hasher.finalize()),
        execution_guard,
    ))
}

#[cfg(windows)]
fn verify_provider_platform_signature(binary: &Path) -> Result<(), String> {
    let configured = option_env!("BUZZ_TRUSTED_PROVIDER_SIGNER_SUBJECTS").unwrap_or("");
    let expected: Vec<_> = configured
        .split(';')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect();
    if expected.is_empty() {
        return Ok(());
    }
    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .ok_or_else(|| {
            "Windows system root is unavailable for provider verification".to_string()
        })?;
    let powershell = system_root
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let script = r#"$signature = Get-AuthenticodeSignature -LiteralPath $env:BUZZ_PROVIDER_SIGNATURE_TARGET; if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { exit 41 }; [Console]::Out.Write($signature.SignerCertificate.Subject)"#;
    let output = std::process::Command::new(powershell)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .env("BUZZ_PROVIDER_SIGNATURE_TARGET", binary)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|error| format!("provider signature verification failed to run: {error}"))?;
    if !output.status.success() {
        return Err("provider has no valid trusted Authenticode signature".to_string());
    }
    let subject = String::from_utf8(output.stdout)
        .map_err(|_| "provider signer subject is not valid UTF-8".to_string())?;
    let subject = subject.trim();
    if !expected
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(subject))
    {
        return Err("provider Authenticode signer is not approved by this Buzz build".to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn verify_provider_platform_signature(_binary: &Path) -> Result<(), String> {
    Ok(())
}

fn provider_state_string<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    field: &str,
    max_len: usize,
) -> Result<&'a str, String> {
    object
        .get(field)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= max_len)
        .ok_or_else(|| format!("provider lifecycle state has invalid {field}"))
}

fn provider_state_optional_timestamp(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<Option<String>, String> {
    let Some(value) = object.get(field) else {
        return Err(format!("provider lifecycle state missing {field}"));
    };
    if value.is_null() {
        return Ok(None);
    }
    let timestamp = value
        .as_str()
        .filter(|value| value.len() <= 64)
        .ok_or_else(|| format!("provider lifecycle state has invalid {field}"))?;
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .map_err(|_| format!("provider lifecycle state has invalid {field}"))?;
    Ok(Some(timestamp.to_string()))
}

/// Parse the protocol-v2 lifecycle envelope into a bounded, non-secret cache.
///
/// Providers may return a richer profile object, but Buzz persists only these
/// generic control-plane fields. Unknown fields are rejected so a provider
/// cannot smuggle credentials or arbitrary data into managed-agents.json.
pub(crate) fn parse_provider_lifecycle_state(
    response: &serde_json::Value,
) -> Result<super::ProviderLifecycleState, String> {
    let state = response
        .get("state")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "provider response missing lifecycle state".to_string())?;
    const FIELDS: &[&str] = &[
        "contract_version",
        "provider_agent_id",
        "agent_public_key",
        "profile",
        "desired_state",
        "observed_state",
        "last_reconciled_at",
        "last_ready_at",
        "error_code",
        "correlation_id",
    ];
    if let Some(field) = state.keys().find(|field| !FIELDS.contains(&field.as_str())) {
        return Err(format!(
            "provider lifecycle state contains unknown field {field}"
        ));
    }
    if state
        .get("contract_version")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
    {
        return Err("provider lifecycle state has unsupported contract_version".into());
    }
    let desired_state = provider_state_string(state, "desired_state", 32)?;
    if !matches!(desired_state, "active" | "paused" | "deleted") {
        return Err("provider lifecycle desired_state is unsupported".into());
    }
    let observed_state = provider_state_string(state, "observed_state", 32)?;
    if !matches!(
        observed_state,
        "provisioning"
            | "ready"
            | "updating"
            | "paused"
            | "action_required"
            | "degraded"
            | "deletion_pending"
            | "deleted"
    ) {
        return Err("provider lifecycle observed_state is unsupported".into());
    }
    let error_code = match state.get("error_code") {
        Some(value) if value.is_null() => None,
        Some(value) => {
            let value = value
                .as_str()
                .filter(|value| {
                    !value.is_empty()
                        && value.len() <= 160
                        && value.chars().all(|character| {
                            character.is_ascii_alphanumeric() || "_-".contains(character)
                        })
                })
                .ok_or_else(|| "provider lifecycle error_code is invalid".to_string())?;
            Some(value.to_string())
        }
        None => return Err("provider lifecycle state missing error_code".into()),
    };
    let correlation_id = provider_state_string(state, "correlation_id", 160)?;
    if !correlation_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "_-".contains(character))
    {
        return Err("provider lifecycle correlation_id is invalid".into());
    }
    Ok(super::ProviderLifecycleState {
        desired_state: desired_state.to_string(),
        observed_state: observed_state.to_string(),
        last_reconciled_at: provider_state_optional_timestamp(state, "last_reconciled_at")?,
        last_ready_at: provider_state_optional_timestamp(state, "last_ready_at")?,
        error_code,
        correlation_id: correlation_id.to_string(),
    })
}

/// Deploy through one immutable staged copy: negotiate protocol v1 before the
/// secret-bearing request, then invoke deploy on those exact same bytes.
pub fn provider_deploy(
    binary: &Path,
    agent: &serde_json::Value,
    provider_config: &serde_json::Value,
    owner_proof: Option<&serde_json::Value>,
) -> Result<(String, Option<super::ProviderLifecycleState>), String> {
    let (_directory, staged, _digest, _execution_guard) = stage_provider(binary)?;
    let info_request = serde_json::json!({
        "op": "info",
        "request_id": uuid::Uuid::new_v4().to_string(),
    });
    let info = invoke_provider(&staged, &info_request, Duration::from_secs(10))?;
    let version = validate_provider_info(&info)?;
    let owns_execution_profile = version == 2
        && info
            .pointer("/capabilities/owns_execution_profile")
            .and_then(serde_json::Value::as_bool)
            == Some(true);
    let mut agent = agent.clone();
    if owns_execution_profile {
        let proof = owner_proof
            .ok_or_else(|| "provider v2 requires an owner-signed deployment proof".to_string())?;
        agent
            .as_object_mut()
            .ok_or_else(|| "agent deploy payload must be an object".to_string())?
            .insert("owner_proof".to_string(), proof.clone());
    }

    let request = serde_json::json!({
        "op": "deploy",
        "request_id": uuid::Uuid::new_v4().to_string(),
        "agent": agent,
        "provider_config": provider_config,
    });
    let resp = invoke_provider(&staged, &request, Duration::from_secs(600))?;
    let agent_id = resp["agent_id"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| "deploy response missing agent_id".to_string())?;
    let lifecycle_state = if version == 2 && owns_execution_profile {
        Some(parse_provider_lifecycle_state(&resp)?)
    } else {
        resp.get("state")
            .map(|_| parse_provider_lifecycle_state(&resp))
            .transpose()?
    };
    Ok((agent_id, lifecycle_state))
}

/// Invoke a protocol-v2 lifecycle operation through the same immutable staging
/// and strict negotiation boundary as deploy.
pub fn provider_control(
    binary: &Path,
    operation: &str,
    agent_id: &str,
    expected_profile_revision: u64,
    owner_proof: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    const OPERATIONS: &[&str] = &["status", "pause", "resume", "delete", "reconcile"];
    if !OPERATIONS.contains(&operation) {
        return Err(format!(
            "unsupported provider lifecycle operation {operation}"
        ));
    }
    let (_directory, staged, _digest, _execution_guard) = stage_provider(binary)?;
    let info = invoke_provider(
        &staged,
        &serde_json::json!({
            "op": "info",
            "request_id": uuid::Uuid::new_v4().to_string(),
        }),
        Duration::from_secs(10),
    )?;
    let version = validate_provider_info(&info)?;
    if version != 2 {
        return Err("provider lifecycle requires protocol version 2".to_string());
    }
    let advertised = info
        .pointer("/capabilities/lifecycle_operations")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|operations| {
            operations
                .iter()
                .any(|candidate| candidate.as_str() == Some(operation))
        });
    if !advertised {
        return Err(format!(
            "provider does not advertise lifecycle operation {operation}"
        ));
    }
    let response = invoke_provider(
        &staged,
        &serde_json::json!({
            "op": operation,
            "request_id": uuid::Uuid::new_v4().to_string(),
            "agent_id": agent_id,
            "expected_profile_revision": expected_profile_revision,
            "owner_proof": owner_proof,
        }),
        Duration::from_secs(30),
    )?;
    if response.get("ok") != Some(&serde_json::Value::Bool(true)) {
        return Err(response
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("provider lifecycle operation failed")
            .to_string());
    }
    Ok(response)
}

/// Validate provider_config: flat object, scalar values, no secret-like keys.
pub fn validate_provider_config(config: &serde_json::Value) -> Result<(), String> {
    let obj = config
        .as_object()
        .ok_or("provider_config must be a JSON object")?;
    if obj.len() > 20 {
        return Err("provider_config: max 20 fields".to_string());
    }
    let json_str = serde_json::to_string(config).unwrap_or_default();
    if json_str.len() > 65536 {
        return Err("provider_config: max 64KB".to_string());
    }
    // Split on separators AND camelCase boundaries, then check each word.
    // Catches: api_key, apiKey, access-token, clientSecret, etc.
    // Allows: keyboard, monkey_wrench (no forbidden word as a segment).
    let forbidden = ["secret", "password", "token", "key", "credential"];
    for (k, v) in obj {
        let words = split_config_key(k);
        for f in &forbidden {
            if words.iter().any(|w| w == f) {
                return Err(format!("provider_config: key '{}' looks like a secret", k));
            }
        }
        if v.is_object() || v.is_array() {
            return Err(format!(
                "provider_config: value for '{}' must be a scalar",
                k
            ));
        }
    }
    Ok(())
}

/// Derive a provider id from the filename Tauri stages at runtime. Tauri
/// removes its target-triple suffix while copying an external binary, but on
/// Windows leaves the executable/script extension, which is not part of the
/// provider id.
fn provider_id_from_filename(name: &str) -> Option<&str> {
    let raw = name.strip_prefix("buzz-backend-")?;
    let id = [".exe", ".bat", ".cmd"]
        .into_iter()
        .find_map(|extension| {
            raw.get(raw.len().saturating_sub(extension.len())..)
                .filter(|suffix| suffix.eq_ignore_ascii_case(extension))
                .map(|_| &raw[..raw.len() - extension.len()])
        })
        .unwrap_or(raw);

    (!id.is_empty()).then_some(id)
}

/// Enumerate PATH for buzz-backend-* executables. Returns (id, path) pairs.
/// Only includes files that are executable. Does NOT execute any binaries.
///
/// On macOS, GUI apps inherit a minimal PATH from launchd (`/usr/bin:/bin:/usr/sbin:/sbin`)
/// which excludes both the app bundle's `Contents/MacOS/` dir and `~/.local/bin`.
/// We augment the search with those directories so bundled and user-installed providers
/// are always discovered regardless of how the desktop was launched.
pub fn discover_provider_candidates() -> Vec<(String, PathBuf)> {
    let prefix = "buzz-backend-";
    let mut seen = std::collections::HashSet::new();
    let mut results = Vec::new();

    let path_var = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&path_var).collect();

    // Prepend the exe parent dir (Contents/MacOS/ in a .app bundle) so bundled
    // providers are found even when the process PATH is minimal.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let parent_buf = parent.to_path_buf();
            if !dirs.contains(&parent_buf) {
                dirs.insert(0, parent_buf);
            }
        }
    }

    // Also include ~/.local/bin — the conventional location for user-installed
    // provider binaries (symlinks created by install scripts).
    if let Some(home) = dirs::home_dir() {
        let local_bin = home.join(".local").join("bin");
        if !dirs.contains(&local_bin) {
            dirs.push(local_bin);
        }
    }

    // Companion installers can place provider executables in a stable,
    // user-scoped directory without mutating PATH or the built-in runtime list.
    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let provider_dir = PathBuf::from(local_app_data).join("Buzz").join("providers");
        if !dirs.contains(&provider_dir) {
            dirs.insert(0, provider_dir);
        }
    }

    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(prefix) {
                if let Some(id) = provider_id_from_filename(&name) {
                    if !seen.contains(&name) && is_executable(&entry.path()) {
                        seen.insert(name.clone());
                        results.push((id.to_string(), entry.path()));
                    }
                }
            }
        }
    }
    results
}

/// Resolve a provider ID to a discovered, executable binary path.
///
/// This is the ONLY way to resolve provider binaries for execution. It:
/// 1. Validates the ID against `^[a-z0-9][a-z0-9_-]*$` (no path traversal)
/// 2. Looks up the ID in `discover_provider_candidates()` (PATH-discovered only)
/// 3. Returns the canonical path of the discovered binary
///
/// All deploy, start, and create paths MUST use this instead of raw
/// `resolve_command(format!("buzz-backend-{id}"))` to prevent a compromised
/// frontend/IPC caller from steering execution to an arbitrary binary.
pub fn resolve_provider_binary(provider_id: &str) -> Result<PathBuf, String> {
    // Reject IDs that could be path components or shell metacharacters.
    let valid_id = provider_id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
        && !provider_id.is_empty()
        && provider_id.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit());
    if !valid_id {
        return Err(format!(
            "invalid provider ID '{provider_id}': must match [a-z0-9][a-z0-9_-]*"
        ));
    }

    let candidates = discover_provider_candidates();
    let found = candidates
        .into_iter()
        .find(|(id, _)| id == provider_id)
        .map(|(_, path)| path);

    match found {
        Some(path) => path
            .canonicalize()
            .map_err(|e| format!("provider binary not accessible: {e}")),
        None => Err(format!(
            "provider 'buzz-backend-{provider_id}' not found on PATH"
        )),
    }
}

/// Check if a file is executable (Unix: mode bits; other platforms: always true).
fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        true
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendProviderInfo {
    pub id: String,
    pub binary_path: String,
}

#[cfg(test)]
#[path = "backend_tests.rs"]
mod tests;

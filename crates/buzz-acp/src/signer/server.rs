//! The socket. One per listener, in a new 0700 directory, gone with the process.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use buzz_signer::{Op, Output, Reply, Request, MAX_FRAME_BYTES, SOCKET_ENV, TOKEN_ENV};
use subtle::ConstantTimeEq as _;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{UnixListener, UnixStream};
use zeroize::Zeroizing;

use super::ops::Signer;

/// A client that stops mid-frame is dropped rather than held open.
const FRAME_READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Refusals for a `created_at` ahead of the window. A replaceable head far in
/// the future shows up here, so its rate is worth seeing.
static AHEAD_OF_WINDOW: AtomicU64 = AtomicU64::new(0);

/// Holds the socket's lifetime. Dropping it stops the listener and removes the
/// directory.
pub(crate) struct SignerServer {
    socket: PathBuf,
    token: Zeroizing<String>,
    task: tokio::task::JoinHandle<()>,
    _dir: tempfile::TempDir,
}

impl std::fmt::Debug for SignerServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignerServer")
            .field("socket", &self.socket)
            .finish_non_exhaustive()
    }
}

impl Drop for SignerServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl SignerServer {
    /// Starts listening. Must run inside a Tokio runtime.
    pub(crate) fn start(signer: Signer) -> anyhow::Result<Self> {
        let dir = tempfile::Builder::new().prefix("buzz-signer-").tempdir()?;
        restrict_to_owner(dir.path())?;
        let socket = dir.path().join("signer.sock");
        let listener = UnixListener::bind(&socket)?;
        let bytes: [u8; 32] = rand::random();
        let token = Zeroizing::new(hex::encode(bytes));
        let task = tokio::spawn(accept_loop(listener, Arc::new(signer), token.clone()));
        Ok(Self {
            socket,
            token,
            task,
            _dir: dir,
        })
    }

    /// What a child gets in place of the key.
    pub(crate) fn child_env(&self) -> [(String, String); 2] {
        [
            (SOCKET_ENV.to_string(), self.socket.display().to_string()),
            (TOKEN_ENV.to_string(), self.token.to_string()),
        ]
    }
}

#[cfg(unix)]
fn restrict_to_owner(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

async fn accept_loop(listener: UnixListener, signer: Arc<Signer>, token: Zeroizing<String>) {
    let token = Arc::new(token);
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let signer = Arc::clone(&signer);
                let token = Arc::clone(&token);
                tokio::spawn(async move {
                    serve(stream, &signer, token.as_bytes()).await;
                });
            }
            Err(error) => {
                tracing::warn!(target: "buzz_signer", kind = ?error.kind(), "signer accept failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

enum Frame {
    Request(Box<Request>),
    Refused(&'static str),
    Closed,
}

async fn read_request(stream: &mut UnixStream) -> Frame {
    let mut prefix = [0u8; 4];
    if stream.read_exact(&mut prefix).await.is_err() {
        return Frame::Closed;
    }
    let len = u32::from_be_bytes(prefix);
    if len > MAX_FRAME_BYTES {
        return Frame::Refused("signer_frame_too_large");
    }
    let mut body = vec![0u8; len as usize];
    if stream.read_exact(&mut body).await.is_err() {
        return Frame::Closed;
    }
    match serde_json::from_slice(&body) {
        Ok(request) => Frame::Request(Box::new(request)),
        Err(_) => Frame::Refused("signer_request_invalid"),
    }
}

async fn write_reply(stream: &mut UnixStream, reply: &Reply) -> bool {
    let Ok(body) = serde_json::to_vec(reply) else {
        return false;
    };
    let Ok(len) = u32::try_from(body.len()) else {
        return false;
    };
    stream.write_all(&len.to_be_bytes()).await.is_ok()
        && stream.write_all(&body).await.is_ok()
        && stream.flush().await.is_ok()
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// `op` and `kind` for the log. Never content, tags or anything else a caller
/// sent.
fn op_facts(op: &Op) -> (&'static str, Option<u16>) {
    match op {
        Op::Pubkey => ("pubkey", None),
        Op::SignEvent { kind, .. } => ("sign_event", Some(*kind)),
        Op::Nip98 { .. } => ("nip98", None),
        Op::BlossomGet { .. } => ("blossom_get", None),
        Op::BlossomUpload { .. } => ("blossom_upload", None),
        Op::RelayAuth { .. } => ("relay_auth", None),
        Op::MemDTag { .. } => ("mem_d_tag", None),
        Op::MemWrite { .. } => ("mem_write", None),
        Op::MemRead { .. } => ("mem_read", None),
        Op::ObserverEncrypt { .. } => ("observer_encrypt", None),
        Op::GitSign { .. } => ("git_sign", None),
    }
}

/// Whether a refused `created_at` sat ahead of the window, not behind it.
fn is_ahead(op: &Op, now: u64) -> bool {
    let requested = match op {
        Op::SignEvent { created_at, .. } | Op::MemWrite { created_at, .. } => *created_at,
        _ => None,
    };
    requested.is_some_and(|value| value > now)
}

/// Checks the token, runs the op and logs the outcome. Refusals log too.
pub(super) fn answer(signer: &Signer, expected: &[u8], request: Request, now: u64) -> Reply {
    let (op, kind) = op_facts(&request.op);
    if !bool::from(request.token.as_bytes().ct_eq(expected)) {
        log_request(signer, "token", None, "signer_token_refused");
        return Reply::Refused("signer_token_refused".into());
    }
    let ahead = is_ahead(&request.op, now);
    let result: Result<Output, _> = signer.handle(request.op, now);
    match result {
        Ok(output) => {
            log_request(signer, op, kind, "ok");
            Reply::Ok(output)
        }
        Err(code) => {
            if ahead && code == "signer_created_at_out_of_window" {
                let count = AHEAD_OF_WINDOW.fetch_add(1, Ordering::Relaxed) + 1;
                tracing::warn!(
                    target: "buzz_signer",
                    event = "buzz_signer_ahead_of_window",
                    count,
                    "created_at refused ahead of the window"
                );
            }
            log_request(signer, op, kind, code);
            Reply::Refused(code.into())
        }
    }
}

fn log_request(signer: &Signer, op: &str, kind: Option<u16>, outcome: &str) {
    tracing::info!(
        target: "buzz_signer",
        event = "buzz_signer_request",
        op,
        kind,
        outcome,
        agent = %signer.agent_hex(),
        "signer request"
    );
}

async fn serve(mut stream: UnixStream, signer: &Signer, expected: &[u8]) {
    loop {
        let frame = tokio::time::timeout(FRAME_READ_TIMEOUT, read_request(&mut stream)).await;
        let reply = match frame {
            Err(_) | Ok(Frame::Closed) => return,
            Ok(Frame::Refused(code)) => {
                log_request(signer, "frame", None, code);
                let _ = write_reply(&mut stream, &Reply::Refused(code.into())).await;
                return;
            }
            Ok(Frame::Request(request)) => answer(signer, expected, *request, unix_now()),
        };
        let refused_token =
            matches!(&reply, Reply::Refused(code) if code == "signer_token_refused");
        if !write_reply(&mut stream, &reply).await || refused_token {
            return;
        }
    }
}

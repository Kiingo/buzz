use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use crate::protocol::{read_frame, write_frame, FrameError, Op, Output, Reply, Request};
use crate::{SOCKET_ENV, TOKEN_ENV};

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    /// The signer refused. The code is stable and safe to show.
    #[error("signer refused: {0}")]
    Refused(String),
    #[error("signer socket: {0}")]
    Connect(#[source] std::io::Error),
    #[error(transparent)]
    Frame(#[from] FrameError),
    #[error("signer returned an unexpected reply")]
    UnexpectedReply,
}

/// A connection-per-call client. It holds the token, so its `Debug` is written
/// by hand and never prints it.
#[derive(Clone)]
pub struct Client {
    socket: PathBuf,
    token: String,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("socket", &self.socket)
            .finish_non_exhaustive()
    }
}

impl Client {
    pub fn new(socket: impl Into<PathBuf>, token: impl Into<String>) -> Self {
        Self {
            socket: socket.into(),
            token: token.into(),
        }
    }

    /// The client this process was given, if any.
    pub fn from_env() -> Option<Self> {
        let socket = std::env::var_os(SOCKET_ENV).filter(|value| !value.is_empty())?;
        let token = std::env::var(TOKEN_ENV).ok().filter(|v| !v.is_empty())?;
        Some(Self::new(socket, token))
    }

    /// Sends one op. A refusal comes back as [`ClientError::Refused`].
    pub fn call(&self, op: Op) -> Result<Output, ClientError> {
        let mut stream = UnixStream::connect(&self.socket).map_err(ClientError::Connect)?;
        write_frame(
            &mut stream,
            &Request {
                token: self.token.clone(),
                op,
            },
        )?;
        match read_frame(&mut stream)? {
            Reply::Ok(output) => Ok(output),
            Reply::Refused(code) => Err(ClientError::Refused(code)),
        }
    }

    pub fn pubkey(&self) -> Result<String, ClientError> {
        match self.call(Op::Pubkey)? {
            Output::Pubkey(value) => Ok(value),
            _ => Err(ClientError::UnexpectedReply),
        }
    }

    /// For the ops that answer with a signed event as JSON.
    pub fn event(&self, op: Op) -> Result<String, ClientError> {
        match self.call(op)? {
            Output::Event(value) => Ok(value),
            _ => Err(ClientError::UnexpectedReply),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_output_never_shows_the_token() {
        let printed = format!("{:?}", Client::new("/run/s.sock", "sekrit-token"));
        assert!(!printed.contains("sekrit-token"), "{printed}");
    }
}

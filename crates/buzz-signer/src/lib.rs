//! Wire format and blocking client for the buzz-acp signer socket.
//!
//! buzz-acp keeps the agent key and answers these requests over a Unix socket.
//! Children get [`SOCKET_ENV`] and [`TOKEN_ENV`] in place of the key. No
//! request carries an id, a digest or a pubkey, so the signer always works out
//! what it signs. See `crates/buzz-acp/src/signer` for the server and its
//! policy.
//!
//! The stated limit: a compromised child can sign as its agent while it runs.
//! This protects the key from theft and stops lasting impersonation, not misuse
//! during the child's life.

mod client;
mod protocol;

pub use client::{Client, ClientError};
pub use protocol::{
    read_frame, write_frame, FrameError, GitSignature, Op, Output, Reply, Request, MAX_FRAME_BYTES,
    SOCKET_ENV, TOKEN_ENV,
};

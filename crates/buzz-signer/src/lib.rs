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

use sha2::{Digest as _, Sha256};

pub use client::{Client, ClientError};
pub use protocol::{
    read_frame, write_frame, FrameError, GitSignature, Op, Output, Reply, Request, MAX_FRAME_BYTES,
    SOCKET_ENV, TOKEN_ENV,
};

/// Labels the GIF customer id hash, so it can never equal a hash of the key
/// made for any other purpose.
const GIF_CUSTOMER_ID_DOMAIN: &[u8] = b"buzz-gif-customer-id-v1";

/// The id a GIF provider sees for this key on this relay: 16 bytes of a
/// domain-separated SHA-256, in hex. Stable, and tells it nothing about the key.
pub fn gif_customer_id(secret_key: &[u8], relay_url: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(GIF_CUSTOMER_ID_DOMAIN);
    hasher.update(b"\0");
    hasher.update(secret_key);
    hasher.update(b"\0");
    hasher.update(relay_url.as_bytes());
    hex::encode(&hasher.finalize()[..16])
}

#[cfg(test)]
mod tests {
    use super::gif_customer_id;
    use sha2::{Digest as _, Sha256};

    #[test]
    fn the_gif_id_is_domain_separated_from_a_plain_hash_of_the_key() {
        let key = [0xab_u8; 32];
        let relay = "wss://relay.example";
        let mut plain = Sha256::new();
        plain.update(key);
        plain.update(b"\0");
        plain.update(relay.as_bytes());
        assert_ne!(
            gif_customer_id(&key, relay),
            hex::encode(&plain.finalize()[..16])
        );
    }

    #[test]
    fn the_gif_id_depends_on_key_and_relay() {
        let id = gif_customer_id(&[1; 32], "wss://a.example");
        assert_eq!(id.len(), 32);
        assert_eq!(id, gif_customer_id(&[1; 32], "wss://a.example"));
        assert_ne!(id, gif_customer_id(&[2; 32], "wss://a.example"));
        assert_ne!(id, gif_customer_id(&[1; 32], "wss://b.example"));
    }
}

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

/// Env var naming the signer's Unix socket.
pub const SOCKET_ENV: &str = "BUZZ_SIGNER_SOCKET";
/// Env var holding this buzz-acp start's token. Never put it in argv.
pub const TOKEN_ENV: &str = "BUZZ_SIGNER_TOKEN";

/// Transport limit on one frame. It bounds the socket and sits well above the
/// relay's largest event; it is not a cap on people's text.
pub const MAX_FRAME_BYTES: u32 = 16 * 1024 * 1024;

/// One request. `deny_unknown_fields` is load-bearing here and on [`Op`]: a
/// caller can't add an id, a digest or a pubkey to any op.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub token: String,
    pub op: Op,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Op {
    /// The agent's pubkey.
    Pubkey,
    /// Sign a Nostr event as the agent. The signer computes the id.
    SignEvent {
        kind: u16,
        content: String,
        tags: Vec<Vec<String>>,
        created_at: Option<u64>,
    },
    /// Build and sign a NIP-98 event for an allowed origin.
    Nip98 {
        url: String,
        method: String,
        payload_hash: Option<String>,
        /// Git auth carries the NIP-OA tag in the event. The CLI sends it in a
        /// header instead.
        owner_tag: bool,
    },
    /// Build and sign a Blossom `get` event for a media URL.
    BlossomGet { media_url: String },
    /// Build and sign a Blossom `upload` event for an allowed origin.
    BlossomUpload { sha256: String, url: String },
    /// Build and sign a NIP-42 event for the configured relay.
    RelayAuth { challenge: String },
    /// The `d` tag for a memory slug. The conversation key never leaves.
    MemDTag { slug: String },
    /// Encrypt an engram body to the owner and sign it.
    MemWrite {
        body_json: String,
        created_at: Option<u64>,
    },
    /// Verify an engram and return its decrypted body.
    MemRead { event_json: String },
    /// Encrypt an observer payload to the owner.
    ObserverEncrypt { payload: String },
    /// Sign a git object. The signer supplies the domain prefix, `t` and `oa`.
    GitSign { payload_b64: String },
    /// The stable GIF customer id for this agent and relay. It's derived from
    /// the key, so only the signer can compute it.
    GifCustomerId,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    Ok(Output),
    /// A stable refusal code. Never carries caller content.
    Refused(String),
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Output {
    Pubkey(String),
    Event(String),
    DTag(String),
    Body(String),
    Ciphertext(String),
    GitSignature(GitSignature),
    CustomerId(String),
}

/// The fields of a NIP-GS envelope, which git-sign-nostr armors.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GitSignature {
    pub pubkey: String,
    pub sig: String,
    pub t: u64,
    pub oa: Option<(String, String, String)>,
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("signer frame io: {0}")]
    Io(#[from] io::Error),
    #[error("signer_frame_too_large")]
    TooLarge,
    #[error("signer frame is not valid: {0}")]
    Format(#[from] serde_json::Error),
}

/// Reads one length-prefixed JSON frame.
pub fn read_frame<T: serde::de::DeserializeOwned>(reader: &mut impl Read) -> Result<T, FrameError> {
    let mut prefix = [0u8; 4];
    reader.read_exact(&mut prefix)?;
    let len = u32::from_be_bytes(prefix);
    if len > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }
    let mut body = vec![0u8; len as usize];
    reader.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
}

/// Writes one length-prefixed JSON frame.
pub fn write_frame<T: Serialize>(writer: &mut impl Write, value: &T) -> Result<(), FrameError> {
    let body = serde_json::to_vec(value)?;
    let len = u32::try_from(body.len())
        .ok()
        .filter(|len| *len <= MAX_FRAME_BYTES)
        .ok_or(FrameError::TooLarge)?;
    writer.write_all(&len.to_be_bytes())?;
    writer.write_all(&body)?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Result<Request, serde_json::Error> {
        serde_json::from_str(json)
    }

    #[test]
    fn no_op_accepts_an_id_a_digest_or_a_pubkey() {
        for op in [
            r#"{"op":"pubkey","id":"aa"}"#,
            r#"{"op":"sign_event","kind":1,"content":"","tags":[],"created_at":null,"id":"aa"}"#,
            r#"{"op":"sign_event","kind":1,"content":"","tags":[],"created_at":null,"pubkey":"aa"}"#,
            r#"{"op":"git_sign","payload_b64":"","digest":"aa"}"#,
            r#"{"op":"observer_encrypt","payload":"","peer":"aa"}"#,
            r#"{"op":"relay_auth","challenge":"aa","relay":"wss://example.invalid"}"#,
            r#"{"op":"sign_digest","digest":"aa"}"#,
        ] {
            let request = format!(r#"{{"token":"t","op":{op}}}"#);
            assert!(parse(&request).is_err(), "{op} must not parse");
        }
    }

    #[test]
    fn a_request_round_trips_through_a_frame() {
        let request = Request {
            token: "t".into(),
            op: Op::SignEvent {
                kind: 1,
                content: "hello".into(),
                tags: vec![vec!["h".into(), "room".into()]],
                created_at: Some(7),
            },
        };
        let mut wire = Vec::new();
        write_frame(&mut wire, &request).unwrap();
        let decoded: Request = read_frame(&mut wire.as_slice()).unwrap();
        assert_eq!(decoded.op, request.op);
    }

    #[test]
    fn an_oversized_frame_is_refused_before_its_body_is_read() {
        let wire = (MAX_FRAME_BYTES + 1).to_be_bytes();
        let result: Result<Request, _> = read_frame(&mut wire.as_slice());
        assert!(matches!(result, Err(FrameError::TooLarge)));
    }
}

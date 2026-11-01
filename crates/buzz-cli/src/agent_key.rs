//! Who signs for this CLI: a key it holds, or buzz-acp's signer socket.
//!
//! Under a harness the CLI gets [`buzz_signer::SOCKET_ENV`] and
//! [`buzz_signer::TOKEN_ENV`] and never sees the key. Run by hand it holds one.

use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD};
use base64::Engine as _;
use buzz_core::engram::{self, Body, EngramError};
use buzz_core::observer::encrypt_observer_payload;
use buzz_signer::{Client, ClientError, Op, Output};
use buzz_ws_client::{AuthSigner, WsClientError};
use nostr::{Event, EventBuilder, JsonUtil as _, Keys, PublicKey, Tag};
use serde::Serialize;
use sha2::{Digest as _, Sha256};

use crate::error::CliError;

/// The signing identity behind a [`crate::client::BuzzClient`].
#[derive(Debug, Clone)]
pub enum AgentKey {
    /// The CLI holds the key itself.
    Local(Keys),
    /// buzz-acp holds it. Every signature is a socket call.
    Socket {
        /// Connection details, including this run's token.
        client: Client,
        /// The agent's pubkey, read once from the signer at start.
        pubkey: PublicKey,
    },
}

fn refused(error: ClientError) -> CliError {
    CliError::Other(error.to_string())
}

fn event_from(json: &str) -> Result<Event, CliError> {
    Event::from_json(json).map_err(|e| CliError::Other(format!("signer returned bad event: {e}")))
}

impl AgentKey {
    /// Connects to the signer socket this process was given, if any.
    pub fn from_signer_env() -> Result<Option<Self>, CliError> {
        let Some(client) = Client::from_env() else {
            return Ok(None);
        };
        let hex = client.pubkey().map_err(refused)?;
        let pubkey = PublicKey::from_hex(&hex)
            .map_err(|e| CliError::Other(format!("signer returned bad pubkey: {e}")))?;
        Ok(Some(Self::Socket { client, pubkey }))
    }

    /// The identity's pubkey.
    pub fn public_key(&self) -> PublicKey {
        match self {
            Self::Local(keys) => keys.public_key(),
            Self::Socket { pubkey, .. } => *pubkey,
        }
    }

    /// The key, for the few paths that need a key of their own. Owner-side
    /// commands use this: a signer only ever holds the agent's key.
    pub fn local(&self) -> Option<&Keys> {
        match self {
            Self::Local(keys) => Some(keys),
            Self::Socket { .. } => None,
        }
    }

    /// Signs exactly what the builder holds. On a socket the signer adds the
    /// NIP-OA tag itself and applies its kind and time rules.
    pub fn sign(&self, builder: EventBuilder) -> Result<Event, CliError> {
        match self {
            Self::Local(keys) => builder
                .sign_with_keys(keys)
                .map_err(|e| CliError::Other(format!("signing failed: {e}"))),
            Self::Socket { client, pubkey } => {
                let unsigned = builder.build(*pubkey);
                let tags = unsigned
                    .tags
                    .iter()
                    .map(|tag: &Tag| tag.as_slice().to_vec())
                    .collect();
                let json = client
                    .event(Op::SignEvent {
                        kind: unsigned.kind.as_u16(),
                        content: unsigned.content.clone(),
                        tags,
                        created_at: Some(unsigned.created_at.as_secs()),
                    })
                    .map_err(refused)?;
                event_from(&json)
            }
        }
    }

    /// A signed NIP-98 event, without the owner tag. `body` is hashed here.
    pub fn sign_nip98(
        &self,
        method: &str,
        url: &str,
        body: Option<&[u8]>,
    ) -> Result<Event, CliError> {
        let hash = body.map(|b| hex::encode(Sha256::digest(b)));
        match self {
            Self::Local(keys) => {
                let nonce = uuid::Uuid::new_v4().to_string();
                let mut rows = vec![
                    vec!["u", url],
                    vec!["method", method],
                    // Nonce prevents replay rejection for rapid-fire requests
                    // with identical bodies.
                    vec!["nonce", nonce.as_str()],
                ];
                rows.extend(hash.as_deref().map(|hash| vec!["payload", hash]));
                let tags = parse_rows(rows)?;
                nostr::EventBuilder::new(nostr::Kind::Custom(27235), "")
                    .tags(tags)
                    .sign_with_keys(keys)
                    .map_err(|e| CliError::Other(format!("NIP-98 signing failed: {e}")))
            }
            Self::Socket { client, .. } => {
                let json = client
                    .event(Op::Nip98 {
                        url: url.to_string(),
                        method: method.to_string(),
                        payload_hash: hash,
                        owner_tag: false,
                    })
                    .map_err(refused)?;
                event_from(&json)
            }
        }
    }

    fn socket(&self) -> Result<&Client, CliError> {
        match self {
            Self::Socket { client, .. } => Ok(client),
            Self::Local(_) => Err(CliError::Other("no signer socket here".into())),
        }
    }

    /// A Blossom `get` authorization from the signer. Socket only.
    pub fn socket_blossom_get(&self, media_url: &str) -> Result<String, CliError> {
        let json = self
            .socket()?
            .event(Op::BlossomGet {
                media_url: media_url.to_string(),
            })
            .map_err(refused)?;
        Ok(url_safe_header(&event_from(&json)?))
    }

    /// A Blossom `upload` authorization from the signer. Socket only.
    pub fn socket_blossom_upload(&self, sha256: &str, url: &str) -> Result<String, CliError> {
        let json = self
            .socket()?
            .event(Op::BlossomUpload {
                sha256: sha256.to_string(),
                url: url.to_string(),
            })
            .map_err(refused)?;
        Ok(url_safe_header(&event_from(&json)?))
    }

    /// The GIF customer id from the signer. Socket only.
    pub fn socket_gif_customer_id(&self) -> Result<String, CliError> {
        match self.socket()?.call(Op::GifCustomerId).map_err(refused)? {
            Output::CustomerId(id) => Ok(id),
            _ => Err(CliError::Other(
                "signer returned an unexpected reply".into(),
            )),
        }
    }

    /// The `d` tag for `slug` between this identity and `their_pubkey`. On a
    /// socket the peer is always the signer's owner.
    pub fn mem_d_tag(&self, their_pubkey: &PublicKey, slug: &str) -> Result<String, CliError> {
        match self {
            Self::Local(keys) => {
                let key = engram::conversation_key(keys.secret_key(), their_pubkey);
                Ok(engram::d_tag(&key, slug))
            }
            Self::Socket { client, .. } => {
                let op = Op::MemDTag {
                    slug: slug.to_string(),
                };
                match client.call(op).map_err(refused)? {
                    Output::DTag(d) => Ok(d),
                    _ => Err(CliError::Other(
                        "signer returned an unexpected reply".into(),
                    )),
                }
            }
        }
    }

    /// Validates and decrypts an engram. Keeps `validate_and_decrypt`'s error
    /// type, so a bad event is skipped the same way on both paths.
    pub fn mem_open(
        &self,
        event: &Event,
        agent: &PublicKey,
        owner: &PublicKey,
        their_pubkey: &PublicKey,
    ) -> Result<Body, EngramError> {
        match self {
            Self::Local(keys) => {
                engram::validate_and_decrypt(event, agent, owner, keys.secret_key(), their_pubkey)
            }
            Self::Socket { client, .. } => {
                let op = Op::MemRead {
                    event_json: event.as_json(),
                };
                match client.call(op) {
                    Ok(Output::Body(json)) => Body::from_json_bytes(json.as_bytes()),
                    Ok(_) => Err(EngramError::InvalidEnvelope(
                        "signer returned an unexpected reply".into(),
                    )),
                    Err(error) => Err(EngramError::InvalidEnvelope(error.to_string())),
                }
            }
        }
    }

    /// Builds a signed engram for `owner`.
    pub fn mem_event(
        &self,
        owner: &PublicKey,
        body: &Body,
        created_at: u64,
    ) -> Result<Event, CliError> {
        match self {
            Self::Local(keys) => engram::build_event(keys, owner, body, created_at)
                .map_err(|e| CliError::Other(format!("build event failed: {e}"))),
            Self::Socket { client, .. } => {
                let body_json = String::from_utf8(body.to_json_bytes())
                    .map_err(|e| CliError::Other(format!("body JSON not UTF-8: {e}")))?;
                let json = client
                    .event(Op::MemWrite {
                        body_json,
                        created_at: Some(created_at),
                    })
                    .map_err(refused)?;
                event_from(&json)
            }
        }
    }

    /// Encrypts an observer payload to `owner`.
    pub fn observer_encrypt<T: Serialize>(
        &self,
        owner: &PublicKey,
        payload: &T,
    ) -> Result<String, CliError> {
        match self {
            Self::Local(keys) => encrypt_observer_payload(keys, owner, payload)
                .map_err(|e| CliError::Other(format!("could not encrypt draft request: {e}"))),
            Self::Socket { client, .. } => {
                let payload = serde_json::to_string(payload)
                    .map_err(|e| CliError::Other(format!("could not encode draft request: {e}")))?;
                match client
                    .call(Op::ObserverEncrypt { payload })
                    .map_err(refused)?
                {
                    Output::Ciphertext(text) => Ok(text),
                    _ => Err(CliError::Other(
                        "signer returned an unexpected reply".into(),
                    )),
                }
            }
        }
    }
}

impl From<Keys> for AgentKey {
    fn from(keys: Keys) -> Self {
        Self::Local(keys)
    }
}

impl AuthSigner for AgentKey {
    fn sign_auth(
        &self,
        challenge: &str,
        relay_url: &str,
        auth_tag: Option<&Tag>,
    ) -> Result<Event, WsClientError> {
        match self {
            Self::Local(keys) => keys.sign_auth(challenge, relay_url, auth_tag),
            Self::Socket { client, .. } => {
                let json = client
                    .event(Op::RelayAuth {
                        challenge: challenge.to_string(),
                        relay: relay_url.to_string(),
                    })
                    .map_err(|e| WsClientError::EventBuilder(e.to_string()))?;
                Event::from_json(json).map_err(|e| WsClientError::EventBuilder(e.to_string()))
            }
        }
    }
}

fn parse_rows(rows: Vec<Vec<&str>>) -> Result<Vec<Tag>, CliError> {
    rows.into_iter()
        .map(|row| Tag::parse(row).map_err(|e| CliError::Other(format!("tag error: {e}"))))
        .collect()
}

/// `Nostr <base64url>` for a signed authorization event.
pub fn url_safe_header(event: &Event) -> String {
    format!(
        "Nostr {}",
        URL_SAFE_NO_PAD.encode(event.as_json().as_bytes())
    )
}

/// `Nostr <base64>` for a signed NIP-98 event.
pub fn nip98_header(event: &Event) -> String {
    format!("Nostr {}", B64.encode(event.as_json().as_bytes()))
}

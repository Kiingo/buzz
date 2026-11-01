//! The ops themselves. Every path that reaches the agent key from a child goes
//! through [`Signer::handle`].

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use buzz_core::engram::{self, Body};
use buzz_core::observer::encrypt_observer_payload;
use buzz_signer::{GitSignature, Op, Output};
use nostr::secp256k1::Message;
use nostr::{Event, EventBuilder, JsonUtil as _, Keys, Kind, PublicKey, RelayUrl, Tag, Timestamp};

use super::policy;

/// A stable refusal code. Safe to return and to log.
pub(super) type Refusal = &'static str;

/// How long a Blossom authorization stays good.
const BLOSSOM_TTL_SECS: u64 = 60;

/// What the signer holds. The key never leaves this struct.
pub(crate) struct Signer {
    keys: Keys,
    auth_tag: Option<Tag>,
    oa: Option<(String, String, String)>,
    owner: Option<PublicKey>,
    relay_url: RelayUrl,
    origins: Vec<url::Origin>,
    /// The only origin that may receive the owner tag on NIP-98: Git's
    /// credential scope is the dial relay.
    git_origin: url::Origin,
}

impl std::fmt::Debug for Signer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Signer")
            .field("agent", &self.keys.public_key().to_hex())
            .finish_non_exhaustive()
    }
}

/// `ws`/`wss` to `http`/`https`, so a relay URL and a media URL compare.
fn http_origin(url: &url::Url) -> Option<url::Origin> {
    let mut url = url.clone();
    let scheme = match url.scheme() {
        "ws" => "http",
        "wss" => "https",
        "http" | "https" => return Some(url.origin()),
        _ => return None,
    };
    url.set_scheme(scheme).ok()?;
    Some(url.origin())
}

impl Signer {
    /// `relay_url` is the relay this agent signs in to. `origins` lists the
    /// other URLs NIP-98 and Blossom may name: the canonical relay and media.
    pub(crate) fn new(
        keys: Keys,
        auth_tag: Option<Tag>,
        relay_url: &str,
        origins: &[String],
    ) -> anyhow::Result<Self> {
        let parsed = url::Url::parse(relay_url)?;
        let git_origin =
            http_origin(&parsed).ok_or_else(|| anyhow::anyhow!("relay URL has no origin"))?;
        let mut allowed = vec![git_origin.clone()];
        for origin in origins {
            allowed.push(
                http_origin(&url::Url::parse(origin)?)
                    .ok_or_else(|| anyhow::anyhow!("origin URL has no origin"))?,
            );
        }
        let oa = auth_tag.as_ref().and_then(|tag| match tag.as_slice() {
            [_, owner, conditions, sig] => Some((owner.clone(), conditions.clone(), sig.clone())),
            _ => None,
        });
        let owner = oa
            .as_ref()
            .and_then(|(owner, _, _)| PublicKey::from_hex(owner).ok());
        Ok(Self {
            keys,
            auth_tag,
            oa,
            owner,
            relay_url: RelayUrl::parse(relay_url)?,
            origins: allowed,
            git_origin,
        })
    }

    /// The owner `mem_*` ops encrypt to, from the harness's own resolution:
    /// the verified tag, else the configured owner. A child can't choose it.
    pub(crate) fn with_owner(mut self, owner: Option<PublicKey>) -> Self {
        self.owner = owner;
        self
    }

    pub(crate) fn agent_hex(&self) -> String {
        self.keys.public_key().to_hex()
    }

    /// Runs one op. `now` is the signer's clock, in seconds.
    pub(crate) fn handle(&self, op: Op, now: u64) -> Result<Output, Refusal> {
        match op {
            Op::Pubkey => Ok(Output::Pubkey(self.agent_hex())),
            Op::SignEvent {
                kind,
                content,
                tags,
                created_at,
            } => self.sign_event(kind, content, tags, created_at, now),
            Op::Nip98 {
                url,
                method,
                payload_hash,
                owner_tag,
            } => self.nip98(&url, &method, payload_hash.as_deref(), owner_tag),
            Op::BlossomGet { media_url } => self.blossom_get(&media_url, now),
            Op::BlossomUpload { sha256, url } => self.blossom_upload(&sha256, &url, now),
            Op::RelayAuth { challenge, relay } => self.relay_auth(&challenge, &relay),
            Op::MemDTag { slug } => self.mem_d_tag(&slug),
            Op::MemWrite {
                body_json,
                created_at,
            } => self.mem_write(&body_json, created_at, now),
            Op::MemRead { event_json } => self.mem_read(&event_json),
            Op::ObserverEncrypt { payload } => self.observer_encrypt(&payload),
            Op::GitSign { payload_b64 } => self.git_sign(&payload_b64, now),
            Op::GifCustomerId => Ok(self.gif_customer_id()),
        }
    }

    fn signed(&self, builder: EventBuilder) -> Result<Output, Refusal> {
        builder
            .sign_with_keys(&self.keys)
            .map(|event| Output::Event(event.as_json()))
            .map_err(|_| "signer_sign_failed")
    }

    fn sign_event(
        &self,
        kind: u16,
        content: String,
        rows: Vec<Vec<String>>,
        created_at: Option<u64>,
        now: u64,
    ) -> Result<Output, Refusal> {
        policy::check_kind(kind)?;
        let created_at = policy::created_at(now, created_at)?;
        let attested = policy::carries_target_attestation(kind);
        let mut tags = Vec::with_capacity(rows.len() + 1);
        for row in rows {
            if !attested && row.first().is_some_and(|name| name == "auth") {
                return Err("signer_auth_tag_refused");
            }
            tags.push(Tag::parse(row).map_err(|_| "signer_tag_invalid")?);
        }
        if !attested {
            tags.extend(self.auth_tag.clone());
        }
        self.signed(
            EventBuilder::new(Kind::from(kind), content)
                .tags(tags)
                .custom_created_at(Timestamp::from(created_at)),
        )
    }

    fn check_origin(&self, url: &str) -> Result<(), Refusal> {
        url::Url::parse(url)
            .ok()
            .and_then(|url| http_origin(&url))
            .filter(|origin| self.origins.contains(origin))
            .map(|_| ())
            .ok_or("signer_origin_refused")
    }

    fn nip98(
        &self,
        url: &str,
        method: &str,
        payload_hash: Option<&str>,
        owner_tag: bool,
    ) -> Result<Output, Refusal> {
        self.check_origin(url)?;
        policy::check_method(method)?;
        let nonce = uuid::Uuid::new_v4().to_string();
        let mut rows = vec![
            vec!["u", url],
            vec!["method", method],
            vec!["nonce", nonce.as_str()],
        ];
        if let Some(hash) = payload_hash {
            if !policy::is_lower_hex_64(hash) {
                return Err("signer_payload_hash_invalid");
            }
            rows.push(vec!["payload", hash]);
        }
        let mut tags = parse_tags(rows)?;
        if owner_tag {
            let origin = url::Url::parse(url).ok().and_then(|url| http_origin(&url));
            if origin.as_ref() != Some(&self.git_origin) {
                return Err("signer_owner_tag_refused");
            }
            tags.extend(self.auth_tag.clone());
        }
        self.signed(EventBuilder::new(Kind::Custom(27235), "").tags(tags))
    }

    fn blossom(
        &self,
        verb: &str,
        sha256: Option<&str>,
        url: &str,
        content: &str,
        now: u64,
    ) -> Result<Output, Refusal> {
        self.check_origin(url)?;
        let domain = buzz_core::tenant::relay_url_authority(url);
        if domain.is_empty() {
            return Err("signer_origin_refused");
        }
        let expiration = (now + BLOSSOM_TTL_SECS).to_string();
        let mut rows = vec![vec!["t", verb]];
        rows.extend(sha256.map(|hash| vec!["x", hash]));
        rows.push(vec!["expiration", expiration.as_str()]);
        rows.push(vec!["server", domain.as_str()]);
        let tags = parse_tags(rows)?;
        self.signed(EventBuilder::new(Kind::Custom(24242), content).tags(tags))
    }

    fn blossom_get(&self, media_url: &str, now: u64) -> Result<Output, Refusal> {
        self.blossom("get", None, media_url, "Get media", now)
    }

    fn blossom_upload(&self, sha256: &str, url: &str, now: u64) -> Result<Output, Refusal> {
        if !policy::is_lower_hex_64(sha256) {
            return Err("signer_payload_hash_invalid");
        }
        self.blossom("upload", Some(sha256), url, "Upload file", now)
    }

    /// The relay must be one of the signer's origins. The time is always the
    /// signer's.
    fn relay_auth(&self, challenge: &str, relay: &str) -> Result<Output, Refusal> {
        policy::check_challenge(challenge)?;
        self.check_origin(relay)?;
        let relay = RelayUrl::parse(relay).map_err(|_| "signer_origin_refused")?;
        let builder = EventBuilder::auth(challenge, relay);
        self.signed(match &self.auth_tag {
            Some(tag) => builder.tags([tag.clone()]),
            None => builder,
        })
    }

    fn owner(&self) -> Result<&PublicKey, Refusal> {
        self.owner.as_ref().ok_or("signer_no_owner")
    }

    fn mem_d_tag(&self, slug: &str) -> Result<Output, Refusal> {
        let owner = self.owner()?;
        engram::validate_slug(slug).map_err(|_| "signer_mem_slug_invalid")?;
        let key = engram::conversation_key(self.keys.secret_key(), owner);
        Ok(Output::DTag(engram::d_tag(&key, slug)))
    }

    fn mem_write(
        &self,
        body_json: &str,
        created_at: Option<u64>,
        now: u64,
    ) -> Result<Output, Refusal> {
        let owner = self.owner()?;
        let created_at = policy::created_at(now, created_at)?;
        let body =
            Body::from_json_bytes(body_json.as_bytes()).map_err(|_| "signer_mem_body_invalid")?;
        engram::build_event(&self.keys, owner, &body, created_at)
            .map(|event| Output::Event(event.as_json()))
            .map_err(|_| "signer_mem_write_failed")
    }

    /// Verifies the signature before anything touches the ciphertext, then
    /// insists the author is this agent. Without both, a child could wrap any
    /// agent-owner ciphertext in a forged event and read it back.
    /// `validate_and_decrypt` leaves the signature to its caller.
    fn mem_read(&self, event_json: &str) -> Result<Output, Refusal> {
        let owner = self.owner()?;
        let event = Event::from_json(event_json).map_err(|_| "signer_mem_event_invalid")?;
        event.verify().map_err(|_| "signer_mem_event_invalid")?;
        let agent = self.keys.public_key();
        if event.pubkey != agent {
            return Err("signer_mem_author_refused");
        }
        let body =
            engram::validate_and_decrypt(&event, &agent, owner, self.keys.secret_key(), owner)
                .map_err(|_| "signer_mem_event_invalid")?;
        String::from_utf8(body.to_json_bytes())
            .map(Output::Body)
            .map_err(|_| "signer_mem_event_invalid")
    }

    fn observer_encrypt(&self, payload: &str) -> Result<Output, Refusal> {
        let owner = self.owner()?;
        let value: serde_json::Value =
            serde_json::from_str(payload).map_err(|_| "signer_observer_payload_invalid")?;
        encrypt_observer_payload(&self.keys, owner, &value)
            .map(Output::Ciphertext)
            .map_err(|_| "signer_observer_encrypt_failed")
    }

    /// The caller sends object bytes only. The prefix, `t` and `oa` are ours, so
    /// the preimage can never start like a Nostr event id's.
    fn git_sign(&self, payload_b64: &str, now: u64) -> Result<Output, Refusal> {
        let payload = B64
            .decode(payload_b64)
            .map_err(|_| "signer_git_payload_invalid")?;
        if let Some((_, conditions, _)) = &self.oa {
            git_sign_nostr::enforce_conditions(conditions, now)
                .map_err(|_| "signer_git_conditions_refused")?;
        }
        let hash = git_sign_nostr::compute_signing_hash(now, self.oa.as_ref(), &payload);
        let sig = self.keys.sign_schnorr(&Message::from_digest(hash));
        Ok(Output::GitSignature(GitSignature {
            pubkey: self.agent_hex(),
            sig: hex::encode(sig.serialize()),
            t: now,
            oa: self.oa.clone(),
        }))
    }
}

impl Signer {
    /// The same domain-separated id the CLI makes with a key of its own.
    fn gif_customer_id(&self) -> Output {
        Output::CustomerId(buzz_signer::gif_customer_id(
            self.keys.secret_key().as_secret_bytes(),
            self.relay_url.as_str(),
        ))
    }
}

fn parse_tags(rows: Vec<Vec<&str>>) -> Result<Vec<Tag>, Refusal> {
    rows.into_iter()
        .map(|row| Tag::parse(row).map_err(|_| "signer_tag_invalid"))
        .collect()
}

/// The header value a CLI sends with a signed authorization event.
#[cfg(test)]
pub(super) fn nostr_header(event_json: &str) -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    format!("Nostr {}", URL_SAFE_NO_PAD.encode(event_json.as_bytes()))
}

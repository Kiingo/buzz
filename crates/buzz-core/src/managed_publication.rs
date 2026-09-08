//! Exact, domain-separated runtime authorizations. Parsing is NOT authority:
//! the relay must verify the signature with its community-bound issuer key
//! before applying a publication or an explicit-user cancellation fence.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use nostr::Event;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Versioned signature domain. It cannot authorize catalogs or other APIs.
pub const DOMAIN: &str = "buzz-managed-publication-v1";
/// Nostr tag carrying the runtime authorization for an exact chat event.
pub const AUTHORIZATION_TAG: &str = "runtime";
/// Bound both decoding work and the public event's authorization overhead.
pub const MAX_AUTHORIZATION_BYTES: usize = 4096;

/// The durable cancellation boundary: an entire discussion or one invocation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScopeKind {
    /// All participants and successors of one discussion.
    Discussion,
    /// One independent invocation, with no discussion successor.
    Receipt,
}

/// A publication permit never carries semantic finish/handoff instructions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    /// Permit only the exact event template, signer, receipt, and fence.
    Publish {
        /// The source invocation receipt.
        receipt_id: String,
        /// Immutable publication identity assigned by the runtime.
        fence_id: String,
        /// Nostr signer allowed to deliver this contribution.
        signer_public_key: String,
        /// NIP-01 event hash before adding the runtime tag.
        event_template_hash: String,
    },
    /// Revoke a scope only after the runtime verified explicit user intent.
    Cancel {
        /// Actual signed user Stop event retained by the runtime.
        user_request_event_id: String,
    },
}

/// Shared immutable identity of the discussion/invocation being controlled.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Claims {
    /// Exact signature domain/version.
    pub domain: String,
    /// Platform community identifier. Trust is resolved inside the host's
    /// relay community, never by this caller-supplied identifier alone.
    pub issuer: String,
    /// Normalized relay host (and non-default port). Binds authority even if
    /// an operator trusts the same runtime key in two communities.
    pub audience: String,
    /// Identifier of a community-bound trusted signing key.
    pub key_id: String,
    /// Scope type.
    pub scope_kind: ScopeKind,
    /// Discussion UUID, or receipt UUID for independent invocations.
    pub scope_id: String,
    /// Exact channel UUID.
    pub channel_id: String,
    /// Verified original requester, not the agent's transport signer.
    pub requester_public_key: String,
    /// Original user request that created the scope.
    pub request_event_id: String,
    /// Narrow publication or explicit cancellation operation.
    pub action: Operation,
}

/// Signed claims. The signature is raw Ed25519, encoded as base64url without
/// padding. No embedded public key is accepted as a trust source.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Authorization {
    /// Validated claims, not necessarily authenticated yet.
    pub claims: Claims,
    /// Signature over [`Claims::signing_bytes`].
    pub signature: String,
}

/// Trust selected from server configuration/database inside the resolved host
/// community. Never construct this from an event's embedded metadata.
pub struct TrustedIssuer<'a> {
    /// Host-resolved relay community, not a client-supplied tenant.
    pub community: crate::CommunityId,
    /// Host from that same resolved tenant, never from the claims.
    pub audience: &'a str,
    /// Authorized runtime issuer within that community.
    pub issuer: &'a str,
    /// Exact configured signing-key identifier.
    pub key_id: &'a str,
    /// Raw Ed25519 verification key from trusted server state.
    pub public_key: &'a [u8; 32],
}

/// Authenticated, community-bound authority. This cannot be deserialized or
/// constructed from unchecked claims. Database fencing accepts this type.
pub struct VerifiedAuthorization {
    community: crate::CommunityId,
    claims: Claims,
    publication_event_id: Option<nostr::EventId>,
}

impl VerifiedAuthorization {
    /// Resolved community against which issuer trust was verified.
    pub fn community(&self) -> crate::CommunityId {
        self.community
    }
    /// Cryptographically verified claims. They still require a current durable
    /// cancellation check in the same transaction as event insertion.
    pub fn claims(&self) -> &Claims {
        &self.claims
    }

    /// Exact outer event whose Nostr signature and runtime tag were verified.
    /// Cancellation payloads cannot be used as publication capabilities.
    pub fn publication_event_id(&self) -> Option<nostr::EventId> {
        self.publication_event_id
    }

    /// Verify the exact authorization tag carried by this Nostr event. A
    /// separately supplied permit cannot authorize a different tag encoding.
    pub fn publication(event: &Event, trust: TrustedIssuer<'_>) -> Result<Self, String> {
        event
            .verify()
            .map_err(|_| "invalid: managed Nostr signature")?;
        let mut tags = event.tags.iter().filter(|tag| {
            tag.as_slice()
                .first()
                .is_some_and(|name| name == AUTHORIZATION_TAG)
        });
        let tag = tags
            .next()
            .ok_or("invalid: managed authorization missing")?;
        if tags.next().is_some() || tag.as_slice().len() != 2 {
            return Err("invalid: managed authorization tag".into());
        }
        let authorization = Authorization::decode(&tag.as_slice()[1])?;
        authorization.claims.check_event(event)?;
        let mut verified = authorization.verify(trust)?;
        verified.publication_event_id = Some(event.id);
        Ok(verified)
    }

    /// Verify an explicit-user cancellation payload. Operational status cannot
    /// enter this path, even if its transport event is correctly signed.
    pub fn cancellation(encoded: &str, trust: TrustedIssuer<'_>) -> Result<Self, String> {
        let authorization = Authorization::decode(encoded)?;
        if !matches!(authorization.claims.action, Operation::Cancel { .. }) {
            return Err("restricted: explicit user cancellation required".into());
        }
        authorization.verify(trust)
    }
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

fn hex_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}

impl Claims {
    /// Validate identity syntax and operation-specific invariants. This does
    /// not verify issuer trust, signature, membership, or current cancellation.
    pub fn validate(&self) -> Result<(), String> {
        if self.domain != DOMAIN
            || !identifier(&self.issuer)
            || self.audience.is_empty()
            || self.audience.len() > 255
            || !self
                .audience
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".:-[]".contains(&b))
            || crate::normalize_host(&self.audience) != self.audience
            || !identifier(&self.key_id)
            || !canonical_uuid(&self.scope_id)
            || !canonical_uuid(&self.channel_id)
            || !hex_id(&self.requester_public_key)
            || !hex_id(&self.request_event_id)
        {
            return Err("invalid: managed publication scope".into());
        }
        match &self.action {
            Operation::Publish {
                receipt_id,
                fence_id,
                signer_public_key,
                event_template_hash,
            } => {
                if !canonical_uuid(receipt_id)
                    || !canonical_uuid(fence_id)
                    || !hex_id(signer_public_key)
                    || !hex_id(event_template_hash)
                    || (self.scope_kind == ScopeKind::Receipt && &self.scope_id != receipt_id)
                {
                    return Err("invalid: managed publication permit".into());
                }
            }
            Operation::Cancel {
                user_request_event_id,
            } => {
                if !hex_id(user_request_event_id) || user_request_event_id == &self.request_event_id
                {
                    return Err("invalid: managed user cancellation".into());
                }
            }
        }
        Ok(())
    }

    /// Fixed-order scalar arrays avoid JSON object-order and number-precision
    /// differences across Node and Rust. No timeout limits discussion life.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, String> {
        self.validate()?;
        let action = match &self.action {
            Operation::Publish {
                receipt_id,
                fence_id,
                signer_public_key,
                event_template_hash,
            } => {
                serde_json::json!([
                    "publish",
                    receipt_id,
                    fence_id,
                    signer_public_key,
                    event_template_hash
                ])
            }
            Operation::Cancel {
                user_request_event_id,
            } => serde_json::json!(["cancel", user_request_event_id]),
        };
        serde_json::to_vec(&serde_json::json!([
            self.domain,
            self.issuer,
            self.audience,
            self.key_id,
            self.scope_kind,
            self.scope_id,
            self.channel_id,
            self.requester_public_key,
            self.request_event_id,
            action
        ]))
        .map_err(|_| "invalid: managed authorization encoding".into())
    }

    /// Check that a parsed permit binds this exact signed event. The caller
    /// must separately verify the authorization and the Nostr signatures.
    pub fn check_event(&self, event: &Event) -> Result<(), String> {
        self.validate()?;
        let Operation::Publish {
            signer_public_key,
            event_template_hash,
            fence_id,
            ..
        } = &self.action
        else {
            return Err("restricted: cancellation is not a publication permit".into());
        };
        if event.kind.as_u16() != 9 || &event.pubkey.to_hex() != signer_public_key {
            return Err("restricted: managed publication signer or kind".into());
        }
        let mut tags = Vec::new();
        let mut authorization_count = 0;
        let mut channel_count = 0;
        let mut fence_count = 0;
        for tag in event.tags.iter() {
            let parts = tag.as_slice();
            match parts.first().map(String::as_str) {
                Some(AUTHORIZATION_TAG) => {
                    if parts.len() != 2 || parts[1].is_empty() {
                        return Err("invalid: managed authorization tag".into());
                    }
                    authorization_count += 1;
                    continue;
                }
                Some("h") => {
                    if parts.len() != 2 || parts[1] != self.channel_id {
                        return Err("restricted: managed publication channel".into());
                    }
                    channel_count += 1;
                }
                Some("d") => {
                    if parts.len() != 2 || parts[1] != format!("buzz-local-publication:{fence_id}")
                    {
                        return Err("restricted: managed publication fence".into());
                    }
                    fence_count += 1;
                }
                _ => {}
            }
            tags.push(parts);
        }
        if authorization_count != 1 || channel_count != 1 || fence_count != 1 {
            return Err("invalid: ambiguous managed publication binding".into());
        }
        let bytes = serde_json::to_vec(&serde_json::json!([
            0,
            event.pubkey.to_hex(),
            event.created_at.as_secs(),
            event.kind.as_u16(),
            tags,
            event.content
        ]))
        .map_err(|_| "invalid: managed event encoding".to_string())?;
        if &hex::encode(Sha256::digest(bytes)) != event_template_hash {
            return Err("restricted: managed publication bytes changed".into());
        }
        Ok(())
    }
}

impl Authorization {
    /// Decode only canonical, bounded base64url JSON. A successful decode
    /// explicitly does NOT authenticate these claims.
    pub fn decode(encoded: &str) -> Result<Self, String> {
        if encoded.is_empty() || encoded.len() > MAX_AUTHORIZATION_BYTES {
            return Err("invalid: managed authorization size".into());
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "invalid: managed authorization encoding")?;
        if URL_SAFE_NO_PAD.encode(&bytes) != encoded {
            return Err("invalid: managed authorization encoding".into());
        }
        let value: Self =
            serde_json::from_slice(&bytes).map_err(|_| "invalid: managed authorization payload")?;
        value.claims.validate()?;
        value.signature_bytes()?;
        // The token participates in the outer Nostr event ID. Alternate JSON
        // whitespace/key order must not create duplicate visible contributions.
        if serde_json::to_vec(&value).map_err(|_| "invalid: managed authorization payload")?
            != bytes
        {
            return Err("invalid: noncanonical managed authorization".into());
        }
        Ok(value)
    }

    /// Obtain the raw signature while rejecting alternate encodings.
    pub fn signature_bytes(&self) -> Result<[u8; 64], String> {
        let bytes = URL_SAFE_NO_PAD
            .decode(&self.signature)
            .map_err(|_| "invalid: managed authorization signature")?;
        if URL_SAFE_NO_PAD.encode(&bytes) != self.signature {
            return Err("invalid: managed authorization signature".into());
        }
        bytes
            .try_into()
            .map_err(|_| "invalid: managed authorization signature".into())
    }

    fn verify(self, trust: TrustedIssuer<'_>) -> Result<VerifiedAuthorization, String> {
        if self.claims.issuer != trust.issuer
            || self.claims.audience != trust.audience
            || self.claims.key_id != trust.key_id
        {
            return Err("restricted: managed runtime issuer mismatch".into());
        }
        let key = VerifyingKey::from_bytes(trust.public_key)
            .map_err(|_| "restricted: invalid managed runtime key")?;
        let signature = Signature::from_bytes(&self.signature_bytes()?);
        key.verify_strict(&self.claims.signing_bytes()?, &signature)
            .map_err(|_| "restricted: managed runtime signature")?;
        Ok(VerifiedAuthorization {
            community: trust.community,
            claims: self.claims,
            publication_event_id: None,
        })
    }
}

#[cfg(test)]
mod tests;

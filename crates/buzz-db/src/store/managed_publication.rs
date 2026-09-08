//! Durable publication/cancellation ordering. All mutations run inside the
//! event insertion transaction; neither process leases nor timestamps decide
//! whether a discussion should end.

use buzz_core::kind::{KIND_AGENT_CANCELLATION, KIND_AGENT_STATUS};
use buzz_core::managed_publication::{
    Authorization, Claims, Operation, ScopeKind, TrustedIssuer, VerifiedAuthorization,
    AUTHORIZATION_TAG,
};
use buzz_core::CommunityId;
use chrono::{DateTime, Utc};
use nostr::Event;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use crate::{DbError, Result};

impl crate::Db {
    /// Provision a community-bound runtime verification key from the operator
    /// control plane. Reconciliation never removes old keys or overwrites a
    /// key ID: durable pending authorizations survive process/key rotation.
    /// Caller must authenticate the issuer configuration before invoking this.
    pub async fn ensure_managed_runtime_issuer(
        &self,
        community: CommunityId,
        issuer: &str,
        key_id: &str,
        public_key: &[u8; 32],
    ) -> Result<()> {
        let identifier = |value: &str| {
            !value.is_empty()
                && value.len() <= 96
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
        };
        if !identifier(issuer) || !identifier(key_id) {
            return Err(denied("invalid runtime issuer configuration"));
        }
        ed25519_dalek::VerifyingKey::from_bytes(public_key)
            .map_err(|_| denied("invalid runtime verification key"))?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT assert_community_write_allowed($1)")
            .bind(community.as_uuid())
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO managed_runtime_issuers (community_id, issuer, key_id, public_key) \
            VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
        )
        .bind(community.as_uuid())
        .bind(issuer)
        .bind(key_id)
        .bind(public_key.as_slice())
        .execute(&mut *tx)
        .await?;
        let stored: Vec<u8> = sqlx::query_scalar(
            "SELECT public_key FROM managed_runtime_issuers \
            WHERE community_id = $1 AND issuer = $2 AND key_id = $3 FOR SHARE",
        )
        .bind(community.as_uuid())
        .bind(issuer)
        .bind(key_id)
        .fetch_one(&mut *tx)
        .await?;
        if stored.as_slice() != public_key {
            return Err(denied("runtime issuer key ID conflict"));
        }
        tx.commit().await?;
        Ok(())
    }
}

fn denied(reason: &str) -> DbError {
    DbError::AccessDenied(reason.to_owned())
}

fn uuid(value: &str) -> Result<Uuid> {
    Uuid::parse_str(value).map_err(|_| denied("invalid managed identity"))
}

fn bytes(value: &str) -> Result<Vec<u8>> {
    hex::decode(value).map_err(|_| denied("invalid managed identity"))
}

fn scope_kind(claims: &Claims) -> &'static str {
    match claims.scope_kind {
        ScopeKind::Discussion => "discussion",
        ScopeKind::Receipt => "receipt",
    }
}

#[cfg(test)]
mod tests;

/// Return the original acceptance time when this operation must not insert or
/// fan out a chat event. `None` allows the enclosing event transaction to insert.
/// This is the single gate used by every event-store insertion entry point.
pub(crate) async fn apply_event_tx(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    event: &Event,
    channel_id: Option<Uuid>,
) -> Result<Option<DateTime<Utc>>> {
    let kind = u32::from(event.kind.as_u16());
    let tokens: Vec<_> = event
        .tags
        .iter()
        .filter(|tag| {
            tag.as_slice()
                .first()
                .is_some_and(|name| name == AUTHORIZATION_TAG)
        })
        .collect();
    let managed_marker = event.tags.iter().any(|tag| {
        let parts = tag.as_slice();
        parts.first().is_some_and(|name| name == "d")
            && parts
                .get(1)
                .is_some_and(|value| value.starts_with("buzz-local-publication:"))
    });
    let is_cancel = kind == KIND_AGENT_CANCELLATION;
    if !is_cancel && tokens.is_empty() {
        if managed_marker && kind != KIND_AGENT_STATUS {
            return Err(denied("managed publication authorization required"));
        }
        return Ok(None);
    }
    let encoded = if is_cancel {
        if !tokens.is_empty() {
            return Err(denied("invalid cancellation control"));
        }
        event.content.as_str()
    } else {
        if tokens.len() != 1 || tokens[0].as_slice().len() != 2 {
            return Err(denied("invalid managed authorization tag"));
        }
        &tokens[0].as_slice()[1]
    };
    // Parsed claims are only a lookup hint, never a source of trust.
    let parsed =
        Authorization::decode(encoded).map_err(|_| denied("invalid runtime authorization"))?;
    // Respect the existing lock order: community lifecycle before any row
    // locks. Otherwise a concurrent whole-community fence could deadlock with
    // this transaction holding a community row while waiting for its lock.
    sqlx::query("SELECT assert_community_write_allowed($1)")
        .bind(community.as_uuid())
        .execute(&mut **tx)
        .await?;
    let trusted = sqlx::query(
        "SELECT c.host, i.public_key FROM managed_runtime_issuers i \
         JOIN communities c ON c.id = i.community_id \
         WHERE i.community_id = $1 AND i.issuer = $2 AND i.key_id = $3 \
         FOR SHARE OF i, c",
    )
    .bind(community.as_uuid())
    .bind(&parsed.claims.issuer)
    .bind(&parsed.claims.key_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| denied("untrusted runtime issuer"))?;
    let host: String = trusted.try_get("host")?;
    let public_key: Vec<u8> = trusted.try_get("public_key")?;
    let public_key: [u8; 32] = public_key
        .try_into()
        .map_err(|_| denied("invalid trusted runtime key"))?;
    let trust = TrustedIssuer {
        community,
        audience: &host,
        issuer: &parsed.claims.issuer,
        key_id: &parsed.claims.key_id,
        public_key: &public_key,
    };
    let verified = if is_cancel {
        event
            .verify()
            .map_err(|_| denied("invalid cancellation signature"))?;
        let verified = VerifiedAuthorization::cancellation(encoded, trust)
            .map_err(|_| denied("invalid cancellation authority"))?;
        let expected = [
            vec!["h".to_owned(), verified.claims().channel_id.clone()],
            vec![
                "d".to_owned(),
                format!("buzz-user-cancellation:{}", verified.claims().scope_id),
            ],
        ];
        // No reply, mention, broadcast, or user-controlled routing on controls.
        if event
            .tags
            .iter()
            .map(|tag| tag.as_slice())
            .collect::<Vec<_>>()
            != expected.iter().map(Vec::as_slice).collect::<Vec<_>>()
        {
            return Err(denied("invalid cancellation routing"));
        }
        verified
    } else {
        VerifiedAuthorization::publication(event, trust)
            .map_err(|_| denied("invalid publication authority"))?
    };
    if verified.community() != community
        || channel_id != Some(uuid(&verified.claims().channel_id)?)
        || (!is_cancel && verified.publication_event_id() != Some(event.id))
    {
        return Err(denied("managed authorization identity mismatch"));
    }
    let claims = verified.claims();
    let scope_id = uuid(&claims.scope_id)?;
    let requester = bytes(&claims.requester_public_key)?;
    let request = bytes(&claims.request_event_id)?;
    sqlx::query(
        "INSERT INTO managed_publication_scopes \
         (community_id, issuer, scope_kind, scope_id, channel_id, requester_pubkey, request_event_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING",
    )
    .bind(community.as_uuid())
    .bind(&claims.issuer)
    .bind(scope_kind(claims))
    .bind(scope_id)
    .bind(channel_id)
    .bind(&requester)
    .bind(&request)
    .execute(&mut **tx)
    .await?;
    // Both Stop and all participants' publications serialize on this row.
    // A Stop arriving first creates it, so a delayed permit cannot reset Stop.
    let scope = sqlx::query(
        "SELECT channel_id, requester_pubkey, request_event_id, cancelled_at \
         FROM managed_publication_scopes \
         WHERE community_id = $1 AND issuer = $2 AND scope_kind = $3 AND scope_id = $4 FOR UPDATE",
    )
    .bind(community.as_uuid())
    .bind(&claims.issuer)
    .bind(scope_kind(claims))
    .bind(scope_id)
    .fetch_one(&mut **tx)
    .await?;
    if Some(scope.try_get::<Uuid, _>("channel_id")?) != channel_id
        || scope.try_get::<Vec<u8>, _>("requester_pubkey")? != requester
        || scope.try_get::<Vec<u8>, _>("request_event_id")? != request
    {
        return Err(denied("managed scope identity changed"));
    }
    let cancelled_at: Option<DateTime<Utc>> = scope.try_get("cancelled_at")?;
    match &claims.action {
        Operation::Cancel {
            user_request_event_id,
        } => {
            if let Some(cancelled_at) = cancelled_at {
                return Ok(Some(cancelled_at));
            }
            let cancelled_at = sqlx::query_scalar(
                "UPDATE managed_publication_scopes SET cancelled_at = clock_timestamp(), \
                 cancellation_event_id = $5, cancellation_user_event_id = $6, cancellation_authorization = $7 \
                 WHERE community_id = $1 AND issuer = $2 AND scope_kind = $3 AND scope_id = $4 \
                 RETURNING cancelled_at",
            )
            .bind(community.as_uuid())
            .bind(&claims.issuer)
            .bind(scope_kind(claims))
            .bind(scope_id)
            .bind(event.id.as_bytes().as_slice())
            .bind(bytes(user_request_event_id)?)
            .bind(encoded)
            .fetch_one(&mut **tx)
            .await?;
            Ok(Some(cancelled_at))
        }
        Operation::Publish {
            receipt_id,
            fence_id,
            signer_public_key,
            ..
        } => {
            let receipt_id = uuid(receipt_id)?;
            let signer = bytes(signer_public_key)?;
            sqlx::query(
                "INSERT INTO managed_publication_receipts \
                 (community_id, issuer, receipt_id, scope_kind, scope_id, signer_pubkey) \
                 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
            )
            .bind(community.as_uuid())
            .bind(&claims.issuer)
            .bind(receipt_id)
            .bind(scope_kind(claims))
            .bind(scope_id)
            .bind(&signer)
            .execute(&mut **tx)
            .await?;
            let receipt = sqlx::query(
                "SELECT scope_kind, scope_id, signer_pubkey FROM managed_publication_receipts \
                 WHERE community_id = $1 AND issuer = $2 AND receipt_id = $3 FOR UPDATE",
            )
            .bind(community.as_uuid())
            .bind(&claims.issuer)
            .bind(receipt_id)
            .fetch_one(&mut **tx)
            .await?;
            if receipt.try_get::<String, _>("scope_kind")? != scope_kind(claims)
                || receipt.try_get::<Uuid, _>("scope_id")? != scope_id
                || receipt.try_get::<Vec<u8>, _>("signer_pubkey")? != signer
            {
                return Err(denied("managed receipt identity changed"));
            }
            let fence_id = uuid(fence_id)?;
            let accepted = sqlx::query(
                "SELECT receipt_id, event_id, runtime_authorization, accepted_at FROM managed_publications \
                 WHERE community_id = $1 AND issuer = $2 AND fence_id = $3",
            )
            .bind(community.as_uuid())
            .bind(&claims.issuer)
            .bind(fence_id)
            .fetch_optional(&mut **tx)
            .await?;
            if let Some(accepted) = accepted {
                if accepted.try_get::<Uuid, _>("receipt_id")? != receipt_id
                    || accepted.try_get::<Vec<u8>, _>("event_id")? != event.id.as_bytes().as_slice()
                    || accepted.try_get::<String, _>("runtime_authorization")? != encoded
                {
                    return Err(denied("managed publication fence changed"));
                }
                return Ok(Some(accepted.try_get("accepted_at")?));
            }
            if cancelled_at.is_some() {
                return Err(denied("managed publication cancelled by user"));
            }
            sqlx::query(
                "INSERT INTO managed_publications \
                 (community_id, issuer, fence_id, receipt_id, event_id, runtime_authorization) \
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(community.as_uuid())
            .bind(&claims.issuer)
            .bind(fence_id)
            .bind(receipt_id)
            .bind(event.id.as_bytes().as_slice())
            .bind(encoded)
            .execute(&mut **tx)
            .await?;
            Ok(None)
        }
    }
}

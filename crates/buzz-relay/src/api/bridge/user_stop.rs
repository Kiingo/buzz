//! Strict Stop-only extension of the authenticated Nostr query bridge.
//! Returned values are the original signed events, never synthesized controls.

use axum::{http::StatusCode, Json};
use buzz_core::TenantContext;
use buzz_db::Db;
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::api::{api_error, internal_error};

type QueryResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Filter {
    user_stop: bool,
    kinds: Vec<u16>,
    #[serde(rename = "#h")]
    channels: Vec<Uuid>,
    #[serde(rename = "#e")]
    roots: Vec<String>,
    authors: Vec<String>,
    since: u64,
    limit: Option<u16>,
}

struct Scope {
    channel: Uuid,
    roots: Vec<Vec<u8>>,
    author: [u8; 32],
    since: chrono::DateTime<chrono::Utc>,
    limit: u16,
}

fn parse(raw: &[Value]) -> Option<Result<Scope, &'static str>> {
    if !raw.iter().any(|filter| filter.get("user_stop").is_some()) {
        return None;
    }
    Some((|| {
        if raw.len() != 1 {
            return Err("user_stop requires one unmixed scoped filter");
        }
        let filter: Filter =
            serde_json::from_value(raw[0].clone()).map_err(|_| "invalid user_stop filter")?;
        let limit = filter.limit.unwrap_or(16);
        if !filter.user_stop
            || filter.kinds != [9]
            || filter.channels.len() != 1
            || filter.authors.len() != 1
            || filter.roots.is_empty()
            || filter.roots.len() > 2
            || !(1..=16).contains(&limit)
        {
            return Err("user_stop requires kind 9, one channel/author, and one or two roots");
        }
        let roots = filter
            .roots
            .iter()
            .map(|root| {
                let bytes = hex::decode(root).map_err(|_| "invalid user_stop root")?;
                if bytes.len() != 32 {
                    return Err("invalid user_stop root");
                }
                Ok(bytes)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let author = nostr::PublicKey::from_hex(&filter.authors[0])
            .map_err(|_| "invalid user_stop author")?
            .to_bytes();
        let since = i64::try_from(filter.since)
            .ok()
            .and_then(|value| chrono::DateTime::from_timestamp(value, 0))
            .ok_or("invalid user_stop since")?;
        Ok(Scope {
            channel: filter.channels[0],
            roots,
            author,
            since,
            limit,
        })
    })())
}

/// Called only after normal host, NIP-98, admission, replay, membership, and
/// accessible-channel checks. A Stop query cannot fall through to chat/search.
pub(super) async fn query(
    db: &Db,
    tenant: &TenantContext,
    raw: &[Value],
    accessible_channels: &[Uuid],
) -> Option<QueryResult> {
    let scope = match parse(raw)? {
        Ok(scope) => scope,
        Err(message) => return Some(Err(api_error(StatusCode::BAD_REQUEST, message))),
    };
    if !accessible_channels.contains(&scope.channel) {
        return Some(Err(api_error(
            StatusCode::FORBIDDEN,
            "restricted: not a channel member",
        )));
    }
    Some(
        async {
            let events = db
                .query_user_stop_events(
                    tenant.community(),
                    scope.channel,
                    &scope.author,
                    &scope.roots,
                    scope.since,
                    scope.limit,
                )
                .await
                .map_err(|_| internal_error("Stop query unavailable"))?;
            let values = events
                .into_iter()
                .map(|stored| serde_json::to_value(stored.event))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| internal_error("invalid retained Stop event"))?;
            Ok(Json(Value::Array(values)))
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn filter() -> Value {
        json!({ "user_stop": true, "kinds": [9],
            "#h": ["30000000-0000-4000-8000-000000000001"],
            "#e": ["a".repeat(64)],
            "authors": [nostr::Keys::generate().public_key().to_hex()],
            "since": 1788968083, "limit": 16 })
    }

    #[test]
    fn scoped_filter_preserves_exact_author_root_and_since() {
        let value = filter();
        let scope = parse(std::slice::from_ref(&value)).unwrap().unwrap();
        assert_eq!(scope.roots, vec![vec![0xaa; 32]]);
        assert_eq!(hex::encode(scope.author), value["authors"][0]);
        assert_eq!(scope.since.timestamp(), 1788968083);
        assert_eq!(scope.limit, 16);
        assert!(parse(&[json!({"kinds": [9]})]).is_none());
    }

    #[test]
    fn malformed_or_mixed_extension_never_falls_through_to_chat() {
        for (key, value) in [
            ("user_stop", json!(false)),
            ("kinds", json!([1, 9])),
            ("#h", json!([])),
            ("#e", json!(["bad"])),
            ("authors", json!([])),
            ("since", json!(u64::MAX)),
            ("limit", json!(0)),
            ("limit", json!(17)),
            ("before_id", json!("b".repeat(64))),
            ("search", json!("cancel")),
            ("top_level", json!(true)),
        ] {
            let mut candidate = filter();
            candidate[key] = value;
            assert!(parse(&[candidate]).unwrap().is_err(), "{key}");
        }
        assert!(parse(&[filter(), json!({"kinds": [9]})]).unwrap().is_err());
    }

    #[tokio::test]
    async fn extension_denies_inaccessible_channels_before_store_access() {
        // No database is running or contacted: every denial must happen before
        // the query reaches storage, using current caller access, not author identity.
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://stop_test@127.0.0.1:1/buzz_user_stop_test")
            .unwrap();
        let db = Db::from_pool(pool);
        let tenant = TenantContext::resolved(
            buzz_core::CommunityId::from_uuid(Uuid::new_v4()),
            "stop.test",
        );
        for accessible in [vec![], vec![Uuid::new_v4()]] {
            let error = query(&db, &tenant, &[filter()], &accessible)
                .await
                .unwrap()
                .unwrap_err();
            assert_eq!(error.0, StatusCode::FORBIDDEN);
        }
        let error = query(&db, &tenant, &[filter(), filter()], &[])
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert!(query(&db, &tenant, &[json!({"kinds": [9]})], &[])
            .await
            .is_none());
    }
}

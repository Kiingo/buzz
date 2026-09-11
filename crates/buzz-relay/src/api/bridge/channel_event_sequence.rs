//! Explicit commit-ordered extension of the normal authenticated query bridge.

use axum::{http::StatusCode, Json};
use buzz_core::TenantContext;
use buzz_db::{channel_event_sequence::valid_channel_sequence, Db};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::api::{api_error, internal_error};

type QueryResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Filter {
    channel_sequence_after: String,
    kinds: Vec<u16>,
    #[serde(rename = "#h")]
    channels: Vec<Uuid>,
    limit: Option<u16>,
}

fn parse(raw: &[Value]) -> Option<Result<Filter, &'static str>> {
    if !raw
        .iter()
        .any(|filter| filter.get("channel_sequence_after").is_some())
    {
        return None;
    }
    Some((|| {
        if raw.len() != 1 {
            return Err("channel sequence requires one unmixed filter");
        }
        let filter: Filter = serde_json::from_value(raw[0].clone())
            .map_err(|_| "invalid channel sequence filter")?;
        if filter.kinds != [9]
            || filter.channels.len() != 1
            || !valid_channel_sequence(&filter.channel_sequence_after)
            || !(1..=64).contains(&filter.limit.unwrap_or(64))
        {
            return Err("channel sequence requires kind 9, one channel and a decimal cursor");
        }
        Ok(filter)
    })())
}

/// Invoked after the normal host, NIP-98, replay, admission and membership gates.
/// This explicit extension never falls through to timestamp/search semantics.
pub(super) async fn query(
    db: &Db,
    tenant: &TenantContext,
    raw: &[Value],
    accessible_channels: &[Uuid],
) -> Option<QueryResult> {
    let filter = match parse(raw)? {
        Ok(filter) => filter,
        Err(message) => return Some(Err(api_error(StatusCode::BAD_REQUEST, message))),
    };
    let channel = filter.channels[0];
    if !accessible_channels.contains(&channel) {
        return Some(Err(api_error(
            StatusCode::FORBIDDEN,
            "restricted: not a channel member",
        )));
    }
    Some(
        async {
            let events = db
                .query_channel_event_sequence(
                    tenant.community(),
                    channel,
                    &filter.channel_sequence_after,
                    filter.limit.unwrap_or(64),
                )
                .await
                .map_err(|_| internal_error("channel sequence query unavailable"))?;
            Ok(Json(Value::Array(
                events
                    .into_iter()
                    .map(|item| {
                        json!({
                            "sequence": item.sequence, "event": item.stored.event,
                        })
                    })
                    .collect(),
            )))
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter() -> Value {
        json!({"channel_sequence_after":"0", "kinds":[9],
            "#h":["30000000-0000-4000-8000-000000000001"], "limit":64})
    }

    #[test]
    fn channel_sequence_contract_is_explicit_scoped_and_lossless() {
        assert!(parse(&[filter()]).unwrap().is_ok());
        assert!(parse(&[json!({"kinds":[9]})]).is_none());
        assert!(parse(&[filter(), filter()]).unwrap().is_err());
        for (key, value) in [
            ("channel_sequence_after", json!(0)),
            ("channel_sequence_after", json!("01")),
            ("channel_sequence_after", json!("-1")),
            ("channel_sequence_after", json!("1e3")),
            ("kinds", json!([9, 24201])),
            ("#h", json!([])),
            ("limit", json!(0)),
            ("limit", json!(65)),
            ("since", json!(10)),
            ("authors", json!(["f".repeat(64)])),
            ("user_stop", json!(true)),
        ] {
            let mut bad = filter();
            bad[key] = value;
            assert!(parse(&[bad]).unwrap().is_err(), "{key}");
        }
        let mut large = filter();
        large["channel_sequence_after"] = json!("18446744073709551616000000000000000000001");
        assert!(parse(&[large]).unwrap().is_ok());
    }

    #[tokio::test]
    async fn channel_sequence_denies_foreign_channels_before_any_database_read() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://sequence_test@127.0.0.1:1/buzz_channel_sequence_test")
            .unwrap();
        let db = Db::from_pool(pool);
        let tenant = TenantContext::resolved(
            buzz_core::CommunityId::from_uuid(Uuid::new_v4()),
            "sequence.test",
        );
        for accessible in [vec![], vec![Uuid::new_v4()]] {
            let error = query(&db, &tenant, &[filter()], &accessible)
                .await
                .unwrap()
                .unwrap_err();
            assert_eq!(error.0, StatusCode::FORBIDDEN);
        }
        assert!(query(&db, &tenant, &[json!({"kinds":[9]})], &[])
            .await
            .is_none());
    }
}

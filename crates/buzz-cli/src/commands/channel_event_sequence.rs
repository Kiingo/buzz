//! Bounded commit-ordered reads through the existing authenticated query bridge.

use crate::{client::BuzzClient, error::CliError, validate::parse_uuid};
use serde_json::{json, Value};

fn filter(channel: &str, after: &str, limit: u16) -> Result<Value, CliError> {
    let channel = parse_uuid(channel)?;
    let valid = after == "0"
        || (after.starts_with(|c: char| matches!(c, '1'..='9'))
            && after.bytes().all(|c| c.is_ascii_digit()));
    if !valid || !(1..=64).contains(&limit) {
        return Err(CliError::Usage(
            "sequence requires a decimal cursor and limit 1..64".into(),
        ));
    }
    Ok(json!({"channel_sequence_after":after, "kinds":[9], "#h":[channel], "limit":limit}))
}

/// Print an array of `{sequence,event}` records without compacting signed proof.
/// Reading does not acknowledge input; save a cursor only after durable admission.
pub async fn read(
    client: &BuzzClient,
    channel: &str,
    after: &str,
    limit: u16,
) -> Result<(), CliError> {
    let raw = client.query(&filter(channel, after, limit)?).await?;
    let records: Vec<Value> = serde_json::from_str(&raw)
        .map_err(|_| CliError::Other("invalid channel sequence response".into()))?;
    if records.len() > usize::from(limit) {
        return Err(CliError::Other(
            "channel sequence exceeded requested limit".into(),
        ));
    }
    println!("{}", Value::Array(records));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_sequence_filter_keeps_exact_positions_and_channel_scope() {
        let channel = "30000000-0000-4000-8000-000000000001";
        let after = "18446744073709551616000000000000000000001";
        assert_eq!(
            filter(channel, after, 64).unwrap(),
            json!({
                "channel_sequence_after":after,"kinds":[9],"#h":[channel],"limit":64,
            })
        );
        for value in ["", "01", "-1", "+1", "1e3", "1.0", " 1", "1 "] {
            assert!(filter(channel, value, 64).is_err());
        }
        for limit in [0, 65] {
            assert!(filter(channel, "0", limit).is_err());
        }
        assert!(filter("not-a-channel", "0", 64).is_err());
    }
}

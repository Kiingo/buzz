//! Pure parts of "Confirm key replacement": the read-only lookup proof, the
//! lookup answer, the relay role and archive state, and whether to offer the
//! control at all.

use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, Tag, Timestamp};
use serde::Serialize;
use serde_json::{json, Value};

pub(super) const OWNER_PROOF_KIND: u16 = 27_236;
pub(super) const OWNER_PROOF_CONTENT: &str = "buzz-provider-owner-v1";
pub(super) const OWNER_PROOF_TTL_SECONDS: u64 = 5 * 60;
pub(super) const KIND_RELAY_MEMBERS: u16 = 13_534;
pub(super) const KIND_ARCHIVE_SNAPSHOT: u16 = 13_535;
pub(super) const KIND_ARCHIVE_DELTA: u16 = 8_002;
/// Reason code on the archive request; desktop key rotation uses the same.
pub(super) const ARCHIVE_REASON: &str = "rotated";

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn has_tag(event: &Event, name: &str, value: &str) -> bool {
    event.tags.iter().any(|tag| {
        let values = tag.as_slice();
        values.first().map(String::as_str) == Some(name)
            && values
                .get(1)
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(value))
    })
}

/// Lookup body: the list-shaped, read-only owner proof with exactly
/// `action=key_replacement`, `provider`, `request`, `community`, `expires`.
pub(super) fn build_lookup_request(
    owner: &Keys,
    provider_id: &str,
    community_id: &str,
    request_id: &str,
    now: u64,
) -> Result<Value, String> {
    let mut tags = Vec::with_capacity(5);
    for (name, value) in [
        ("action", "key_replacement".to_string()),
        ("provider", provider_id.to_string()),
        ("request", request_id.to_string()),
        ("community", community_id.to_string()),
        ("expires", (now + OWNER_PROOF_TTL_SECONDS).to_string()),
    ] {
        tags.push(
            Tag::parse([name.to_string(), value]).map_err(|_| "owner_proof_invalid".to_string())?,
        );
    }
    let proof = EventBuilder::new(Kind::Custom(OWNER_PROOF_KIND), OWNER_PROOF_CONTENT)
        .tags(tags)
        .custom_created_at(Timestamp::from(now))
        .sign_with_keys(owner)
        .map_err(|_| "owner_proof_invalid".to_string())?;
    let proof: Value =
        serde_json::from_str(&proof.as_json()).map_err(|_| "owner_proof_invalid".to_string())?;
    Ok(json!({
        "contract_version": 1,
        "request_id": request_id,
        "owner_proof": proof,
    }))
}

/// The earlier key the hosted service verified for the same person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Replacement {
    pub(crate) old_public_key: String,
    pub(crate) revoked_at: Option<String>,
}

/// The hosted lookup answer for the signed-in key.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct LookupAnswer {
    pub(crate) replacement: Option<Replacement>,
    /// A relay owner key this person retired, named only for the key the
    /// service verified as its successor.
    pub(crate) retired_relay_owner: Option<String>,
}

fn optional_hex_key(body: &Value, field: &str) -> Result<Option<String>, String> {
    match body.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_str()
            .map(str::to_ascii_lowercase)
            .filter(|key| is_hex64(key))
            .map(Some)
            .ok_or_else(|| "response_invalid".to_string()),
    }
}

/// Parse a lookup answer to `request_id` for `current_public_key`.
pub(super) fn parse_lookup_response(
    body: &Value,
    request_id: &str,
    current_public_key: &str,
) -> Result<LookupAnswer, String> {
    let owner_matches = body
        .get("owner_public_key")
        .and_then(Value::as_str)
        .is_some_and(|owner| owner.eq_ignore_ascii_case(current_public_key));
    if body.get("contract_version") != Some(&json!(1))
        || body.get("correlation_id").and_then(Value::as_str) != Some(request_id)
        || !owner_matches
    {
        return Err("response_invalid".into());
    }
    let replacement = match body.get("replacement") {
        None | Some(Value::Null) => None,
        Some(replacement) => {
            let old = optional_hex_key(replacement, "old_public_key")?.ok_or("response_invalid")?;
            if old.eq_ignore_ascii_case(current_public_key) {
                return Err("response_invalid".into());
            }
            let revoked_at = replacement
                .get("revoked_at")
                .and_then(Value::as_str)
                .filter(|value| value.len() <= 64 && !value.chars().any(char::is_control))
                .map(str::to_string);
            Some(Replacement {
                old_public_key: old,
                revoked_at,
            })
        }
    };
    Ok(LookupAnswer {
        replacement,
        // Kept even when it names the signed-in key: the removal step then
        // shows disabled with a reason instead of disappearing silently.
        retired_relay_owner: optional_hex_key(body, "retired_relay_owner_public_key")?,
    })
}

/// `pubkey`'s role in a relay membership snapshot (`member` tags, then the
/// NIP-29 `p` fallback), or `None` when it is not a member.
pub(super) fn relay_role(snapshot: &Event, pubkey: &str) -> Option<String> {
    for tag in snapshot.tags.iter() {
        let values = tag.as_slice();
        if values.first().map(String::as_str) == Some("member")
            && values
                .get(1)
                .is_some_and(|value| value.eq_ignore_ascii_case(pubkey))
        {
            return Some(
                values
                    .get(2)
                    .filter(|role| !role.is_empty())
                    .cloned()
                    .unwrap_or_else(|| "member".into()),
            );
        }
    }
    for tag in snapshot.tags.iter() {
        let values = tag.as_slice();
        if values.first().map(String::as_str) == Some("p")
            && values
                .get(1)
                .is_some_and(|value| value.eq_ignore_ascii_case(pubkey))
        {
            return Some(
                values
                    .get(3)
                    .filter(|role| !role.is_empty())
                    .cloned()
                    .unwrap_or_else(|| "member".into()),
            );
        }
    }
    None
}

/// The newest membership snapshot signed by the relay identity `relay_self`.
pub(super) fn relay_members_snapshot<'a>(
    events: &'a [Event],
    relay_self: &str,
) -> Option<&'a Event> {
    events
        .iter()
        .filter(|event| {
            event.kind.as_u16() == KIND_RELAY_MEMBERS
                && event.pubkey.to_hex().eq_ignore_ascii_case(relay_self)
                && event.verify().is_ok()
        })
        .max_by_key(|event| event.created_at)
}

/// Whether `pubkey` is a relay owner or admin according to the newest
/// membership snapshot signed by the relay identity `relay_self`.
pub(super) fn is_relay_admin(events: &[Event], relay_self: &str, pubkey: &str) -> bool {
    relay_members_snapshot(events, relay_self)
        .and_then(|snapshot| relay_role(snapshot, pubkey))
        .is_some_and(|role| role == "owner" || role == "admin")
}

/// The "Remove old owner key" step: which key, and whether it may run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemovalStep {
    pub(crate) public_key: String,
    pub(crate) removable: bool,
    /// Why it may not run: `is_current_key`, `not_owner`, `not_a_member`
    /// or `is_owner`.
    pub(crate) reason: Option<String>,
}

/// Decide the removal step from the hosted value and the relay-signed
/// membership snapshot. No hosted value: no step. Otherwise every check must
/// agree, or the step is shown disabled with the first reason that failed.
pub(super) fn removal_step(
    retired: Option<&str>,
    current: &str,
    snapshot: Option<&Event>,
) -> Option<RemovalStep> {
    let retired = retired?.to_ascii_lowercase();
    let current_role = snapshot.and_then(|snapshot| relay_role(snapshot, current));
    let retired_role = snapshot.and_then(|snapshot| relay_role(snapshot, &retired));
    let reason = if retired.eq_ignore_ascii_case(current) {
        Some("is_current_key")
    } else if current_role.as_deref() != Some("owner") {
        Some("not_owner")
    } else if retired_role.is_none() {
        Some("not_a_member")
    } else if retired_role.as_deref() == Some("owner") {
        Some("is_owner")
    } else {
        None
    };
    Some(RemovalStep {
        public_key: retired,
        removable: reason.is_none(),
        reason: reason.map(str::to_string),
    })
}

/// What the relay says about the old key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ArchiveState {
    /// Not in the relay-signed archive snapshot.
    NotArchived,
    /// Archived, and a relay-signed delta names `replacement` as successor.
    ArchivedReplacedBy,
    /// Archived without that successor (another one, or none).
    ArchivedOther,
}

/// Read the archive state of `old` from relay-signed NIP-IA events: the
/// newest valid kind 13535 snapshot by `relay_self`, and kind 8002 deltas by
/// the same relay for the successor pointer (the snapshot has bare `p` tags).
pub(super) fn archive_state(
    events: &[Event],
    relay_self: &str,
    old: &str,
    replacement: &str,
) -> ArchiveState {
    let by_relay = |event: &&Event| {
        event.pubkey.to_hex().eq_ignore_ascii_case(relay_self) && event.verify().is_ok()
    };
    let archived = events
        .iter()
        .filter(|event| event.kind.as_u16() == KIND_ARCHIVE_SNAPSHOT)
        .filter(by_relay)
        .max_by_key(|event| event.created_at)
        .is_some_and(|snapshot| has_tag(snapshot, "p", old));
    if !archived {
        return ArchiveState::NotArchived;
    }
    let pointer = events
        .iter()
        .filter(|event| event.kind.as_u16() == KIND_ARCHIVE_DELTA)
        .filter(by_relay)
        .any(|delta| has_tag(delta, "p", old) && has_tag(delta, "replaced-by", replacement));
    if pointer {
        ArchiveState::ArchivedReplacedBy
    } else {
        ArchiveState::ArchivedOther
    }
}

/// Offer the control only when all three hold: the signed-in key is a relay
/// owner or admin, the hosted service names a replaced key, and the relay
/// does not already list that key as archived.
pub(super) fn should_offer(
    relay_admin: bool,
    replacement: Option<&Replacement>,
    archive: ArchiveState,
) -> bool {
    relay_admin && replacement.is_some() && archive == ArchiveState::NotArchived
}

#[cfg(test)]
#[path = "logic_tests.rs"]
mod tests;

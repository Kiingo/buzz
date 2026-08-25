use std::collections::{BTreeMap, HashMap};

use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind};
use reqwest::Method;
use serde::Serialize;

use crate::{
    app_state::AppState,
    events,
    relay::{
        build_nip98_auth_header_for_keys, classify_request_error, parse_json_response,
        query_relay_at_with_keys, relay_error_message, relay_http_base_url,
        submit_event_at_with_keys, SubmitEventResponse,
    },
};

use super::{crypto::sha256_hex, journal::ContinuityJournal};

fn guarded_event_body(event: &Event) -> Result<Vec<u8>, String> {
    let body = event.as_json().into_bytes();
    crate::egress_guard::assert_no_key_backup_bytes(&body, "identity rotation relay event")?;
    Ok(body)
}

async fn submit_signed_event_at_with_keys_and_auth(
    event: &Event,
    state: &AppState,
    api_base_url: &str,
    keys: &Keys,
    auth_tag: Option<&str>,
) -> Result<SubmitEventResponse, String> {
    if event.pubkey != keys.public_key() {
        return Err("signed event does not match the publishing identity".to_string());
    }
    crate::relay_admission::wait_for_rate_limit().await;
    let url = format!("{}/events", api_base_url.trim_end_matches('/'));
    let body = guarded_event_body(event)?;
    let auth = build_nip98_auth_header_for_keys(keys, &Method::POST, &url, &body)?;
    let mut request = state
        .http_client
        .post(&url)
        .header("Authorization", auth)
        .header("Content-Type", "application/json")
        .body(body);
    if let Some(tag) = auth_tag {
        request = request.header("x-auth-tag", tag);
    }
    let response = request
        .send()
        .await
        .map_err(|error| classify_request_error(&error))?;
    if !response.status().is_success() {
        return Err(relay_error_message(response).await);
    }
    let result: SubmitEventResponse = parse_json_response(response).await?;
    if !result.accepted {
        return Err(format!("relay rejected event: {}", result.message));
    }
    Ok(result)
}

async fn submit_event_at_with_keys_and_auth(
    builder: EventBuilder,
    state: &AppState,
    api_base_url: &str,
    keys: &Keys,
    auth_tag: Option<&str>,
) -> Result<SubmitEventResponse, String> {
    let event = builder
        .sign_with_keys(keys)
        .map_err(|error| format!("failed to sign event: {error}"))?;
    submit_signed_event_at_with_keys_and_auth(&event, state, api_base_url, keys, auth_tag).await
}

pub(crate) struct RotationIdentity<'a> {
    pub old: &'a Keys,
    pub new: &'a Keys,
    pub old_auth_tag: Option<&'a str>,
    pub new_auth_tag: Option<&'a str>,
}

fn relay_role(event: &Event, public_key: &str) -> Option<String> {
    for tag in event.tags.iter() {
        let values = tag.as_slice();
        if values.first().map(String::as_str) == Some("member")
            && values.get(1).map(String::as_str) == Some(public_key)
        {
            return Some(values.get(2).cloned().unwrap_or_else(|| "member".into()));
        }
        if values.first().map(String::as_str) == Some("p")
            && values.get(1).map(String::as_str) == Some(public_key)
        {
            return Some(values.get(3).cloned().unwrap_or_else(|| "member".into()));
        }
    }
    None
}

fn channel_roles(events: &[Event], public_key: &str) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    for event in events {
        let channel = event.tags.iter().find_map(|tag| {
            let values = tag.as_slice();
            (values.first().map(String::as_str) == Some("d"))
                .then(|| values.get(1).cloned())
                .flatten()
        });
        let role = event.tags.iter().find_map(|tag| {
            let values = tag.as_slice();
            if values.first().map(String::as_str) != Some("p")
                || values.get(1).map(String::as_str) != Some(public_key)
            {
                return None;
            }
            Some(
                values
                    .get(3)
                    .or_else(|| values.get(2))
                    .filter(|value| !value.is_empty())
                    .cloned()
                    .unwrap_or_else(|| "member".into()),
            )
        });
        if let (Some(channel), Some(role)) = (channel, role) {
            result.insert(channel, role);
        }
    }
    result
}

fn cloned_profile_event(
    source: &Event,
    replacement: &Keys,
    replacement_auth_tag: Option<&str>,
) -> Result<Event, String> {
    let mut builder = EventBuilder::new(Kind::Metadata, source.content.clone());
    if let Some(raw) = replacement_auth_tag {
        let auth: [String; 4] = serde_json::from_str(raw)
            .map_err(|_| "identity_rotation_agent_auth_invalid".to_string())?;
        builder = builder.tags([nostr::Tag::parse(auth)
            .map_err(|_| "identity_rotation_agent_auth_invalid".to_string())?]);
    }
    builder
        .sign_with_keys(replacement)
        .map_err(|_| "identity_rotation_profile_sign_failed".to_string())
}

fn rebuilt_memory_event(
    prior: &Event,
    body: &buzz_core_pkg::engram::Body,
    replacement_agent: &Keys,
    replacement_owner: &Keys,
    now: u64,
) -> Result<Event, String> {
    let created_at = now.max(prior.created_at.as_secs().saturating_add(1));
    buzz_core_pkg::engram::build_event(
        replacement_agent,
        &replacement_owner.public_key(),
        body,
        created_at,
    )
    .map_err(|_| "identity_rotation_memory_encrypt_failed".to_string())
}

async fn verify_relay_role(
    state: &AppState,
    base: &str,
    keys: &Keys,
    public_key: &str,
    expected_role: &str,
) -> Result<(), String> {
    let events = query_relay_at_with_keys(
        state,
        base,
        &[serde_json::json!({"kinds": [13534], "limit": 1})],
        keys,
        None,
    )
    .await?;
    if events
        .first()
        .and_then(|event| relay_role(event, public_key))
        .as_deref()
        != Some(expected_role)
    {
        return Err("identity_rotation_relay_membership_verification_failed".into());
    }
    Ok(())
}

async fn relay_membership_snapshot(
    state: &AppState,
    base: &str,
    keys: &Keys,
) -> Result<Event, String> {
    query_relay_at_with_keys(
        state,
        base,
        &[serde_json::json!({"kinds": [13534], "limit": 1})],
        keys,
        None,
    )
    .await?
    .into_iter()
    .next()
    .ok_or_else(|| "identity_rotation_relay_membership_snapshot_missing".to_string())
}

async fn wait_for_relay_role(
    state: &AppState,
    base: &str,
    keys: &Keys,
    public_key: &str,
    expected_role: &str,
) -> Result<(), String> {
    for _ in 0..30 {
        let snapshot = relay_membership_snapshot(state, base, keys).await?;
        match relay_role(&snapshot, public_key).as_deref() {
            Some(role) if role == expected_role => return Ok(()),
            Some(_) => return Err("identity_rotation_relay_membership_role_conflict".into()),
            None => tokio::time::sleep(std::time::Duration::from_secs(2)).await,
        }
    }
    Err("identity_rotation_membership_controller_timeout".into())
}

async fn wait_for_relay_absence(
    state: &AppState,
    base: &str,
    keys: &Keys,
    public_key: &str,
) -> Result<(), String> {
    for _ in 0..30 {
        let snapshot = relay_membership_snapshot(state, base, keys).await?;
        if relay_role(&snapshot, public_key).is_none() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    Err("identity_rotation_membership_controller_timeout".into())
}

#[derive(Debug, Eq, PartialEq)]
enum RelayMembershipTransition {
    Ready,
    WaitForRole(String),
    WaitForAbsence,
}

fn relay_membership_transition(
    source_role: Option<&str>,
    replacement_role: Option<&str>,
) -> Result<RelayMembershipTransition, String> {
    match (source_role, replacement_role) {
        (Some(source), Some(replacement)) if source == replacement => {
            Ok(RelayMembershipTransition::Ready)
        }
        (Some(_), Some(_)) => Err("identity_rotation_relay_membership_role_conflict".into()),
        (Some(source), None) => Ok(RelayMembershipTransition::WaitForRole(source.to_string())),
        (None, Some(_)) => Ok(RelayMembershipTransition::WaitForAbsence),
        (None, None) => Ok(RelayMembershipTransition::Ready),
    }
}

/// Prove that the committed owner key can authenticate to the pinned relay
/// and read back its authoritative membership snapshot. The HTTP request is
/// NIP-98 signed by the supplied key, and the returned snapshot is also
/// signature-verified before the canary succeeds.
pub(crate) async fn signed_owner_relay_canary(
    state: &AppState,
    relay_url: &str,
    owner: &Keys,
) -> Result<(), String> {
    let base = relay_http_base_url(relay_url);
    let events = query_relay_at_with_keys(
        state,
        &base,
        &[serde_json::json!({"kinds": [13534], "limit": 1})],
        owner,
        None,
    )
    .await?;
    let snapshot = events
        .first()
        .ok_or_else(|| "identity_rotation_relay_canary_missing".to_string())?;
    snapshot
        .verify()
        .map_err(|_| "identity_rotation_relay_canary_invalid".to_string())?;
    if relay_role(snapshot, &owner.public_key().to_hex()).is_none() {
        return Err("identity_rotation_relay_canary_denied".into());
    }
    Ok(())
}

/// Mirror the replacement identities to the old identities' exact relay and
/// channel access while the old owner is still authoritative. Direct relay
/// membership is optional for NIP-OA agents, so authoritative absence is
/// preserved just as strictly as an explicit role.
pub(crate) async fn migrate_memberships(
    state: &AppState,
    relay_url: &str,
    owner: &RotationIdentity<'_>,
    identities: &[RotationIdentity<'_>],
) -> Result<(u32, u32), String> {
    let base = relay_http_base_url(relay_url);
    let mut relay_count = 0u32;
    let mut channel_count = 0u32;
    for identity in identities {
        let old_public_key = identity.old.public_key().to_hex();
        let new_public_key = identity.new.public_key().to_hex();
        let relay_snapshot = relay_membership_snapshot(state, &base, owner.old).await?;
        let role = relay_role(&relay_snapshot, &old_public_key);
        let replacement_role = relay_role(&relay_snapshot, &new_public_key);
        match relay_membership_transition(role.as_deref(), replacement_role.as_deref())? {
            RelayMembershipTransition::Ready => {}
            RelayMembershipTransition::WaitForRole(role) => {
                let owner_role = relay_role(&relay_snapshot, &owner.old.public_key().to_hex());
                if matches!(owner_role.as_deref(), Some("owner" | "admin")) {
                    submit_event_at_with_keys(
                        events::build_relay_admin_add(&new_public_key, &role)?,
                        state,
                        &base,
                        owner.old,
                    )
                    .await?;
                    verify_relay_role(state, &base, owner.old, &new_public_key, &role).await?;
                } else {
                    wait_for_relay_role(state, &base, owner.old, &new_public_key, &role).await?;
                }
            }
            RelayMembershipTransition::WaitForAbsence => {
                wait_for_relay_absence(state, &base, owner.old, &new_public_key).await?;
            }
        }
        relay_count += 1;

        let snapshots = query_relay_at_with_keys(
            state,
            &base,
            &[serde_json::json!({"kinds": [39002], "#p": [old_public_key]})],
            owner.old,
            None,
        )
        .await?;
        for (channel_id, channel_role) in channel_roles(&snapshots, &old_public_key) {
            let channel = uuid::Uuid::parse_str(&channel_id)
                .map_err(|_| "identity_rotation_channel_snapshot_invalid".to_string())?;
            let before = query_relay_at_with_keys(
                state,
                &base,
                &[serde_json::json!({"kinds": [39002], "#d": [channel_id], "limit": 1})],
                owner.old,
                None,
            )
            .await?;
            match channel_roles(&before, &new_public_key).get(&channel_id) {
                Some(replacement_role) if replacement_role == &channel_role => {}
                Some(_) => return Err("identity_rotation_channel_membership_role_conflict".into()),
                None => {
                    submit_event_at_with_keys(
                        events::build_add_member(channel, &new_public_key, Some(&channel_role))?,
                        state,
                        &base,
                        owner.old,
                    )
                    .await?;
                    let verified = query_relay_at_with_keys(
                        state,
                        &base,
                        &[serde_json::json!({"kinds": [39002], "#d": [channel_id], "limit": 1})],
                        owner.old,
                        None,
                    )
                    .await?;
                    if channel_roles(&verified, &new_public_key).get(&channel_id)
                        != Some(&channel_role)
                    {
                        return Err(
                            "identity_rotation_channel_membership_verification_failed".into()
                        );
                    }
                }
            }
            channel_count += 1;
        }
    }
    Ok((relay_count, channel_count))
}

pub(crate) async fn clone_profiles(
    state: &AppState,
    relay_url: &str,
    identities: &[RotationIdentity<'_>],
) -> Result<BTreeMap<String, String>, String> {
    let base = relay_http_base_url(relay_url);
    let mut verified_event_ids = BTreeMap::new();
    for identity in identities {
        let old = identity.old.public_key().to_hex();
        let source = query_relay_at_with_keys(
            state,
            &base,
            &[serde_json::json!({"kinds": [0], "authors": [old], "limit": 1})],
            identity.old,
            identity.old_auth_tag,
        )
        .await?;
        let Some(source) = source.first() else {
            continue;
        };
        let event = cloned_profile_event(source, identity.new, identity.new_auth_tag)?;
        let published = submit_signed_event_at_with_keys_and_auth(
            &event,
            state,
            &base,
            identity.new,
            identity.new_auth_tag,
        )
        .await?;
        let event_id = event.id.to_hex();
        if published.event_id != event_id {
            return Err("identity_rotation_profile_verification_failed".into());
        }
        let verified = query_relay_at_with_keys(
            state,
            &base,
            &[serde_json::json!({"kinds": [0], "authors": [identity.new.public_key().to_hex()], "limit": 1})],
            identity.new,
            identity.new_auth_tag,
        )
        .await?;
        if !verified
            .iter()
            .any(|value| value.id == event.id && value.content == source.content)
        {
            return Err("identity_rotation_profile_verification_failed".into());
        }
        verified_event_ids.insert(old, event_id);
    }
    Ok(verified_event_ids)
}

pub(crate) async fn migrate_agent_memory(
    state: &AppState,
    relay_url: &str,
    old_owner: &Keys,
    new_owner: &Keys,
    agent: &RotationIdentity<'_>,
) -> Result<(u32, u32), String> {
    let base = relay_http_base_url(relay_url);
    let old_agent = agent.old.public_key();
    let old_owner_public = old_owner.public_key();
    let events = query_relay_at_with_keys(
        state,
        &base,
        &[serde_json::json!({
            "kinds": [30174],
            "authors": [old_agent.to_hex()],
            "#p": [old_owner_public.to_hex()]
        })],
        old_owner,
        None,
    )
    .await?;
    let mut heads: HashMap<String, (Event, buzz_core_pkg::engram::Body)> = HashMap::new();
    for event in events {
        event
            .verify()
            .map_err(|_| "identity_rotation_memory_signature_invalid".to_string())?;
        let body = buzz_core_pkg::engram::validate_and_decrypt(
            &event,
            &old_agent,
            &old_owner_public,
            old_owner.secret_key(),
            &old_agent,
        )
        .map_err(|_| "identity_rotation_memory_decrypt_failed".to_string())?;
        let slug = body.slug().to_string();
        let replace = heads.get(&slug).is_none_or(|(current, _)| {
            buzz_core_pkg::engram::select_head([current.clone(), event.clone()])
                .is_some_and(|head| head.id == event.id)
        });
        if replace {
            heads.insert(slug, (event, body));
        }
    }
    let mut tombstones = 0u32;
    for (prior, body) in heads.values() {
        let migrated = rebuilt_memory_event(
            prior,
            body,
            agent.new,
            new_owner,
            chrono::Utc::now().timestamp().max(0) as u64,
        )?;
        submit_signed_event_at_with_keys_and_auth(
            &migrated,
            state,
            &base,
            agent.new,
            agent.new_auth_tag,
        )
        .await?;
        if body.is_tombstone() {
            tombstones += 1;
        }
    }
    let verified = query_relay_at_with_keys(
        state,
        &base,
        &[serde_json::json!({
            "kinds": [30174],
            "authors": [agent.new.public_key().to_hex()],
            "#p": [new_owner.public_key().to_hex()]
        })],
        new_owner,
        None,
    )
    .await?;
    let mut verified_heads: HashMap<String, (Event, buzz_core_pkg::engram::Body)> = HashMap::new();
    for event in verified {
        event
            .verify()
            .map_err(|_| "identity_rotation_memory_signature_invalid".to_string())?;
        let body = buzz_core_pkg::engram::validate_and_decrypt(
            &event,
            &agent.new.public_key(),
            &new_owner.public_key(),
            new_owner.secret_key(),
            &agent.new.public_key(),
        )
        .map_err(|_| "identity_rotation_memory_verification_failed".to_string())?;
        let slug = body.slug().to_string();
        let replace = verified_heads.get(&slug).is_none_or(|(current, _)| {
            buzz_core_pkg::engram::select_head([current.clone(), event.clone()])
                .is_some_and(|head| head.id == event.id)
        });
        if replace {
            verified_heads.insert(slug, (event, body));
        }
    }
    if verified_heads.len() != heads.len()
        || heads.iter().any(|(slug, (_, expected))| {
            verified_heads.get(slug).map(|(_, actual)| actual) != Some(expected)
        })
    {
        return Err("identity_rotation_memory_verification_failed".into());
    }
    Ok((heads.len() as u32, tombstones))
}

pub(crate) async fn archive_old_identities(
    state: &AppState,
    relay_url: &str,
    identities: &[RotationIdentity<'_>],
) -> Result<BTreeMap<String, String>, String> {
    let base = relay_http_base_url(relay_url);
    let mut verified_event_ids = BTreeMap::new();
    for identity in identities {
        let old = identity.old.public_key().to_hex();
        let new = identity.new.public_key().to_hex();
        let published = submit_event_at_with_keys_and_auth(
            events::build_archive_identity_request(
                &old,
                "Identity rotated by Buzz Desktop",
                Some("rotated"),
                Some(&new),
                None,
            )?,
            state,
            &base,
            identity.old,
            identity.old_auth_tag,
        )
        .await
        .map_err(|error| {
            if error.starts_with("relay unreachable:") {
                "identity_rotation_relay_unreachable".to_string()
            } else if error.starts_with("relay returned 401")
                || error.starts_with("relay returned 403")
            {
                "identity_rotation_archive_source_authority_unavailable".to_string()
            } else {
                "identity_rotation_archive_publish_failed".to_string()
            }
        })?;
        let verified = query_relay_at_with_keys(
            state,
            &base,
            &[
                serde_json::json!({"kinds": [13535], "#p": [old], "limit": 1}),
                serde_json::json!({"kinds": [8002], "#p": [old], "limit": 100}),
            ],
            identity.new,
            identity.new_auth_tag,
        )
        .await
        .map_err(|_| "identity_rotation_archive_verification_failed".to_string())?;
        verify_archive_lineage(&verified, &old, &new, &published.event_id)?;
        verified_event_ids.insert(old, published.event_id);
    }
    Ok(verified_event_ids)
}

fn has_tag(event: &Event, name: &str, value: &str) -> bool {
    event.tags.iter().any(|tag| {
        let values = tag.as_slice();
        values.first().map(String::as_str) == Some(name)
            && values.get(1).map(String::as_str) == Some(value)
    })
}

/// Verify both authoritative NIP-IA surfaces. Kind 13535 proves the old
/// identity is currently archived; kind 8002 carries the replacement pointer
/// (the snapshot intentionally contains only bare `p` tags).
fn verify_archive_lineage(
    events: &[Event],
    old_public_key: &str,
    new_public_key: &str,
    request_event_id: &str,
) -> Result<(), String> {
    let snapshot = events
        .iter()
        .find(|event| event.kind.as_u16() == 13_535 && has_tag(event, "p", old_public_key))
        .ok_or_else(|| "identity_rotation_archive_verification_failed".to_string())?;
    snapshot
        .verify()
        .map_err(|_| "identity_rotation_archive_verification_failed".to_string())?;

    let exact_delta = events.iter().find(|event| {
        event.kind.as_u16() == 8_002
            && event.pubkey == snapshot.pubkey
            && has_tag(event, "p", old_public_key)
            && has_tag(event, "replaced-by", new_public_key)
            && has_tag(event, "e", request_event_id)
    });
    // A crash after the relay accepted the archive but before the desktop
    // saved its checkpoint makes the retry a canonical no-op, so no new delta
    // is emitted. An earlier relay-signed delta with the exact same lineage is
    // sufficient in that idempotent recovery case.
    let lineage_delta = exact_delta.or_else(|| {
        events.iter().find(|event| {
            event.kind.as_u16() == 8_002
                && event.pubkey == snapshot.pubkey
                && has_tag(event, "p", old_public_key)
                && has_tag(event, "replaced-by", new_public_key)
        })
    });
    lineage_delta
        .ok_or_else(|| "identity_rotation_archive_lineage_missing".to_string())?
        .verify()
        .map_err(|_| "identity_rotation_archive_lineage_invalid".to_string())
}

fn is_authority_denial(error: &str) -> bool {
    error.starts_with("relay returned 401") || error.starts_with("relay returned 403")
}

fn classify_denial_probe(error: &str) -> Result<(), String> {
    if is_authority_denial(error) {
        Ok(())
    } else if error.starts_with("relay unreachable:") {
        Err("identity_rotation_relay_unreachable".into())
    } else {
        Err("identity_rotation_revocation_verification_unavailable".into())
    }
}

/// Remove every prior identity from its canonical channels while the
/// coordinator deliberately keeps the prior relay authority available for
/// self-signed archive and leave operations. Each authoritative snapshot is
/// read back with the committed owner. Snapshot absence is the authority proof:
/// an open channel may still allow ordinary non-member messages, so a message
/// rejection would not be a valid universal membership test.
pub(crate) async fn revoke_old_channel_authorities(
    state: &AppState,
    relay_url: &str,
    owner: &RotationIdentity<'_>,
    identities: &[RotationIdentity<'_>],
) -> Result<u32, String> {
    let base = relay_http_base_url(relay_url);
    let mut revoked = 0u32;
    for identity in identities {
        let old = identity.old.public_key().to_hex();
        let snapshots = query_relay_at_with_keys(
            state,
            &base,
            &[serde_json::json!({"kinds": [39002], "#p": [old]})],
            owner.new,
            owner.new_auth_tag,
        )
        .await?;
        let old_channels = channel_roles(&snapshots, &old);
        for channel_id in old_channels.keys() {
            let channel = uuid::Uuid::parse_str(channel_id)
                .map_err(|_| "identity_rotation_channel_snapshot_invalid".to_string())?;
            submit_event_at_with_keys_and_auth(
                events::build_leave(channel)?,
                state,
                &base,
                identity.old,
                identity.old_auth_tag,
            )
            .await?;
            let verified = query_relay_at_with_keys(
                state,
                &base,
                &[serde_json::json!({"kinds": [39002], "#d": [channel_id], "limit": 1})],
                owner.new,
                owner.new_auth_tag,
            )
            .await?;
            if channel_roles(&verified, &old).contains_key(channel_id) {
                return Err("identity_rotation_old_channel_authority_present".into());
            }
        }
        revoked += 1;
    }
    Ok(revoked)
}

/// After the coordinator enters `old_revoked`, its privileged membership
/// controller removes the predecessor identities without a desktop race. Poll
/// the canonical roster, then require an explicit authorization denial from
/// every old identity. Connectivity and protocol failures are never accepted
/// as revocation evidence.
pub(crate) async fn verify_old_relay_authorities_revoked(
    state: &AppState,
    relay_url: &str,
    owner: &RotationIdentity<'_>,
    identities: &[RotationIdentity<'_>],
) -> Result<u32, String> {
    let base = relay_http_base_url(relay_url);
    let mut revoked = 0u32;
    for identity in identities {
        let old = identity.old.public_key().to_hex();
        let mut absent = false;
        for _ in 0..30 {
            let relay = query_relay_at_with_keys(
                state,
                &base,
                &[serde_json::json!({"kinds": [13534], "limit": 1})],
                owner.new,
                owner.new_auth_tag,
            )
            .await?;
            if relay
                .first()
                .and_then(|event| relay_role(event, &old))
                .is_none()
            {
                absent = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        if !absent {
            return Err("identity_rotation_membership_controller_timeout".into());
        }
        match query_relay_at_with_keys(
            state,
            &base,
            &[serde_json::json!({"kinds": [13534], "limit": 1})],
            identity.old,
            identity.old_auth_tag,
        )
        .await
        {
            Ok(_) => return Err("identity_rotation_old_relay_auth_allowed".into()),
            Err(error) => classify_denial_probe(&error)?,
        }
        revoked += 1;
    }
    Ok(revoked)
}

pub(crate) fn finalize_evidence(journal: &mut ContinuityJournal) -> Result<(), String> {
    #[derive(Serialize)]
    struct Evidence<'a> {
        relay_memberships_verified: u32,
        channel_memberships_verified: u32,
        profiles_verified: u32,
        memory_heads_migrated: u32,
        memory_tombstones_preserved: u32,
        archive_pointers_verified: u32,
        contract: &'a str,
    }
    let evidence = Evidence {
        relay_memberships_verified: journal.relay_memberships_verified,
        channel_memberships_verified: journal.channel_memberships_verified,
        profiles_verified: journal.profiles_verified,
        memory_heads_migrated: journal.memory_heads_migrated,
        memory_tombstones_preserved: journal.memory_tombstones_preserved,
        archive_pointers_verified: journal.archive_pointers_verified,
        contract: "buzz-identity-rotation-continuity-v1",
    };
    let canonical = serde_json::to_vec(&evidence)
        .map_err(|_| "identity_rotation_evidence_failed".to_string())?;
    journal.evidence_sha256 = Some(sha256_hex(&canonical));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Kind, Tag};

    #[test]
    fn rotation_event_egress_rejects_embedded_key_backup_material() {
        let keys = Keys::generate();
        let backup_prefix = ["ncrypt", "sec1"].concat();
        let event = EventBuilder::new(Kind::TextNote, format!("{backup_prefix}must-not-leave"))
            .sign_with_keys(&keys)
            .unwrap();

        assert!(guarded_event_body(&event).is_err());
    }

    #[test]
    fn exact_roles_are_preserved_by_snapshot_parsers() {
        let relay = EventBuilder::new(Kind::Custom(13534), "")
            .tags([nostr::Tag::parse(["member", "old", "admin"]).unwrap()])
            .sign_with_keys(&Keys::generate())
            .unwrap();
        assert_eq!(relay_role(&relay, "old").as_deref(), Some("admin"));
        let channel = EventBuilder::new(Kind::Custom(39002), "")
            .tags([
                nostr::Tag::parse(["d", "20000000-0000-4000-8000-000000000001"]).unwrap(),
                nostr::Tag::parse(["p", "old", "", "bot"]).unwrap(),
            ])
            .sign_with_keys(&Keys::generate())
            .unwrap();
        assert_eq!(
            channel_roles(&[channel], "old")
                .values()
                .next()
                .map(String::as_str),
            Some("bot")
        );
    }

    #[test]
    fn relay_continuity_preserves_nip_oa_membership_absence() {
        assert_eq!(
            relay_membership_transition(None, None).unwrap(),
            RelayMembershipTransition::Ready
        );
        assert_eq!(
            relay_membership_transition(None, Some("member")).unwrap(),
            RelayMembershipTransition::WaitForAbsence
        );
    }

    #[test]
    fn relay_continuity_waits_for_exact_role_and_rejects_conflicts() {
        assert_eq!(
            relay_membership_transition(Some("admin"), None).unwrap(),
            RelayMembershipTransition::WaitForRole("admin".into())
        );
        assert_eq!(
            relay_membership_transition(Some("member"), Some("member")).unwrap(),
            RelayMembershipTransition::Ready
        );
        assert!(relay_membership_transition(Some("admin"), Some("member")).is_err());
    }

    #[test]
    fn continuity_digest_changes_with_counts() {
        let mut evidence = ContinuityJournal::default();
        finalize_evidence(&mut evidence).unwrap();
        let before = evidence.evidence_sha256.clone();
        evidence.memory_tombstones_preserved = 1;
        finalize_evidence(&mut evidence).unwrap();
        assert_ne!(before, evidence.evidence_sha256);
    }

    #[test]
    fn profile_clone_preserves_content_and_moves_signature_to_replacement() {
        let old = Keys::generate();
        let replacement = Keys::generate();
        let source = EventBuilder::new(
            Kind::Metadata,
            r#"{"name":"High Agency","about":"Test walls."}"#,
        )
        .sign_with_keys(&old)
        .unwrap();
        let cloned = cloned_profile_event(&source, &replacement, None).unwrap();
        cloned.verify().unwrap();
        assert_eq!(cloned.kind, Kind::Metadata);
        assert_eq!(cloned.content, source.content);
        assert_eq!(cloned.pubkey, replacement.public_key());
        assert_ne!(cloned.pubkey, old.public_key());
    }

    #[test]
    fn memory_rebuild_preserves_live_body_and_tombstone_under_new_pair() {
        let old_owner = Keys::generate();
        let old_agent = Keys::generate();
        let new_owner = Keys::generate();
        let new_agent = Keys::generate();
        for body in [
            buzz_core_pkg::engram::Body::Memory {
                slug: "mem/preference".into(),
                value: Some("prefer concrete actions".into()),
            },
            buzz_core_pkg::engram::Body::Memory {
                slug: "mem/retired".into(),
                value: None,
            },
        ] {
            let prior = buzz_core_pkg::engram::build_event(
                &old_agent,
                &old_owner.public_key(),
                &body,
                1_700_000_000,
            )
            .unwrap();
            let migrated =
                rebuilt_memory_event(&prior, &body, &new_agent, &new_owner, 1_699_000_000).unwrap();
            assert!(migrated.created_at > prior.created_at);
            let decoded = buzz_core_pkg::engram::validate_and_decrypt(
                &migrated,
                &new_agent.public_key(),
                &new_owner.public_key(),
                new_owner.secret_key(),
                &new_agent.public_key(),
            )
            .unwrap();
            assert_eq!(decoded, body);
            assert!(buzz_core_pkg::engram::validate_and_decrypt(
                &migrated,
                &new_agent.public_key(),
                &new_owner.public_key(),
                old_owner.secret_key(),
                &new_agent.public_key(),
            )
            .is_err());
        }
    }

    #[test]
    fn archive_lineage_names_exact_replacement() {
        let old = Keys::generate();
        let replacement = Keys::generate();
        let event = events::build_archive_identity_request(
            &old.public_key().to_hex(),
            "Identity rotated by Buzz Desktop",
            Some("rotated"),
            Some(&replacement.public_key().to_hex()),
            None,
        )
        .unwrap()
        .sign_with_keys(&old)
        .unwrap();
        event.verify().unwrap();
        assert!(event.tags.iter().any(|tag| {
            let values = tag.as_slice();
            values.first().map(String::as_str) == Some("replaced-by")
                && values.get(1) == Some(&replacement.public_key().to_hex())
        }));
    }

    #[test]
    fn archive_lineage_verifies_bare_snapshot_and_replacement_delta() {
        let relay = Keys::generate();
        let old = Keys::generate().public_key().to_hex();
        let replacement = Keys::generate().public_key().to_hex();
        let request_id = "a".repeat(64);
        let snapshot = EventBuilder::new(Kind::Custom(13_535), "")
            .tags([
                Tag::parse(["-"]).unwrap(),
                Tag::parse(["p", old.as_str()]).unwrap(),
            ])
            .sign_with_keys(&relay)
            .unwrap();
        let delta = EventBuilder::new(Kind::Custom(8_002), "")
            .tags([
                Tag::parse(["-"]).unwrap(),
                Tag::parse(["p", old.as_str()]).unwrap(),
                Tag::parse(["e", request_id.as_str()]).unwrap(),
                Tag::parse(["replaced-by", replacement.as_str()]).unwrap(),
            ])
            .sign_with_keys(&relay)
            .unwrap();

        verify_archive_lineage(&[snapshot.clone(), delta], &old, &replacement, &request_id)
            .unwrap();
        assert_eq!(
            verify_archive_lineage(&[snapshot], &old, &replacement, &request_id),
            Err("identity_rotation_archive_lineage_missing".into())
        );
    }

    #[test]
    fn archive_lineage_rejects_a_delta_not_signed_by_the_snapshot_relay() {
        let relay = Keys::generate();
        let attacker = Keys::generate();
        let old = Keys::generate().public_key().to_hex();
        let replacement = Keys::generate().public_key().to_hex();
        let request_id = "b".repeat(64);
        let snapshot = EventBuilder::new(Kind::Custom(13_535), "")
            .tags([Tag::parse(["p", old.as_str()]).unwrap()])
            .sign_with_keys(&relay)
            .unwrap();
        let forged_delta = EventBuilder::new(Kind::Custom(8_002), "")
            .tags([
                Tag::parse(["p", old.as_str()]).unwrap(),
                Tag::parse(["e", request_id.as_str()]).unwrap(),
                Tag::parse(["replaced-by", replacement.as_str()]).unwrap(),
            ])
            .sign_with_keys(&attacker)
            .unwrap();

        assert_eq!(
            verify_archive_lineage(&[snapshot, forged_delta], &old, &replacement, &request_id,),
            Err("identity_rotation_archive_lineage_missing".into())
        );
    }

    #[test]
    fn denial_probe_requires_an_explicit_authorization_failure() {
        assert!(classify_denial_probe("relay returned 403 Forbidden").is_ok());
        assert_eq!(
            classify_denial_probe("relay unreachable: request timed out"),
            Err("identity_rotation_relay_unreachable".into())
        );
        assert_eq!(
            classify_denial_probe("malformed relay response"),
            Err("identity_rotation_revocation_verification_unavailable".into())
        );
    }
}

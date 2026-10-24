//! Creator-admitted huddle backing channels.
//!
//! A huddle's backing channel (a private, TTL-bound kind:9007 channel) is
//! *creator-admitted* when its creating kind:9007 carries
//! `["admission", "creator", "<parent channel id>"]`. On such a channel:
//!
//! - The mark is fixed at creation. It is read from the stored creation event
//!   (soft-deleted or not), a second kind:9007 for the same id is refused as a
//!   duplicate, and every kind:9002 carrying an `admission` tag is refused. Its
//!   visibility cannot be edited either.
//! - Only the creator may publish kind:9000 (put) and kind:9001 (remove), and
//!   a put is accepted only for an active member of the parent channel.
//!   Members leave with kind:9022. The owner or an admin of the parent channel
//!   may still delete the backing channel with kind:9008.
//! - Audio admits the creator, and members whose active membership the
//!   creator recorded (`invited_by`, set by the relay from the accepted put's
//!   signer) while they are still active members of the parent channel. The
//!   parent auto-add and the open-visibility shortcut do not apply, and an
//!   expired channel admits nobody.
//! - A kind:9001 or kind:9022 removal cuts the member's live audio before the
//!   relay acknowledges it: the NIP-01 `OK` is sent once this pod's socket for
//!   that key has closed and the end has been published to the other pods. If
//!   that cannot be confirmed within [`LOCAL_CLOSE_DEADLINE`], the relay
//!   force-drops the socket and still answers `OK` true, but with
//!   [`AUDIO_CLOSE_UNCONFIRMED_WARNING`] as the message, which callers treat as
//!   not acknowledged.
//! - Puts may carry opaque `call` and `epoch` tags. They are stored on the put
//!   event unchanged and echoed in the channel's kind:39002 roster as
//!   `["put", <member pubkey>, <call>, <epoch>]`, taken from the creator's
//!   newest put for each active member.
//!
//! Unmarked channels keep their existing behavior.

use std::time::Duration;

use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use buzz_db::channel::{ChannelRecord, MemberRecord};
use buzz_pubsub::conn_control::ConnControl;
use nostr::{Event, Tag};
use uuid::Uuid;

use crate::state::AppState;

/// Tag name of the creation mark.
pub const ADMISSION_TAG: &str = "admission";
/// Value of the creation mark.
pub const ADMISSION_CREATOR: &str = "creator";
/// Opaque call identifier carried on puts.
pub const CALL_TAG: &str = "call";
/// Opaque epoch carried on puts.
pub const EPOCH_TAG: &str = "epoch";
/// Roster tag echoing a member's current put.
pub const PUT_ECHO_TAG: &str = "put";
/// `OK` message of an accepted removal whose live audio close was not
/// confirmed in time. Callers treat it as not acknowledged; the text is a
/// contract and must not change.
pub const AUDIO_CLOSE_UNCONFIRMED_WARNING: &str = "warning: live audio close not confirmed";
/// How long a removal waits for the member's local audio socket to close.
pub const LOCAL_CLOSE_DEADLINE: Duration = Duration::from_millis(2_000);

const CLOSE_POLL_INTERVAL: Duration = Duration::from_millis(20);
const ONLY_CREATOR: &str = "creator-admitted channel: only the creator adds or removes members";
const MARK_FIXED: &str = "the admission mark is fixed at creation";
const VISIBILITY_FIXED: &str = "a creator-admitted channel's visibility is fixed";
const MALFORMED_MARK: &str =
    "invalid: admission tag must be [\"admission\", \"creator\", \"<parent channel id>\"]";

/// A creator-admitted backing channel's fixed facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CreatorAdmitted {
    /// The parent channel whose members the creator may put.
    pub parent_channel_id: Uuid,
}

/// Outcome of a creator-admitted removal's live audio close.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AudioClose {
    /// The local socket closed and the end was published to every pod.
    Confirmed,
    /// The close could not be confirmed in time; the socket was force-dropped.
    Unconfirmed,
}

/// What [`validate_admin_event`] decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AdminDecision {
    /// Run the channel's ordinary authorization as well.
    Continue,
    /// Authorized here; skip the ordinary authorization.
    Allow,
}

/// Parse the creation mark from tag slices. `Ok(None)` when no admission tag
/// is present.
fn parse_mark<'a>(
    tags: impl IntoIterator<Item = &'a [String]>,
) -> Result<Option<CreatorAdmitted>, &'static str> {
    let mut found: Option<CreatorAdmitted> = None;
    for tag in tags {
        if tag.first().map(String::as_str) != Some(ADMISSION_TAG) {
            continue;
        }
        if found.is_some() {
            return Err(MALFORMED_MARK);
        }
        let parent = match tag {
            [_, value, parent] if value == ADMISSION_CREATOR => {
                Uuid::parse_str(parent).map_err(|_| MALFORMED_MARK)?
            }
            _ => return Err(MALFORMED_MARK),
        };
        found = Some(CreatorAdmitted {
            parent_channel_id: parent,
        });
    }
    Ok(found)
}

fn event_tags(event: &Event) -> impl Iterator<Item = &[String]> {
    event.tags.iter().map(|tag| tag.as_slice())
}

fn has_tag(event: &Event, name: &str) -> bool {
    event_tags(event).any(|tag| tag.first().map(String::as_str) == Some(name))
}

fn tag_value<'a>(tags: &'a [Vec<String>], name: &str) -> Option<&'a str> {
    tags.iter()
        .find(|tag| tag.first().map(String::as_str) == Some(name))
        .and_then(|tag| tag.get(1))
        .map(String::as_str)
}

fn json_tags(value: &serde_json::Value) -> Vec<Vec<String>> {
    value
        .as_array()
        .map(|tags| {
            tags.iter()
                .filter_map(|tag| {
                    tag.as_array().map(|parts| {
                        parts
                            .iter()
                            .map(|part| part.as_str().unwrap_or_default().to_owned())
                            .collect()
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn p_target(event: &Event) -> Option<Vec<u8>> {
    event_tags(event)
        .find(|tag| tag.first().map(String::as_str) == Some("p"))
        .and_then(|tag| tag.get(1))
        .and_then(|hex_key| hex::decode(hex_key).ok())
        .filter(|bytes| bytes.len() == 32)
}

/// The mark of the channel `creator` created as `channel_id`, read from its
/// stored creation event. A stored mark that fails to parse is an error, so
/// callers fail closed.
pub(crate) async fn load_for_creator(
    state: &AppState,
    community_id: CommunityId,
    channel_id: Uuid,
    creator: &[u8],
) -> anyhow::Result<Option<CreatorAdmitted>> {
    let Some(tags) = state
        .db
        .huddle_creation_event_tags(community_id, channel_id, creator)
        .await?
    else {
        return Ok(None);
    };
    let tags = json_tags(&tags);
    parse_mark(tags.iter().map(Vec::as_slice)).map_err(|error| anyhow::anyhow!(error))
}

/// [`load_for_creator`] for a loaded channel row.
pub(crate) async fn load(
    state: &AppState,
    community_id: CommunityId,
    channel: &ChannelRecord,
) -> anyhow::Result<Option<CreatorAdmitted>> {
    load_for_creator(state, community_id, channel.id, &channel.created_by).await
}

/// Validate the creation mark on a kind:9007 before the channel is created.
///
/// A marked creation needs the client-chosen `h` id, private visibility, a
/// TTL, and a parent channel (other than itself) that exists, is not archived
/// and has the creator as an active member.
pub(crate) async fn validate_creation(
    state: &AppState,
    tenant: &TenantContext,
    event: &Event,
    channel_id: Option<Uuid>,
    private: bool,
    ttl_seconds: Option<i32>,
) -> Result<(), String> {
    let Some(mark) = parse_mark(event_tags(event)).map_err(str::to_owned)? else {
        return Ok(());
    };
    let Some(channel_id) = channel_id else {
        return Err("invalid: a creator-admitted channel needs an h tag".into());
    };
    if !private {
        return Err("invalid: a creator-admitted channel must be private".into());
    }
    if ttl_seconds.is_none_or(|ttl| ttl <= 0) {
        return Err("invalid: a creator-admitted channel needs a ttl".into());
    }
    if mark.parent_channel_id == channel_id {
        return Err("invalid: a creator-admitted channel cannot be its own parent".into());
    }
    let parent = state
        .db
        .get_channel(tenant.community(), mark.parent_channel_id)
        .await
        .map_err(|_| "invalid: parent channel not found".to_owned())?;
    if parent.archived_at.is_some() {
        return Err("invalid: parent channel is archived".into());
    }
    let creator = event.pubkey.to_bytes();
    let in_parent = state
        .db
        .is_member(tenant.community(), mark.parent_channel_id, &creator)
        .await
        .map_err(|error| format!("error: {error}"))?;
    if !in_parent {
        return Err("restricted: the creator must be a member of the parent channel".into());
    }
    Ok(())
}

/// Creator-admitted rules for an admin kind on an existing channel; runs
/// before the channel's ordinary authorization.
pub(crate) async fn validate_admin_event(
    state: &AppState,
    tenant: &TenantContext,
    kind: u32,
    event: &Event,
    channel: &ChannelRecord,
) -> anyhow::Result<AdminDecision> {
    // Nobody adds, changes or clears the mark after creation, on any channel.
    if kind == 9002 && has_tag(event, ADMISSION_TAG) {
        return Err(anyhow::anyhow!(MARK_FIXED));
    }
    if !matches!(kind, 9000 | 9001 | 9002 | 9008) {
        return Ok(AdminDecision::Continue);
    }
    let Some(mark) = load(state, tenant.community(), channel).await? else {
        return Ok(AdminDecision::Continue);
    };
    let actor = event.pubkey.to_bytes();
    match kind {
        9002 if has_tag(event, "visibility") => Err(anyhow::anyhow!(VISIBILITY_FIXED)),
        9000 | 9001 if actor[..] != channel.created_by[..] => Err(anyhow::anyhow!(ONLY_CREATOR)),
        9000 => {
            let target = p_target(event).ok_or_else(|| anyhow::anyhow!("missing p tag"))?;
            if state
                .db
                .is_member(tenant.community(), mark.parent_channel_id, &target)
                .await?
            {
                Ok(AdminDecision::Continue)
            } else {
                Err(anyhow::anyhow!(
                    "creator-admitted channel: the member must belong to the parent channel"
                ))
            }
        }
        // Safety valve: the parent's owner or an admin may still end the huddle.
        9008 => {
            let parent_role = state
                .db
                .get_members(tenant.community(), mark.parent_channel_id)
                .await?
                .into_iter()
                .find(|member| member.pubkey[..] == actor[..])
                .map(|member| member.role);
            Ok(match parent_role.as_deref() {
                Some("owner" | "admin") => AdminDecision::Allow,
                _ => AdminDecision::Continue,
            })
        }
        _ => Ok(AdminDecision::Continue),
    }
}

/// After an accepted put on a marked channel, record its signer (the creator)
/// as the member's inviter, so a reactivated row never keeps an earlier one.
pub(crate) async fn record_put(
    state: &AppState,
    tenant: &TenantContext,
    channel_id: Uuid,
    target: &[u8],
    actor: &[u8],
) -> anyhow::Result<()> {
    if load_for_creator(state, tenant.community(), channel_id, actor)
        .await?
        .is_some()
    {
        state
            .db
            .huddle_stamp_active_member_inviter(tenant.community(), channel_id, target, actor)
            .await?;
    }
    Ok(())
}

/// Whether `pubkey` may hold audio in the marked `channel` reached through
/// `lifecycle_parent_id`. Reads durable state, never caches.
pub(crate) async fn admits(
    state: &AppState,
    community_id: CommunityId,
    channel: &ChannelRecord,
    mark: CreatorAdmitted,
    lifecycle_parent_id: Uuid,
    pubkey: &[u8],
) -> Result<bool, buzz_db::DbError> {
    let expired = channel.ttl_seconds.is_none()
        || channel
            .ttl_deadline
            .is_some_and(|deadline| deadline <= chrono::Utc::now());
    if expired || channel.archived_at.is_some() || lifecycle_parent_id != mark.parent_channel_id {
        return Ok(false);
    }
    if !state.db.is_member(community_id, channel.id, pubkey).await? {
        return Ok(false);
    }
    if pubkey != channel.created_by.as_slice() {
        let inviter = state
            .db
            .huddle_active_member_inviter(community_id, channel.id, pubkey)
            .await?
            .flatten();
        if inviter.as_deref() != Some(channel.created_by.as_slice()) {
            return Ok(false);
        }
    }
    state
        .db
        .is_member(community_id, mark.parent_channel_id, pubkey)
        .await
}

/// Periodic re-check of a live audio socket on a marked channel: cut it when
/// the key is no longer admitted. A failed read keeps the socket.
pub(crate) async fn recheck(
    state: &AppState,
    community_id: CommunityId,
    channel_id: Uuid,
    mark: CreatorAdmitted,
    pubkey: &[u8],
) -> usize {
    let channel = match state.db.get_channel(community_id, channel_id).await {
        Ok(channel) => channel,
        Err(buzz_db::DbError::ChannelNotFound(_)) => {
            return state.community_connections.disconnect_huddle_audio(
                community_id,
                channel_id,
                None,
                crate::state::HuddleAudioEnd::Ended,
            );
        }
        Err(error) => {
            tracing::warn!(channel = %channel_id, %error, "creator-admitted recheck read failed");
            return 0;
        }
    };
    match admits(
        state,
        community_id,
        &channel,
        mark,
        mark.parent_channel_id,
        pubkey,
    )
    .await
    {
        Ok(true) => 0,
        Ok(false) => state.community_connections.disconnect_huddle_audio(
            community_id,
            channel_id,
            Some(pubkey),
            crate::state::HuddleAudioEnd::Removed,
        ),
        Err(error) => {
            tracing::warn!(channel = %channel_id, %error, "creator-admitted recheck failed");
            0
        }
    }
}

/// The member a kind:9001 or kind:9022 removes, and its channel, when that
/// channel is creator-admitted.
pub(crate) async fn removal_target(
    state: &AppState,
    tenant: &TenantContext,
    kind: u32,
    event: &Event,
    channel_id: Option<Uuid>,
) -> Option<(Uuid, Vec<u8>)> {
    let channel_id = channel_id?;
    let target = match kind {
        9001 => p_target(event)?,
        9022 => event.pubkey.to_bytes().to_vec(),
        _ => return None,
    };
    let channel = match state.db.get_channel(tenant.community(), channel_id).await {
        Ok(channel) => channel,
        Err(_) => return None,
    };
    match load(state, tenant.community(), &channel).await {
        Ok(Some(_)) => Some((channel_id, target)),
        Ok(None) => None,
        // Unknown: still confirm the close; it costs only the wait.
        Err(_) => Some((channel_id, target)),
    }
}

/// Confirm a removed member's live audio is gone before the removal is
/// acknowledged: publish the end to every pod, wait for this pod's socket to
/// close, and force-drop it when it does not close in time.
pub(crate) async fn confirm_audio_closed(
    state: &AppState,
    tenant: &TenantContext,
    channel_id: Uuid,
    pubkey: &[u8],
) -> AudioClose {
    let community_id = tenant.community();
    let command = ConnControl::EndHuddleAudio {
        channel_id,
        pubkey: Some(pubkey.to_vec()),
    };
    let published = publish_end(state, tenant, &command).await;
    // The removal handler already cancelled the socket; cut again in case it
    // registered after that cut.
    state.community_connections.disconnect_huddle_audio(
        community_id,
        channel_id,
        Some(pubkey),
        crate::state::HuddleAudioEnd::Removed,
    );
    let deadline = tokio::time::Instant::now() + LOCAL_CLOSE_DEADLINE;
    while has_local_audio(state, community_id, channel_id, pubkey) {
        if tokio::time::Instant::now() >= deadline {
            force_drop(state, community_id, channel_id, pubkey);
            return AudioClose::Unconfirmed;
        }
        tokio::time::sleep(CLOSE_POLL_INTERVAL).await;
    }
    if published {
        AudioClose::Confirmed
    } else {
        AudioClose::Unconfirmed
    }
}

/// Publish the end to every pod; `true` once Redis accepted it.
async fn publish_end(state: &AppState, tenant: &TenantContext, command: &ConnControl) -> bool {
    #[cfg(test)]
    if test_hooks::delivers(tenant.community()) {
        return true;
    }
    match state.pubsub.publish_conn_control(tenant, command).await {
        Ok(_) => true,
        Err(error) => {
            tracing::warn!(%error, "huddle audio end publish failed");
            false
        }
    }
}

/// Test stand-in for the cross-pod publish: test relays run without Redis.
#[cfg(test)]
pub(crate) mod test_hooks {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};

    use buzz_core::CommunityId;

    fn delivered() -> &'static Mutex<HashSet<CommunityId>> {
        static DELIVERED: OnceLock<Mutex<HashSet<CommunityId>>> = OnceLock::new();
        DELIVERED.get_or_init(Mutex::default)
    }

    /// Treat `community`'s huddle-end publishes as delivered to every pod.
    pub(crate) fn deliver_end_publishes(community: CommunityId) {
        delivered()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(community);
    }

    pub(super) fn delivers(community: CommunityId) -> bool {
        delivered()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(&community)
    }
}

fn room_holds(
    state: &AppState,
    community_id: CommunityId,
    channel_id: Uuid,
    key_hex: &str,
) -> bool {
    state
        .audio_rooms
        .get(community_id, channel_id)
        .is_some_and(|room| room.peers.iter().any(|peer| peer.pubkey == key_hex))
}

fn has_local_audio(
    state: &AppState,
    community_id: CommunityId,
    channel_id: Uuid,
    pubkey: &[u8],
) -> bool {
    state
        .community_connections
        .has_huddle_audio(community_id, channel_id, Some(pubkey))
        || room_holds(state, community_id, channel_id, &hex::encode(pubkey))
}

/// Drop the key's registrations and room seats so no audio flows to or from
/// it, even while its socket task is stuck. Logs an alert when that fails.
fn force_drop(state: &AppState, community_id: CommunityId, channel_id: Uuid, pubkey: &[u8]) {
    let key_hex = hex::encode(pubkey);
    let dropped =
        state
            .community_connections
            .force_drop_huddle_audio(community_id, channel_id, pubkey);
    let mut seats = 0;
    if let Some(room) = state.audio_rooms.get(community_id, channel_id) {
        let peers: Vec<(Uuid, bool)> = room
            .peers
            .iter()
            .filter(|peer| peer.pubkey == key_hex)
            .map(|peer| (*peer.key(), peer.committed))
            .collect();
        for (peer_id, committed) in peers {
            let removed = if committed {
                room.remove_peer(peer_id).is_some()
            } else {
                room.remove_peer_silent(peer_id)
            };
            seats += usize::from(removed);
        }
    }
    if has_local_audio(state, community_id, channel_id, pubkey) {
        tracing::error!(
            alert = true,
            channel = %channel_id,
            member = %key_hex,
            "ALERT: removed member's huddle audio survived a force-drop"
        );
    } else {
        tracing::warn!(
            channel = %channel_id,
            member = %key_hex,
            dropped,
            seats,
            "force-dropped huddle audio that did not close in time"
        );
    }
}

/// `["put", member, call, epoch]` echo tags for the kind:39002 roster of a
/// marked channel, from the creator's newest put for each active member.
/// Empty for unmarked channels.
pub(crate) async fn roster_put_tags(
    state: &AppState,
    community_id: CommunityId,
    channel_id: Uuid,
    creator: &[u8],
    members: &[MemberRecord],
) -> anyhow::Result<Vec<Tag>> {
    if load_for_creator(state, community_id, channel_id, creator)
        .await?
        .is_none()
    {
        return Ok(Vec::new());
    }
    let puts = state
        .db
        .huddle_creator_put_tags(community_id, channel_id, creator)
        .await?;
    let mut echoed = std::collections::HashSet::new();
    let mut tags = Vec::new();
    for put in puts.iter().map(json_tags) {
        let Some(member) = tag_value(&put, "p").map(str::to_ascii_lowercase) else {
            continue;
        };
        let active = members
            .iter()
            .any(|record| hex::encode(&record.pubkey) == member);
        if !active || !echoed.insert(member.clone()) {
            continue;
        }
        let call = tag_value(&put, CALL_TAG).unwrap_or_default();
        let epoch = tag_value(&put, EPOCH_TAG).unwrap_or_default();
        tags.push(Tag::parse([PUT_ECHO_TAG, member.as_str(), call, epoch])?);
    }
    Ok(tags)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(raw: &[&[&str]]) -> Vec<Vec<String>> {
        raw.iter()
            .map(|tag| tag.iter().map(|part| (*part).to_owned()).collect())
            .collect()
    }

    fn mark(raw: &[&[&str]]) -> Result<Option<CreatorAdmitted>, &'static str> {
        let tags = tags(raw);
        parse_mark(tags.iter().map(Vec::as_slice))
    }

    #[test]
    fn warning_text_is_the_published_contract() {
        assert_eq!(
            AUDIO_CLOSE_UNCONFIRMED_WARNING,
            "warning: live audio close not confirmed"
        );
        assert_eq!(LOCAL_CLOSE_DEADLINE, Duration::from_secs(2));
        assert_eq!(
            (
                ADMISSION_TAG,
                ADMISSION_CREATOR,
                CALL_TAG,
                EPOCH_TAG,
                PUT_ECHO_TAG
            ),
            ("admission", "creator", "call", "epoch", "put")
        );
    }

    #[test]
    fn mark_parses_only_the_exact_shape() {
        let parent = Uuid::new_v4();
        let parent_text = parent.to_string();
        assert_eq!(mark(&[&["name", "x"]]), Ok(None));
        assert_eq!(
            mark(&[&["admission", "creator", &parent_text]]),
            Ok(Some(CreatorAdmitted {
                parent_channel_id: parent
            }))
        );
        for bad in [
            vec![vec!["admission"]],
            vec![vec!["admission", "creator"]],
            vec![vec!["admission", "anyone", parent_text.as_str()]],
            vec![vec!["admission", "creator", "not-a-uuid"]],
            vec![vec!["admission", "creator", parent_text.as_str(), "extra"]],
            vec![
                vec!["admission", "creator", parent_text.as_str()],
                vec!["admission", "creator", parent_text.as_str()],
            ],
        ] {
            let raw: Vec<&[&str]> = bad.iter().map(Vec::as_slice).collect();
            assert_eq!(mark(&raw), Err(MALFORMED_MARK), "{bad:?}");
        }
    }

    #[test]
    fn json_tags_ignore_non_string_parts() {
        let value = serde_json::json!([["p", "ab"], ["call", 7], "loose"]);
        assert_eq!(
            json_tags(&value),
            vec![
                vec!["p".to_owned(), "ab".to_owned()],
                vec!["call".to_owned(), String::new()]
            ]
        );
    }
}

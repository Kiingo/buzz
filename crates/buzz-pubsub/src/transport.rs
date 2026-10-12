//! Bounded Redis transport history, separate from the authoritative event store.
//!
//! The append and both publications run in one Redis command. Modern subscribers
//! receive the versioned notification immediately before its unchanged legacy
//! payload; a plain publisher has no such notification and remains deliverable.

use redis::aio::MultiplexedConnection;
use redis::streams::StreamRangeReply;

use crate::PubSubError;

pub(crate) const MODERN_PREFIX: &str = "buzz-transport-v1:";
const STREAM: &str = "buzz-transport-v1:{delivery}:events";
const METADATA: &str = "buzz-transport-v1:{delivery}:metadata";
const LEDGER: &str = "buzz-transport-v1:{delivery}:ledger";

// The ledger keeps accounting for erased payloads until the prefix is reclaimed.
// The allowance includes stream/list/field/index overhead, with a separate entry
// cap. Native allocator/RSS and zero-eviction custody is still required; this is
// not a claim that Redis's allocator uses exactly these accounted bytes.
const APPEND: &str = r#"
local budget = 8388608
local record_limit = 4096
local size = #ARGV[1] + #ARGV[2] + 1024
for i, expected in ipairs({'stream', 'hash', 'list'}) do
    local actual = redis.call('TYPE', KEYS[i]).ok
    if actual ~= 'none' and actual ~= expected then
        return redis.error_reply('invalid transport key type')
    end
end
if size > budget then
    -- Preserve legitimate legacy large publications. They have no replay
    -- promise; a changed counter disqualifies a lossless online handover.
    redis.call('HINCRBY', KEYS[2], 'unbuffered', 1)
    return redis.call('PUBLISH', ARGV[1], ARGV[2])
end
local previous = redis.call('HGET', KEYS[2], 'last') or '0-0'
local epoch = redis.call('HGET', KEYS[2], 'epoch') or ARGV[3]
local bytes = tonumber(redis.call('HGET', KEYS[2], 'bytes') or '0')
local exists = redis.call('EXISTS', KEYS[1]) == 1
local id = '*'
local now = redis.call('TIME')
local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
if not exists then
    bytes = 0
    redis.call('DEL', KEYS[3])
    redis.call('HSET', KEYS[2], 'trimmed', previous)
    local ms, sequence = string.match(previous, '^(%d+)%-(%d+)$')
    if not ms then return redis.error_reply('invalid transport watermark') end
    if now_ms <= tonumber(ms) then
        id = ms .. '-' .. string.format('%.0f', tonumber(sequence) + 1)
    end
end
local appended = redis.call('XADD', KEYS[1], id,
    'channel', ARGV[1], 'payload', ARGV[2], 'bytes', tostring(size),
    'expires', ARGV[5] == '0' and '0' or tostring(now_ms + tonumber(ARGV[5])),
    'deletion_control', string.match(ARGV[1], '^buzz:[%da-fA-F%-]+:conn%-control$')
        and ARGV[2] == '{"op":"DisconnectCommunity"}' and '1' or '0')
bytes = bytes + size
redis.call('RPUSH', KEYS[3], appended .. ':' .. tostring(size))
local count = redis.call('LLEN', KEYS[3])
local cutoff = now_ms - 1800000
for _ = 1, record_limit + 1 do
    local first = redis.call('LINDEX', KEYS[3], 0)
    if not first then break end
    local first_id, removed_bytes = string.match(first, '^([%d%-]+):(%d+)$')
    local first_ms = tonumber(string.match(first_id, '^(%d+)%-'))
    if bytes <= budget and count <= record_limit and first_ms >= cutoff then break end
    redis.call('LPOP', KEYS[3])
    redis.call('XDEL', KEYS[1], first_id)
    bytes = bytes - tonumber(removed_bytes)
    count = count - 1
    redis.call('HSET', KEYS[2], 'trimmed', first_id)
end
local oldest = redis.call('LINDEX', KEYS[3], 0)
if oldest then
    redis.call('XTRIM', KEYS[1], 'MINID', string.match(oldest, '^([%d%-]+):'))
else
    redis.call('XTRIM', KEYS[1], 'MAXLEN', 0)
end
redis.call('EXPIRE', KEYS[1], 1800)
redis.call('EXPIRE', KEYS[3], 1800)
redis.call('HSET', KEYS[2], 'epoch', epoch, 'last', appended, 'bytes', tostring(bytes))
redis.call('PUBLISH', ARGV[4], cjson.encode({appended, ARGV[2]}))
return redis.call('PUBLISH', ARGV[1], ARGV[2])
"#;

// Credentials retain their legacy live semantics without entering the stream,
// ledger or metadata. Only a scalar continuity counter is retained. Counter
// increment and PUBLISH are ordered atomically against all buffered publishers.
const LIVE_ONLY: &str = r#"
local actual = redis.call('TYPE', KEYS[1]).ok
if actual ~= 'none' and actual ~= 'hash' then
    return redis.error_reply('invalid transport metadata type')
end
redis.call('HINCRBY', KEYS[1], 'unbuffered', 1)
return redis.call('PUBLISH', ARGV[1], ARGV[2])
"#;

// Read watermark and bounded rows in one read-only command: a concurrent trim
// cannot erase a prefix between a separate watermark check and the page read.
const READ: &str = r#"
local epoch = redis.call('HGET', KEYS[2], 'epoch') or ''
local last = redis.call('HGET', KEYS[2], 'last') or '0-0'
local trimmed = redis.call('HGET', KEYS[2], 'trimmed') or '0-0'
local unbuffered = redis.call('HGET', KEYS[2], 'unbuffered') or '0'
if redis.call('EXISTS', KEYS[1]) == 0 then trimmed = last end
return {epoch, last, trimmed, unbuffered, redis.call('XRANGE', KEYS[1], '(' .. ARGV[1], '+', 'COUNT', 128)}
"#;

// Only a deletion-fenced community owner calls this. Entries are bounded by the
// same 4096-record ledger; XDEL removes payloads without treating unrelated
// communities' cursors as retention loss. Preserve only the typed lifecycle
// tombstone: community routing ID plus the exact DisconnectCommunity constant.
// It contains no user, ACL, channel, event or arbitrary payload data, and keeps
// the existing deletion disconnect deliverable after user-payload erasure.
// This audit/control metadata shares the same byte/count/30-minute bound.
// Ledger IDs/sizes contain no payload.
const COMMUNITY_RECORDS: &str = r#"
local count = 0
for _, row in ipairs(redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', 4096)) do
    if string.sub(row[2][2], 1, #ARGV[1]) == ARGV[1] and row[2][10] ~= '1' then
        count = count + 1
        if ARGV[2] == 'erase' then redis.call('XDEL', KEYS[1], row[1]) end
    end
end
return count
"#;

pub(crate) fn modern_channel(channel: &str) -> String {
    format!("{MODERN_PREFIX}{channel}")
}

pub(crate) async fn publish(
    pool: &deadpool_redis::Pool,
    channel: &str,
    payload: &str,
) -> Result<i64, PubSubError> {
    publish_with_ttl(pool, channel, payload, 0).await
}

pub(crate) async fn publish_unbuffered(
    pool: &deadpool_redis::Pool,
    channel: &str,
    payload: &str,
) -> Result<i64, PubSubError> {
    let mut command = redis::cmd("EVAL");
    command
        .arg(LIVE_ONLY)
        .arg(1)
        .arg(METADATA)
        .arg(channel)
        .arg(payload);
    crate::writer::write(pool, &command).await
}

pub(crate) async fn publish_with_ttl(
    pool: &deadpool_redis::Pool,
    channel: &str,
    payload: &str,
    replay_ttl_ms: u32,
) -> Result<i64, PubSubError> {
    let epoch = uuid::Uuid::new_v4().to_string();
    let modern = modern_channel(channel);
    let mut command = redis::cmd("EVAL");
    command
        .arg(APPEND)
        .arg(3)
        .arg(STREAM)
        .arg(METADATA)
        .arg(LEDGER)
        .arg(channel)
        .arg(payload)
        .arg(&epoch)
        .arg(&modern)
        .arg(replay_ttl_ms);
    crate::writer::write(pool, &command).await
}

pub(crate) async fn community_records(
    pool: &deadpool_redis::Pool,
    community: buzz_core::CommunityId,
    erase: bool,
) -> Result<u64, PubSubError> {
    let mut command = redis::cmd(if erase { "EVAL" } else { "EVAL_RO" });
    command
        .arg(COMMUNITY_RECORDS)
        .arg(1)
        .arg(STREAM)
        .arg(format!("buzz:{community}:"))
        .arg(if erase { "erase" } else { "count" });
    if erase {
        crate::writer::write(pool, &command).await
    } else {
        Ok(command.query_async(&mut *pool.get().await?).await?)
    }
}

/// A Redis stream id has exact integer components; never compare it lexically.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Position(pub u64, pub u64);

impl Position {
    pub(crate) fn parse(raw: &str) -> Result<Self, PubSubError> {
        let (milliseconds, sequence) = raw.split_once('-').ok_or(PubSubError::ReplayGap)?;
        if milliseconds.is_empty()
            || sequence.is_empty()
            || !milliseconds.bytes().all(|byte| byte.is_ascii_digit())
            || !sequence.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(PubSubError::ReplayGap);
        }
        Ok(Self(
            milliseconds.parse().map_err(|_| PubSubError::ReplayGap)?,
            sequence.parse().map_err(|_| PubSubError::ReplayGap)?,
        ))
    }
}

pub(crate) struct Page {
    pub(crate) epoch: String,
    pub(crate) last: Position,
    pub(crate) trimmed: Position,
    pub(crate) unbuffered: u64,
    pub(crate) rows: StreamRangeReply,
}

pub(crate) async fn read(
    connection: &mut MultiplexedConnection,
    after: Position,
) -> Result<Page, PubSubError> {
    let (epoch, last, trimmed, unbuffered, rows): (String, String, String, u64, StreamRangeReply) =
        redis::cmd("EVAL_RO")
            .arg(READ)
            .arg(2)
            .arg(STREAM)
            .arg(METADATA)
            .arg(format!("{}-{}", after.0, after.1))
            .query_async(connection)
            .await?;
    Ok(Page {
        epoch,
        last: Position::parse(&last)?,
        trimmed: Position::parse(&trimmed)?,
        unbuffered,
        rows,
    })
}

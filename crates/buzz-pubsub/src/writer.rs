//! Refresh stale primary connections only after a definite, unexecuted write.

use std::net::IpAddr;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use deadpool_redis::Pool;
use redis::aio::{ConnectionLike, MultiplexedConnection};
use redis::{ConnectionAddr, ConnectionInfo};
use tokio::time::{timeout_at, Instant};

use crate::PubSubError;

// Closed per-pod names for canonical Redis and its temporary replica. The
// operator requires actual native Service/controller/DNS custody before any
// handover; no advertised arbitrary address is used.
const PEERS: [&str; 2] = [
    "buzz-redis-0.buzz-redis-headless.buzz.svc.cluster.local",
    "buzz-redis-transfer-0.buzz-redis-transfer-headless.buzz.svc.cluster.local",
];
const SERVICES: [&str; 4] = [
    "buzz-redis",
    "buzz-redis.buzz",
    "buzz-redis.buzz.svc",
    "buzz-redis.buzz.svc.cluster.local",
];

type PoolIdentity = Box<dyn Fn(&Pool) -> Option<bool> + Send + Sync>;

struct Route {
    identity: PoolIdentity,
    original: ConnectionInfo,
}

fn routes() -> &'static Mutex<Vec<Route>> {
    static ROUTES: OnceLock<Mutex<Vec<Route>>> = OnceLock::new();
    ROUTES.get_or_init(|| Mutex::new(Vec::new()))
}

// Bind the same configuration used to construct this pool, retaining no strong
// pool reference. Expired entries are removed before identity comparison, so a
// newly allocated manager can never inherit a previous pool's credentials.
pub(crate) fn register(pool: &Pool, url: &str) {
    let Ok(client) = redis::Client::open(url) else {
        return;
    };
    let original = client.get_connection_info().clone();
    let enabled = matches!(original.addr(), ConnectionAddr::Tcp(host, 6379)
        if SERVICES.contains(&host.trim_end_matches('.').to_ascii_lowercase().as_str()));
    let mut entries = routes().lock().unwrap_or_else(|error| error.into_inner());
    entries.retain(|entry| (entry.identity)(pool) == Some(false));
    if enabled {
        let weak = pool.weak();
        entries.push(Route {
            identity: Box::new(move |candidate| {
                weak.upgrade()
                    .map(|live| std::ptr::eq(live.manager(), candidate.manager()))
            }),
            original,
        });
    }
}

fn original(pool: &Pool) -> Option<ConnectionInfo> {
    let mut entries = routes().lock().unwrap_or_else(|error| error.into_inner());
    entries.retain(|entry| (entry.identity)(pool).is_some());
    entries
        .iter()
        .find_map(|entry| ((entry.identity)(pool) == Some(true)).then(|| entry.original.clone()))
}

fn normalized(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(address) => address
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(address)),
        address => address,
    }
}

async fn primary(
    rejected: &mut MultiplexedConnection,
    original: ConnectionInfo,
) -> Option<MultiplexedConnection> {
    if rejected.get_db() != original.redis_settings().db() {
        return None;
    }
    let identity: String = redis::cmd("ACL")
        .arg("WHOAMI")
        .query_async(rejected)
        .await
        .ok()?;
    if identity != original.redis_settings().username().unwrap_or("default") {
        return None;
    }
    let role: redis::Value = redis::cmd("ROLE").query_async(rejected).await.ok()?;
    let redis::Value::Array(values) = role else {
        return None;
    };
    if values.len() != 5 {
        return None;
    }
    let label: String = redis::from_redis_value(values[0].clone()).ok()?;
    let host: String = redis::from_redis_value(values[1].clone()).ok()?;
    let port: u16 = redis::from_redis_value(values[2].clone()).ok()?;
    let state: String = redis::from_redis_value(values[3].clone()).ok()?;
    if label != "slave" || port != 6379 || state != "connected" {
        return None;
    }

    let advertised = host.parse::<IpAddr>().ok().map(normalized);
    let hostname = host.trim_end_matches('.').to_ascii_lowercase();
    let mut target = None;
    for peer in PEERS {
        // A DNS answer is custody only for these two fixed per-pod headless
        // names. IPv4-mapped IPv6 is normalized, without accepting a CIDR range.
        let Ok(addresses) = tokio::net::lookup_host((peer, 6379)).await else {
            continue;
        };
        for address in addresses {
            let ip = normalized(address.ip());
            if advertised == Some(ip) || (advertised.is_none() && hostname == peer) {
                if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
                    return None;
                }
                target = Some(ip);
                break;
            }
        }
        if target.is_some() {
            break;
        }
    }
    let target = target?;
    // Change the address only. Username/password, database, protocol and TCP
    // settings remain exactly those of this original configured pool.
    let client =
        redis::Client::open(original.set_addr(ConnectionAddr::Tcp(target.to_string(), 6379)))
            .ok()?;
    let mut connection = client.get_multiplexed_async_connection().await.ok()?;
    let role: redis::Value = redis::cmd("ROLE").query_async(&mut connection).await.ok()?;
    let redis::Value::Array(values) = role else {
        return None;
    };
    if values.len() != 3
        || redis::from_redis_value::<String>(values[0].clone())
            .ok()?
            .as_str()
            != "master"
    {
        return None;
    }
    Some(connection)
}

enum WriterConnection {
    Pooled(deadpool_redis::Connection),
    Direct(MultiplexedConnection),
}

impl WriterConnection {
    fn raw(&mut self) -> &mut MultiplexedConnection {
        match self {
            Self::Pooled(connection) => connection,
            Self::Direct(connection) => connection,
        }
    }

    fn detach(self) -> MultiplexedConnection {
        match self {
            Self::Pooled(connection) => deadpool_redis::Connection::take(connection),
            Self::Direct(connection) => connection,
        }
    }
}

fn exhausted() -> PubSubError {
    redis::RedisError::from((
        redis::ErrorKind::Io,
        "Redis primary retry deadline exhausted",
    ))
    .into()
}

/// Retry only a definite read-only rejection. DNS, primary qualification,
/// connection acquisition, retry writes and waits share one 3.575 second budget.
/// An I/O error, timeout or lost write reply is ambiguous and never retried:
/// a claimed authentication nonce stays claimed.
pub(crate) async fn write<T: redis::FromRedisValue>(
    pool: &Pool,
    command: &redis::Cmd,
) -> Result<T, PubSubError> {
    const DELAYS_MS: [u64; 8] = [25, 50, 100, 200, 400, 800, 1000, 1000];
    let mut deadline = None;
    let mut forwarded: Option<MultiplexedConnection> = None;
    for delay in DELAYS_MS.into_iter().map(Some).chain(std::iter::once(None)) {
        let acquired = async {
            match forwarded.take() {
                Some(connection) => Ok(WriterConnection::Direct(connection)),
                None => pool
                    .get()
                    .await
                    .map(WriterConnection::Pooled)
                    .map_err(PubSubError::from),
            }
        };
        let acquired = match deadline {
            Some(deadline) => timeout_at(deadline, acquired)
                .await
                .unwrap_or_else(|_| Err(exhausted())),
            None => acquired.await,
        };
        let mut connection = match acquired {
            Ok(connection) => connection,
            Err(error) => {
                metrics::counter!("buzz_redis_write_failures_total").increment(1);
                return Err(error);
            }
        };
        let query = command.query_async::<T>(connection.raw());
        let result: Result<T, PubSubError> = match deadline {
            Some(deadline) => timeout_at(deadline, query)
                .await
                .unwrap_or_else(|_| {
                    Err(redis::RedisError::from((
                        redis::ErrorKind::Io,
                        "Redis primary retry deadline exhausted",
                    )))
                })
                .map_err(PubSubError::from),
            None => query.await.map_err(PubSubError::from),
        };
        let readonly =
            matches!(&result, Err(PubSubError::Redis(error)) if error.code() == Some("READONLY"));
        if let Some(delay_ms) = delay.filter(|_| readonly) {
            let until =
                *deadline.get_or_insert_with(|| Instant::now() + Duration::from_millis(3575));
            // Only the authenticated peer that definitely rejected this write
            // may nominate a new primary; its nomination is independently bound
            // to fixed native DNS and a master ROLE before any retry is sent.
            let mut rejected = connection.detach();
            if let Some(original) = original(pool) {
                forwarded = timeout_at(until, primary(&mut rejected, original))
                    .await
                    .ok()
                    .flatten();
            }
            drop(rejected);
            drop(pool.retain(|_, _| false));
            metrics::counter!("buzz_redis_primary_refresh_total").increment(1);
            if Instant::now() >= until {
                metrics::counter!("buzz_redis_write_failures_total").increment(1);
                return Err(exhausted());
            }
            tokio::time::sleep_until(std::cmp::min(
                until,
                Instant::now() + Duration::from_millis(delay_ms),
            ))
            .await;
            continue;
        }
        if result.is_err() {
            metrics::counter!("buzz_redis_write_failures_total").increment(1);
        }
        return result;
    }
    unreachable!("the final write result always returns")
}

//! Refresh stale primary connections only after a definite, unexecuted write.

use deadpool_redis::Pool;

use crate::PubSubError;

/// Retry a definite read-only rejection across primary endpoint convergence,
/// with at most 3.575 seconds of bounded delay. An I/O error or lost reply is
/// ambiguous and is never retried: a claimed authentication nonce stays claimed.
pub(crate) async fn write<T: redis::FromRedisValue>(
    pool: &Pool,
    command: &redis::Cmd,
) -> Result<T, PubSubError> {
    const DELAYS_MS: [u64; 8] = [25, 50, 100, 200, 400, 800, 1000, 1000];
    for delay in DELAYS_MS.into_iter().map(Some).chain(std::iter::once(None)) {
        let mut connection = match pool.get().await {
            Ok(connection) => connection,
            Err(error) => {
                metrics::counter!("buzz_redis_write_failures_total").increment(1);
                return Err(error.into());
            }
        };
        let result = command.query_async(&mut *connection).await;
        if let Some(delay_ms) = delay.filter(|_| {
            result
                .as_ref()
                .is_err_and(|error| error.code() == Some("READONLY"))
        }) {
            // Detach this rejected connection before pruning idle connections.
            // Active borrowers detach their own stale connection if rejected;
            // fresh connections resolve the unchanged primary service again.
            drop(deadpool_redis::Connection::take(connection));
            drop(pool.retain(|_, _| false));
            metrics::counter!("buzz_redis_primary_refresh_total").increment(1);
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            continue;
        }
        if result.is_err() {
            metrics::counter!("buzz_redis_write_failures_total").increment(1);
        }
        return result.map_err(PubSubError::from);
    }
    unreachable!("the final write result always returns")
}

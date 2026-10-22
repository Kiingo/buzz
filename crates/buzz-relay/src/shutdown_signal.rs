//! The process shutdown signal, installed before any startup work.
//!
//! In a container the relay is usually PID 1. The kernel never applies a
//! default signal action to PID 1, so a SIGTERM that arrives before a handler
//! exists is dropped: the process keeps booting into a pod the kubelet is
//! already terminating and is SIGKILLed when the grace period ends, with no
//! drain and no cleanup. Installing the handler first means a SIGTERM at any
//! point is observed. Startup flips the relay's shutdown flag as soon as
//! [`AppState`](crate::state::AppState) exists, and `serve` runs the normal
//! grace, drain and clean exit even when the signal arrived during startup.

use tokio::sync::watch;

/// A latched SIGTERM / Ctrl+C observation. Cheap to clone; every clone sees
/// the same signal.
#[derive(Clone, Debug)]
pub struct ShutdownSignal {
    received: watch::Receiver<bool>,
}

impl ShutdownSignal {
    /// Install the SIGTERM (Unix) and Ctrl+C handlers now and latch the first
    /// one that fires. Call before startup work begins; must run inside the
    /// Tokio runtime.
    pub fn install() -> std::io::Result<Self> {
        let (tx, received) = watch::channel(false);
        #[cfg(unix)]
        let mut sigterm =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::spawn(async move {
            #[cfg(unix)]
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = sigterm.recv() => {},
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
            let _ = tx.send(true);
        });
        Ok(Self { received })
    }

    /// A signal driven by the returned sender instead of the OS, for tests.
    pub fn manual() -> (watch::Sender<bool>, Self) {
        let (tx, received) = watch::channel(false);
        (tx, Self { received })
    }

    /// Whether the signal has fired.
    pub fn received(&self) -> bool {
        *self.received.borrow()
    }

    /// Resolve once the signal has fired, immediately if it already has.
    pub async fn wait(&self) {
        let mut received = self.received.clone();
        // An error means the sender is gone without ever firing, which only a
        // test can cause; treat it as "never".
        if received.wait_for(|fired| *fired).await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// A signal that fired before anyone waited (SIGTERM during startup) is
    /// still observed by a later `wait`.
    #[tokio::test]
    async fn signal_before_wait_is_latched() {
        let (tx, signal) = ShutdownSignal::manual();
        assert!(!signal.received());
        tx.send(true).unwrap();
        assert!(signal.received());
        tokio::time::timeout(Duration::from_secs(1), signal.clone().wait())
            .await
            .expect("an already-fired signal resolves wait immediately");
    }

    #[tokio::test]
    async fn wait_resolves_when_signal_fires() {
        let (tx, signal) = ShutdownSignal::manual();
        let waiter = tokio::spawn({
            let signal = signal.clone();
            async move { signal.wait().await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiter.is_finished());
        tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("wait resolves after the signal")
            .unwrap();
    }
}

//! The agent key stays in buzz-acp. Children get signing, never the key.
//!
//! Stated limit: a compromised child can sign as its agent while it runs. This
//! stops key theft and lasting impersonation, not misuse during the child's
//! life. No op signs caller-supplied bytes or an id, and `sign_event` is
//! default deny, so what a child can sign is the list in [`policy`].

mod ops;
mod policy;
mod server;
#[cfg(test)]
mod tests;

pub(crate) use ops::Signer;
pub(crate) use server::SignerServer;

/// Hosted runs mark themselves with this. Only those promise a non-dumpable
/// buzz-acp, from exec'ing a root-owned execute-only binary.
const HOSTED_MARKER_ENV: &str = "BUZZ_ACP_PUBLICATION_TOKEN";

/// Refuses to start a hosted run that a same-uid child could dump. buzz-acp only
/// checks; a broken image should fail here rather than be quietly fixed.
pub(crate) fn require_not_dumpable() -> anyhow::Result<()> {
    if std::env::var_os(HOSTED_MARKER_ENV).is_none() {
        return Ok(());
    }
    if process_is_dumpable()? {
        tracing::error!(
            target: "buzz_signer",
            event = "buzz_acp_refused_dumpable",
            "hosted buzz-acp is dumpable"
        );
        anyhow::bail!("buzz_acp_refused_dumpable");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn process_is_dumpable() -> anyhow::Result<bool> {
    Ok(nix::sys::prctl::get_dumpable()?)
}

/// Only Linux has this property, and hosted runs are Linux only.
#[cfg(not(target_os = "linux"))]
fn process_is_dumpable() -> anyhow::Result<bool> {
    Ok(false)
}

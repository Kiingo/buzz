//! Operator-only runtime trust provisioning. No event can provision its own
//! issuer; the configured deployment host selects the database community.

use anyhow::{bail, Context, Result};

pub(super) async fn ensure(issuer: String, key_id: String, public_key: String) -> Result<i32> {
    // Require an explicit target for trust writes, even though older generic
    // admin commands retain development defaults.
    for name in ["DATABASE_URL", "RELAY_URL"] {
        if std::env::var(name).map_or(true, |value| value.trim().is_empty()) {
            bail!("{name} is required for runtime issuer provisioning");
        }
    }
    if public_key.len() != 64
        || !public_key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("runtime verification key must be 32-byte lowercase hex");
    }
    let bytes: [u8; 32] = hex::decode(&public_key)
        .context("invalid runtime verification key")?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid runtime verification key length"))?;
    let db = super::connect_db().await?;
    let tenant = super::resolve_admin_tenant(&db).await?;
    db.ensure_managed_runtime_issuer(tenant.community(), &issuer, &key_id, &bytes)
        .await?;
    println!("runtime issuer verification key reconciled");
    Ok(0)
}

//! Curated CA bundle for the git subprocesses Buzz itself configures.
//!
//! Apple's system git and its libcurl trust `/etc/ssl/cert.pem`, which macOS
//! trust-store updates do not touch. In October 2026 eight eMudhra
//! intermediate CAs turned out to have guessable private keys. They chain to
//! "emSign ECC Root CA - G3" and are cross-signed by Sectigo/Comodo "AAA
//! Certificate Services", and both roots were still in that file. Anyone
//! holding a certificate from those intermediates could intercept git traffic
//! to the relay, including its Nostr-signed git login, and to GitHub.
//!
//! On macOS Buzz writes a filtered copy of the system bundle and points its
//! git at it with `http.sslCAInfo`:
//!
//! - The source is `/etc/ssl/cert.pem`, so a corporate CA that an
//!   administrator appended there keeps working. If that file cannot be read
//!   or holds no usable certificate, Mozilla's root list compiled into the app
//!   (`webpki-root-certs`) is used instead.
//! - Every certificate whose subject names emSign, eMudhra or AAA Certificate
//!   Services is dropped.
//! - `GIT_SSL_CAINFO` or `GIT_SSL_CAPATH` in the environment is an operator's
//!   deliberate CA choice, and git lets it override `http.sslCAInfo`. Buzz
//!   then builds and passes no bundle.
//! - If the bundle cannot be written, git keeps its default trust and Buzz
//!   logs a warning. TLS verification is never turned off.
//!
//! Desktop's own git runs with system and global git config disabled, so it
//! gets the bundle for every remote. Agent harnesses keep the user's git
//! config, so they get it only for the active relay's git URLs; other remotes
//! keep whatever trust the user configured. Other platforms are unchanged:
//! Git for Windows and Linux distributions ship their own trust stores.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use base64::Engine as _;
use rustls::pki_types::{pem::PemObject, CertificateDer};
use sha2::{Digest, Sha256};

const SYSTEM_BUNDLE: &str = "/etc/ssl/cert.pem";

/// Lowercase ASCII fragments of subject names that Buzz's git must never
/// trust: every emSign / eMudhra root, and the AAA Certificate Services root
/// that cross-signed the compromised eMudhra intermediates.
const DISTRUSTED_SUBJECT_FRAGMENTS: &[&str] = &["emsign", "emudhra", "aaa certificate services"];

/// Environment variables through which an operator picks git's CA trust.
const OPERATOR_CA_ENV: &[&str] = &["GIT_SSL_CAINFO", "GIT_SSL_CAPATH"];

/// Path of the curated bundle for Buzz's git, or `None` when git should keep
/// its default trust: off macOS, when an operator set a CA through the
/// environment, or when the bundle could not be written.
pub(crate) fn git_ssl_ca_info() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") || operator_ca_configured(|name| std::env::var_os(name)) {
        return None;
    }
    static BUNDLE: Mutex<Option<PathBuf>> = Mutex::new(None);
    let mut bundle = BUNDLE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(path) = bundle.as_ref().filter(|path| path.is_file()) {
        return Some(path.clone());
    }
    let dir = dirs::data_dir()?.join("Buzz").join("tls");
    let pem = curated_bundle_pem(std::fs::read(SYSTEM_BUNDLE).ok().as_deref());
    match write_bundle(&dir, &pem) {
        Ok(path) => {
            *bundle = Some(path.clone());
            Some(path)
        }
        Err(error) => {
            eprintln!(
                "buzz-desktop: could not write the curated git CA bundle ({error}); git keeps its default trust"
            );
            None
        }
    }
}

/// Scope the curated bundle to the relay's git URLs for an agent harness.
///
/// Appends `http.<relay>/git.sslCAInfo` after any git config entries already
/// staged on `command` (or inherited from Desktop's own environment).
/// Built-in harnesses carry inherited entries into every git process they
/// start; custom harnesses pass the environment through.
pub(crate) fn apply_relay_git_ca_info(
    command: &mut Command,
    relay_http_url: &str,
    bundle: Option<&Path>,
) {
    let Some(bundle) = bundle else {
        return;
    };
    let index = staged_git_config_count(command);
    command.env("GIT_CONFIG_COUNT", (index + 1).to_string());
    command.env(
        format!("GIT_CONFIG_KEY_{index}"),
        format!("http.{relay_http_url}/git.sslCAInfo"),
    );
    command.env(format!("GIT_CONFIG_VALUE_{index}"), bundle);
}

fn staged_git_config_count(command: &Command) -> usize {
    let staged = command
        .get_envs()
        .find(|(key, _)| *key == "GIT_CONFIG_COUNT")
        .map(|(_, value)| value.and_then(|value| value.to_str().map(str::to_owned)));
    let count = match staged {
        Some(value) => value,
        None => std::env::var("GIT_CONFIG_COUNT").ok(),
    };
    count.and_then(|count| count.parse().ok()).unwrap_or(0)
}

fn operator_ca_configured(var: impl Fn(&str) -> Option<std::ffi::OsString>) -> bool {
    OPERATOR_CA_ENV
        .iter()
        .any(|name| var(name).is_some_and(|value| !value.is_empty()))
}

/// The curated bundle as PEM: the system bundle without distrusted roots, or
/// Mozilla's compiled-in roots without them when the system bundle yields
/// nothing.
pub(crate) fn curated_bundle_pem(system_bundle: Option<&[u8]>) -> String {
    let system = system_bundle
        .map(|bytes| {
            CertificateDer::pem_slice_iter(bytes)
                .filter_map(Result::ok)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let pem = trusted_pem(system.iter());
    if pem.is_empty() {
        trusted_pem(webpki_root_certs::TLS_SERVER_ROOT_CERTS.iter())
    } else {
        pem
    }
}

fn trusted_pem<'a>(certs: impl Iterator<Item = &'a CertificateDer<'a>>) -> String {
    let mut pem = String::new();
    for cert in certs.filter(|cert| !is_distrusted(cert)) {
        push_pem(&mut pem, cert.as_ref());
    }
    pem
}

/// Matches on the parsed subject name. A certificate whose subject cannot be
/// parsed is matched on all of its bytes, so it is still dropped when it
/// names a distrusted CA anywhere.
fn is_distrusted(cert: &CertificateDer<'_>) -> bool {
    let subject = webpki::anchor_from_trusted_cert(cert)
        .ok()
        .map(|anchor| anchor.subject.as_ref().to_vec());
    names_distrusted_ca(subject.as_deref().unwrap_or(cert.as_ref()))
}

fn names_distrusted_ca(der: &[u8]) -> bool {
    let lower = der.to_ascii_lowercase();
    DISTRUSTED_SUBJECT_FRAGMENTS.iter().any(|fragment| {
        lower
            .windows(fragment.len())
            .any(|window| window == fragment.as_bytes())
    })
}

fn push_pem(out: &mut String, der: &[u8]) {
    let encoded = base64::engine::general_purpose::STANDARD.encode(der);
    out.push_str("-----BEGIN CERTIFICATE-----\n");
    // Base64 is ASCII, so any byte offset is a char boundary.
    let mut start = 0;
    while start < encoded.len() {
        let end = (start + 64).min(encoded.len());
        out.push_str(&encoded[start..end]);
        out.push('\n');
        start = end;
    }
    out.push_str("-----END CERTIFICATE-----\n");
}

/// Write `pem` to a content-addressed file in `dir`, reusing an identical
/// existing file. The rename is atomic, so a concurrent git never reads a
/// partial bundle.
fn write_bundle(dir: &Path, pem: &str) -> std::io::Result<PathBuf> {
    let digest = hex::encode(Sha256::digest(pem.as_bytes()));
    let path = dir.join(format!("git-ca-{}.pem", &digest[..16]));
    if std::fs::read(&path).is_ok_and(|existing| existing == pem.as_bytes()) {
        return Ok(path);
    }
    std::fs::create_dir_all(dir)?;
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    file.write_all(pem.as_bytes())?;
    file.as_file().sync_all()?;
    file.persist(&path).map_err(|error| error.error)?;
    Ok(path)
}

#[cfg(test)]
mod tests;

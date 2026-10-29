//! Monotonic floor for in-app updates (79 SHOULD-BUZZ-FEED-ROLLBACK).
//!
//! The updater verifies the archive's minisign signature with the embedded
//! key, but `latest.json` itself is unsigned: whoever controls the feed picks
//! the version label and which validly signed archive it points to. This
//! comparator replaces the plugin's default and accepts an update only when
//! both hold, failing closed otherwise:
//!
//! 1. The advertised version is strictly newer than the running build (never
//!    equal, never older).
//! 2. Every platform signature in the release carries a `timestamp:` in its
//!    minisign trusted comment that is later than this build's compile time.
//!    `tauri signer sign` writes that timestamp, and the trusted comment is
//!    covered by the global signature the plugin verifies with the embedded
//!    key before installing, so it cannot be edited without failing that
//!    check. A feed that relabels an older, validly signed archive with a new
//!    version number is refused here: that archive was signed before this
//!    build existed.
//!
//! Residual gap: an archive signed after this build was compiled but older in
//! product terms (for example a release run that overlapped this one) still
//! passes. A signed feed, or a signed build number inside the archive, would
//! close that.

use base64::Engine as _;
use tauri_plugin_updater::{RemoteRelease, RemoteReleaseInner};

/// Unix seconds when `build.rs` ran for this binary.
const BUILD_UNIX_TIME: &str = env!("BUZZ_DESKTOP_BUILD_UNIX_TIME");

/// The updater's version comparator: true only for a release that passes
/// both checks above.
pub(crate) fn accept_update(current: semver::Version, release: RemoteRelease) -> bool {
    let build_time = BUILD_UNIX_TIME.parse::<u64>().ok().filter(|time| *time > 0);
    match update_refusal(&current, &release, build_time) {
        None => true,
        Some(reason) => {
            tracing::warn!(
                event = "update_refused",
                current = %current,
                offered = %release.version,
                %reason,
                "refused an update the feed offered"
            );
            false
        }
    }
}

fn update_refusal(
    current: &semver::Version,
    release: &RemoteRelease,
    build_time: Option<u64>,
) -> Option<String> {
    if release.version <= *current {
        return Some(format!(
            "feed version {} is not newer than the running {current}",
            release.version
        ));
    }
    let Some(build_time) = build_time else {
        return Some("this build has no compile time to compare signatures with".to_string());
    };
    let signatures: Vec<&str> = match &release.data {
        RemoteReleaseInner::Dynamic(platform) => vec![platform.signature.as_str()],
        RemoteReleaseInner::Static { platforms } => platforms
            .values()
            .map(|platform| platform.signature.as_str())
            .collect(),
    };
    if signatures.is_empty() {
        return Some("feed lists no signed platform".to_string());
    }
    for signature in signatures {
        match signed_timestamp(signature) {
            Some(signed) if signed > build_time => {}
            Some(signed) => {
                return Some(format!(
                    "archive for {} was signed at {signed}, not after this build ({build_time}); \
                     an older release relabelled as newer",
                    release.version
                ))
            }
            None => return Some("a platform signature has no signed timestamp".to_string()),
        }
    }
    None
}

/// The `timestamp:` from a base64 minisign signature's trusted comment, read
/// the way the plugin decodes it (no trimming).
fn signed_timestamp(signature_b64: &str) -> Option<u64> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(signature_b64)
        .ok()?;
    let text = std::str::from_utf8(&decoded).ok()?;
    let signature = minisign_verify::Signature::decode(text).ok()?;
    signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("timestamp:"))
        .and_then(|value| value.parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real Tauri updater signature (public material): trusted comment
    // `timestamp:1793239858\tfile:Buzz.app.tar.gz`.
    const SIGNATURE_TEXT: &str = "untrusted comment: signature from tauri secret key\n\
RURjwwaXU+GBsMgpGz/xyO2Hg2kvN+Gs5FrQk+bSBOdXUA8uz091VM5ShFrM3aXKEbkd2+QLbhdIEE2e5NguyQy5LPuKJDcaugg=\n\
trusted comment: timestamp:1793239858\tfile:Buzz.app.tar.gz\n\
SdhX5wG+sSo0Or4ZiEBO2kBrxVSv5mr6gAqa3Z0oRQNXNvZIr44mrr1JCc5FR2Dfqel0CpEnC48/QBgqrFdiBQ==\n";
    const SIGNED_AT: u64 = 1_793_239_858;

    fn release(version: &str, signature_text: &str) -> RemoteRelease {
        let signature = base64::engine::general_purpose::STANDARD.encode(signature_text);
        serde_json::from_value(serde_json::json!({
            "version": version,
            "platforms": {
                "darwin-aarch64": { "url": "https://example.test/a.tar.gz", "signature": signature },
            },
        }))
        .expect("release")
    }

    fn version(value: &str) -> semver::Version {
        semver::Version::parse(value).expect("version")
    }

    #[test]
    fn reads_the_signed_timestamp() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(SIGNATURE_TEXT);
        assert_eq!(signed_timestamp(&encoded), Some(SIGNED_AT));
        assert_eq!(signed_timestamp("not base64"), None);
    }

    #[test]
    fn refuses_equal_or_older_versions() {
        let current = version("0.5.28-kiingo.35");
        for offered in ["0.5.28-kiingo.35", "0.5.28-kiingo.34", "0.5.27"] {
            let refusal = update_refusal(&current, &release(offered, SIGNATURE_TEXT), Some(1));
            assert!(refusal.is_some(), "{offered} must be refused");
        }
    }

    #[test]
    fn refuses_an_old_archive_relabelled_as_newer() {
        let current = version("0.5.28-kiingo.35");
        let relabelled = release("0.5.28-kiingo.99", SIGNATURE_TEXT);
        assert!(update_refusal(&current, &relabelled, Some(SIGNED_AT)).is_some());
        assert!(update_refusal(&current, &relabelled, Some(SIGNED_AT + 1)).is_some());
        assert!(update_refusal(&current, &relabelled, None).is_some());
        assert_eq!(
            update_refusal(&current, &relabelled, Some(SIGNED_AT - 1)),
            None
        );
    }

    #[test]
    fn refuses_a_signature_without_a_timestamp() {
        let current = version("0.5.28-kiingo.35");
        let unstamped = SIGNATURE_TEXT.replace("timestamp:1793239858\t", "");
        let offered = release("0.5.28-kiingo.36", &unstamped);
        assert!(update_refusal(&current, &offered, Some(1)).is_some());
    }
}

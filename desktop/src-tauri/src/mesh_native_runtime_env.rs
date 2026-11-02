//! Process environment for the MeshLLM native runtime, fixed before anything
//! else runs.
//!
//! `mesh_llm::pinned_runtime` installs only the runtime pinned in this build,
//! into a runtime cache Buzz owns, and removes anything else it finds there.
//! The host runtime reads three environment variables on the same path:
//!
//! * `MESH_LLM_NATIVE_RUNTIME_CACHE_DIR` (mesh-llm runtime-install cache.rs:31-48)
//!   is pointed at Buzz's own cache in every build, so Buzz never prunes the
//!   cache a standalone `mesh-llm` shares, and never loads one it did not check.
//! * `MESH_LLM_NATIVE_RUNTIME_MANIFEST_URL` (manifest.rs:338-354) is replaced in
//!   release builds by a value no client can fetch. The host runtime's own
//!   fallback install has no public switch to turn downloads off, so this makes
//!   any fallback fetch fail closed instead of installing unpinned bytes, and a
//!   launching process can no longer redirect the manifest.
//! * `MESH_LLM_NATIVE_RUNTIME_BUNDLE_DIR` (discovery.rs:13) is removed in
//!   release builds, so a launching process cannot add runtime bundles.
//!
//! Debug builds keep the upstream URL and bundle overrides for development; the
//! pinned install never reads them.

use std::path::PathBuf;

const CACHE_DIR_ENV: &str = "MESH_LLM_NATIVE_RUNTIME_CACHE_DIR";
#[cfg(not(debug_assertions))]
const MANIFEST_URL_ENV: &str = "MESH_LLM_NATIVE_RUNTIME_MANIFEST_URL";
#[cfg(not(debug_assertions))]
const BUNDLE_DIR_ENV: &str = "MESH_LLM_NATIVE_RUNTIME_BUNDLE_DIR";
/// Not a URL any HTTP client accepts: the host runtime's fallback manifest
/// fetch fails on it.
#[cfg(not(debug_assertions))]
const DOWNLOAD_DISABLED: &str = "buzz-pinned-runtime:download-disabled";

/// Buzz's own MeshLLM native runtime cache.
fn buzz_runtime_cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("Buzz")
        .join("mesh-native-runtimes")
}

/// Fix the MeshLLM native runtime environment for this process.
///
/// Call from `main` while the process is still single threaded: it uses
/// `std::env::set_var` and `remove_var`, which are only sound there.
pub fn apply() {
    std::env::set_var(CACHE_DIR_ENV, buzz_runtime_cache_dir());
    #[cfg(not(debug_assertions))]
    {
        std::env::set_var(MANIFEST_URL_ENV, DOWNLOAD_DISABLED);
        std::env::remove_var(BUNDLE_DIR_ENV);
    }
}

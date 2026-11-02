//! The MeshLLM native runtime this Buzz build will load, sealed into the binary.
//!
//! Upstream MeshLLM native runtimes are checksummed but not signed: the release
//! manifest and its `.sha256` come from the same GitHub release, and the host
//! runtime trusts whatever that release serves. This build carries the exact
//! `native-runtimes.json` bytes for its locked mesh-llm tag
//! (`desktop/src-tauri/mesh-native-runtime/`, written by
//! `scripts/update-mesh-native-runtime-pin.py`), and that manifest carries every
//! archive sha256 and every per-file sha256. Before anything native is loaded,
//! [`ensure_pinned_native_runtime`] makes the pinned runtime the only one in
//! Buzz's runtime cache:
//!
//! 1. the sealed manifest must hash to the pin and match the bundled MeshLLM
//!    version and Skippy ABI;
//! 2. the runtime is chosen from the sealed manifest (never a fetched one);
//! 3. every cache entry other than a byte-exact copy of that runtime is removed;
//! 4. a missing runtime is downloaded from the pinned release, its archive
//!    sha256 checked before extraction, and extracted by [`extract_pinned_archive`],
//!    which refuses links, devices, unsafe paths and any file the pin does not
//!    name;
//! 5. every copy into the cache gets Buzz's own modes, and nothing another
//!    local user could write (group or other write, here or in the cache
//!    ancestors) is accepted. The cache must be the per-user one `main` set.
//!
//! The host runtime then loads that cached runtime. In release builds its own
//! download path is disabled (`crate::mesh_native_runtime_env`).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use mesh_llm_host_runtime::sdk::native_runtime::{
    current_skippy_abi_version, default_native_runtime_cache, host_runtime_profile,
    native_runtime_cache, select_native_runtime, InstalledNativeRuntime, NativeRuntimeArtifact,
    NativeRuntimeCache, NativeRuntimeManifest, NativeRuntimeReleaseManifest, RuntimeSelection,
    CURRENT_MESH_VERSION, NATIVE_RUNTIME_MANIFEST_FILE,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

const PIN_JSON: &str = include_str!("../../mesh-native-runtime/pin.json");
const MANIFEST_JSON: &[u8] = include_bytes!("../../mesh-native-runtime/native-runtimes.json");

/// Largest runtime archive Buzz will download (the biggest v0.76.2 archive is
/// about 1.6 GB).
const MAX_ARCHIVE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(120);

const INTEGRITY_ERROR: &str = "Share compute is unavailable: the MeshLLM native runtime pin in this Buzz build failed its integrity check. Update Buzz.";

/// `desktop/src-tauri/mesh-native-runtime/pin.json`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pin {
    schema: u32,
    tag: String,
    git_rev: String,
    mesh_version: String,
    skippy_abi: String,
    manifest_sha256: String,
    release_url_prefix: String,
    /// Regular files an archive carries that the manifest does not pin, by
    /// artifact id, exact relative path and sha256. They are checked, never
    /// installed.
    archive_extras: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Debug)]
struct Sealed {
    pin: Pin,
    manifest: NativeRuntimeReleaseManifest,
}

/// Make the pinned native runtime the only runtime in Buzz's cache, installing
/// it from the pinned release when it is missing. Runs once per process; every
/// error leaves nothing new installed and nothing loaded.
pub(super) async fn ensure_pinned_native_runtime() -> Result<()> {
    static VERIFIED: OnceLock<tokio::sync::Mutex<bool>> = OnceLock::new();
    let mut verified = VERIFIED
        .get_or_init(|| tokio::sync::Mutex::new(false))
        .lock()
        .await;
    if *verified {
        return Ok(());
    }
    let sealed = sealed()?;
    check_versions(sealed, CURRENT_MESH_VERSION, &current_skippy_abi_version())?;
    let artifact = select_pinned_artifact(sealed)?;
    let extras = sealed
        .pin
        .archive_extras
        .get(&artifact.id)
        .cloned()
        .unwrap_or_default();
    let cache = default_native_runtime_cache()?;
    require_buzz_cache(
        crate::mesh_native_runtime_env::buzz_runtime_cache_dir().as_deref(),
        cache.root(),
    )?;
    let mesh_version = sealed.pin.mesh_version.clone();

    let present = {
        let (cache, artifact, extras) = (cache.clone(), artifact.clone(), extras.clone());
        tokio::task::spawn_blocking(move || {
            if audit_cache(&cache, &artifact, &extras, &mesh_version)? {
                return Ok(true);
            }
            adopt_from_shared_cache(&cache, &artifact, &extras, &mesh_version)
        })
        .await
        .context("native runtime cache audit stopped")??
    };
    if !present {
        download_and_install(&cache, &artifact, &sealed.pin, extras).await?;
    }
    *verified = true;
    Ok(())
}

/// The host runtime must be using Buzz's own cache (set in `main`); with no
/// per-user cache directory there is nowhere private to put a runtime.
fn require_buzz_cache(expected: Option<&Path>, actual: &Path) -> Result<()> {
    match expected {
        None => Err(anyhow!(
            "Share compute is unavailable: Buzz cannot find a private cache folder for the MeshLLM native runtime on this machine."
        )),
        Some(expected) if expected != actual => {
            eprintln!(
                "buzz-mesh: native runtime cache is {}, expected {}",
                actual.display(),
                expected.display()
            );
            Err(anyhow!("{INTEGRITY_ERROR}"))
        }
        Some(_) => Ok(()),
    }
}

fn sealed() -> Result<&'static Sealed> {
    static SEALED: OnceLock<std::result::Result<Sealed, String>> = OnceLock::new();
    SEALED
        .get_or_init(|| {
            sealed_from(PIN_JSON, MANIFEST_JSON).map_err(|error| {
                eprintln!("buzz-mesh: native runtime pin rejected: {error:#}");
                INTEGRITY_ERROR.to_string()
            })
        })
        .as_ref()
        .map_err(|message| anyhow!("{message}"))
}

fn sealed_from(pin_json: &str, manifest_bytes: &[u8]) -> Result<Sealed> {
    let pin: Pin = serde_json::from_str(pin_json).context("parse pin.json")?;
    anyhow::ensure!(pin.schema == 1, "unsupported pin schema {}", pin.schema);
    let actual = sha256_hex(manifest_bytes);
    anyhow::ensure!(
        actual == pin.manifest_sha256,
        "sealed manifest sha256 {actual} != pin {}",
        pin.manifest_sha256
    );
    let manifest = NativeRuntimeReleaseManifest::from_json_str(
        std::str::from_utf8(manifest_bytes).context("sealed manifest is not UTF-8")?,
    )?;
    anyhow::ensure!(
        manifest.mesh_version == pin.mesh_version && manifest.skippy_abi == pin.skippy_abi,
        "sealed manifest is MeshLLM {} / Skippy ABI {}, pin says {} / {}",
        manifest.mesh_version,
        manifest.skippy_abi,
        pin.mesh_version,
        pin.skippy_abi
    );
    anyhow::ensure!(
        pin.tag == format!("v{}", pin.mesh_version) && pin.git_rev.len() == 40,
        "pin tag {} / rev {} do not describe MeshLLM {}",
        pin.tag,
        pin.git_rev,
        pin.mesh_version
    );
    Ok(Sealed { pin, manifest })
}

fn check_versions(sealed: &Sealed, mesh_version: &str, skippy_abi: &str) -> Result<()> {
    let pin = &sealed.pin;
    if pin.mesh_version != mesh_version || pin.skippy_abi != skippy_abi {
        return Err(anyhow!(
            "Share compute is unavailable: this Buzz build pins the MeshLLM {} native runtime (Skippy ABI {}), but it bundles MeshLLM {mesh_version} (Skippy ABI {skippy_abi}). Update Buzz.",
            pin.mesh_version,
            pin.skippy_abi
        ));
    }
    Ok(())
}

/// Pick the runtime the host runtime will load, from the sealed manifest, with
/// the same mesh config selection the host runtime reads.
fn select_pinned_artifact(sealed: &Sealed) -> Result<NativeRuntimeArtifact> {
    let pin = &sealed.pin;
    let config_path = mesh_llm_host_runtime::plugin::config_path(None)?;
    let native = mesh_llm_host_runtime::plugin::load_config(None)?
        .runtime
        .native_runtime;
    for (key, value, pinned) in [
        (
            "mesh_version",
            native.mesh_version.as_deref(),
            &pin.mesh_version,
        ),
        ("skippy_abi", native.skippy_abi.as_deref(), &pin.skippy_abi),
    ] {
        if let Some(value) = value.filter(|value| *value != pinned.as_str()) {
            return Err(anyhow!(
                "Share compute is unavailable: {} sets runtime.native_runtime.{key} = \"{value}\", but this Buzz build only runs the pinned MeshLLM {} native runtime.",
                config_path.display(),
                pin.mesh_version
            ));
        }
    }
    let selection = RuntimeSelection::parse(native.selection.as_deref())?;
    let profile = host_runtime_profile();
    let chosen = select_native_runtime(&sealed.manifest, &profile, &pin.mesh_version, &selection)
        .filter(|candidate| candidate.compatible)
        .and_then(|candidate| {
            sealed
                .manifest
                .artifacts
                .iter()
                .find(|artifact| artifact.id == candidate.artifact.id)
                .cloned()
        });
    chosen.ok_or_else(|| {
        anyhow!(
            "Share compute is unavailable on this machine: none of the MeshLLM {} native runtimes pinned in this Buzz build fit this hardware ({}/{}, selection {}).",
            pin.mesh_version,
            profile.os,
            profile.arch,
            native.selection.as_deref().unwrap_or("recommended")
        )
    })
}

/// Remove every cache entry except a byte-exact copy of `artifact`; report
/// whether that copy is present.
fn audit_cache(
    cache: &NativeRuntimeCache,
    artifact: &NativeRuntimeArtifact,
    extras: &BTreeMap<String, String>,
    mesh_version: &str,
) -> Result<bool> {
    let root = cache.root();
    if !root.exists() {
        return Ok(false);
    }
    let scan = cache.installed_lenient()?;
    for skipped in &scan.skipped {
        eprintln!(
            "buzz-mesh: removing unusable native runtime cache entry {}: {}",
            skipped.path.display(),
            skipped.reason
        );
        remove_inside(root, &skipped.path)?;
    }
    let expected_dir = cache.runtime_dir(mesh_version, &artifact.id);
    let mut present = false;
    for runtime in scan.runtimes {
        let verdict = if runtime.path != expected_dir {
            Err(anyhow!("not the pinned runtime"))
        } else {
            require_private_ancestors(root, &runtime.path, &artifact.id).and_then(|()| {
                verify_installed_dir(
                    &runtime.path,
                    &runtime.manifest,
                    artifact,
                    extras,
                    Modes::Private,
                )
            })
        };
        match verdict {
            Ok(()) => present = true,
            Err(reason) => {
                eprintln!(
                    "buzz-mesh: removing native runtime {} from the cache: {reason:#}",
                    runtime.path.display()
                );
                remove_inside(root, &runtime.path)?;
            }
        }
    }
    Ok(present)
}

/// Copy the pinned runtime from mesh-llm's shared cache when a byte-exact copy
/// is already there, so an upgrade does not re-download it. The copy in Buzz's
/// cache is verified again after the copy.
fn adopt_from_shared_cache(
    cache: &NativeRuntimeCache,
    artifact: &NativeRuntimeArtifact,
    extras: &BTreeMap<String, String>,
    mesh_version: &str,
) -> Result<bool> {
    let Some(shared_root) = dirs::cache_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join(".cache")))
        .map(|dir| dir.join("mesh-llm").join("native-runtimes"))
    else {
        return Ok(false);
    };
    adopt_from(cache, &shared_root, artifact, extras, mesh_version)
}

/// [`adopt_from_shared_cache`] for a given shared cache root. The source may
/// carry any modes (upstream copies archive modes, some 0666/0777); its copy in
/// Buzz's cache gets Buzz's modes and is verified again before it counts.
fn adopt_from(
    cache: &NativeRuntimeCache,
    shared_root: &Path,
    artifact: &NativeRuntimeArtifact,
    extras: &BTreeMap<String, String>,
    mesh_version: &str,
) -> Result<bool> {
    if shared_root == cache.root() {
        return Ok(false);
    }
    let shared = native_runtime_cache(Some(shared_root))?;
    let source = shared.runtime_dir(mesh_version, &artifact.id);
    if !source.join(NATIVE_RUNTIME_MANIFEST_FILE).is_file() {
        return Ok(false);
    }
    let adopted = NativeRuntimeManifest::read_from_dir(&source)
        .and_then(|manifest| {
            verify_installed_dir(&source, &manifest, artifact, extras, Modes::Ignore)
        })
        .and_then(|()| cache.install_from_dir(&source))
        .and_then(|installed| {
            seal_installed(cache, &installed, artifact, extras)?;
            Ok(installed)
        });
    match adopted {
        Ok(installed) => {
            eprintln!(
                "buzz-mesh: reused pinned native runtime {} from {}",
                installed.native_runtime_id,
                source.display()
            );
            Ok(true)
        }
        Err(reason) => {
            eprintln!(
                "buzz-mesh: not reusing native runtime {}: {reason:#}",
                source.display()
            );
            let target = cache.runtime_dir(mesh_version, &artifact.id);
            if target.exists() {
                remove_inside(cache.root(), &target)?;
            }
            Ok(false)
        }
    }
}

async fn download_and_install(
    cache: &NativeRuntimeCache,
    artifact: &NativeRuntimeArtifact,
    pin: &Pin,
    extras: BTreeMap<String, String>,
) -> Result<()> {
    let id = artifact.id.clone();
    let url = artifact
        .url
        .as_deref()
        .filter(|url| {
            url.strip_prefix(pin.release_url_prefix.as_str())
                .is_some_and(|asset| !asset.is_empty() && !asset.contains(['/', '?', '#']))
        })
        .ok_or_else(|| {
            anyhow!(
                "Share compute stopped: the pinned MeshLLM native runtime {id} points outside the MeshLLM {} release ({}). Nothing was downloaded.",
                pin.tag,
                artifact.url.as_deref().unwrap_or("no URL")
            )
        })?;
    let expected = artifact
        .sha256
        .as_deref()
        .map(normalize_sha256)
        .ok_or_else(|| anyhow!("{INTEGRITY_ERROR}"))?;

    let work = tempfile::Builder::new()
        .prefix("buzz-mesh-runtime-")
        .tempdir()
        .context("create native runtime download workspace")?;
    let archive = work.path().join("runtime.tar.gz");
    let actual = download_archive(url, &archive).await.map_err(|error| {
        anyhow!(
            "Share compute stopped: could not download the MeshLLM native runtime {id}: {error:#}"
        )
    })?;
    if actual != expected {
        return Err(anyhow!(
            "Share compute stopped: the downloaded MeshLLM native runtime {id} does not match the checksum pinned in this Buzz build (expected {}, got {}). Nothing was installed. Try again later or update Buzz.",
            &expected[..12],
            &actual[..12]
        ));
    }

    let (cache, artifact) = (cache.clone(), artifact.clone());
    tokio::task::spawn_blocking(move || {
        let staged = work.path().join("staged");
        extract_pinned_archive(&archive, &staged, &artifact, &extras)?;
        let bundle = staged.join(&artifact.id);
        let manifest = NativeRuntimeManifest::read_from_dir(&bundle)
            .map_err(|error| manifest_mismatch(&artifact.id, error))?;
        verify_installed_dir(&bundle, &manifest, &artifact, &extras, Modes::Private)?;
        let installed = cache.install_from_dir(&bundle)?;
        if let Err(error) = seal_installed(&cache, &installed, &artifact, &extras) {
            remove_inside(cache.root(), &installed.path)?;
            return Err(error);
        }
        Ok(())
    })
    .await
    .context("native runtime install stopped")?
}

/// Give a freshly copied runtime Buzz's modes, then verify it as Buzz will
/// load it.
fn seal_installed(
    cache: &NativeRuntimeCache,
    installed: &InstalledNativeRuntime,
    artifact: &NativeRuntimeArtifact,
    extras: &BTreeMap<String, String>,
) -> Result<()> {
    set_buzz_modes(cache.root(), &installed.path, artifact)?;
    require_private_ancestors(cache.root(), &installed.path, &artifact.id)?;
    verify_installed_dir(
        &installed.path,
        &installed.manifest,
        artifact,
        extras,
        Modes::Private,
    )
}

/// Stream `url` to `path`, returning the sha256 of the bytes. Errors leave the
/// URL out: release downloads redirect to signed storage URLs.
async fn download_archive(url: &str, path: &Path) -> Result<String> {
    let response = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()?
        .get(url)
        .header(reqwest::header::USER_AGENT, "buzz-desktop")
        .send()
        .await
        .map_err(reqwest::Error::without_url)?
        .error_for_status()
        .map_err(reqwest::Error::without_url)?;
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(path).await?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(reqwest::Error::without_url)?;
        total += chunk.len() as u64;
        anyhow::ensure!(
            total <= MAX_ARCHIVE_BYTES,
            "archive is larger than {MAX_ARCHIVE_BYTES} bytes"
        );
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(hex::encode(hasher.finalize()))
}

/// Extract a runtime archive into `dest/<artifact id>/` without trusting its
/// headers: only regular files and directories under the single
/// `<artifact id>/` root, relative paths only, every file pinned by the sealed
/// manifest (or named in `extras`, which are checked and skipped), modes set by
/// Buzz. Links, devices and anything else stop the extraction.
fn extract_pinned_archive(
    archive: &Path,
    dest: &Path,
    artifact: &NativeRuntimeArtifact,
    extras: &BTreeMap<String, String>,
) -> Result<()> {
    let id = artifact.id.as_str();
    let root_dir = dest.join(id);
    create_dir(&root_dir)?;
    let file = fs::File::open(archive)
        .with_context(|| format!("open native runtime archive {}", archive.display()))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut seen = BTreeSet::new();
    for entry in tar.entries()? {
        let mut entry = entry?;
        let raw = entry.path()?.into_owned();
        let shown = raw.display().to_string();
        let relative = archive_relative_path(&raw, id)
            .ok_or_else(|| refused_entry(id, "unsafe path", &shown))?;
        match entry.header().entry_type() {
            tar::EntryType::Directory => {
                if let Some(relative) = relative {
                    create_dir(&root_dir.join(relative))?;
                }
            }
            tar::EntryType::Regular | tar::EntryType::Continuous => {
                let relative = relative.ok_or_else(|| refused_entry(id, "unsafe path", &shown))?;
                let key = path_key(&relative);
                if !seen.insert(key.clone()) {
                    return Err(refused_entry(id, "duplicate", &shown));
                }
                let (expected, install) = if let Some(sha) = pinned_sha256(artifact, &key) {
                    (Some(sha), true)
                } else if key == NATIVE_RUNTIME_MANIFEST_FILE {
                    (None, true)
                } else if let Some(sha) = extras.get(&key) {
                    (Some(sha.as_str()), false)
                } else {
                    return Err(file_error(id, &key, FileProblem::NotPinned));
                };
                let target = install.then(|| root_dir.join(&relative));
                let executable = artifact.tools.contains_key(&key);
                let actual = copy_and_hash(&mut entry, target.as_deref(), executable)?;
                if expected.is_some_and(|expected| normalize_sha256(expected) != actual) {
                    return Err(file_error(id, &key, FileProblem::Mismatch));
                }
            }
            tar::EntryType::Symlink => return Err(refused_entry(id, "symlink", &shown)),
            tar::EntryType::Link => return Err(refused_entry(id, "hard link", &shown)),
            tar::EntryType::Char | tar::EntryType::Block | tar::EntryType::Fifo => {
                return Err(refused_entry(id, "device", &shown))
            }
            other => return Err(refused_entry(id, &format!("{other:?}"), &shown)),
        }
    }
    for key in artifact
        .files
        .keys()
        .chain(artifact.tools.keys())
        .map(String::as_str)
        .chain([NATIVE_RUNTIME_MANIFEST_FILE])
    {
        if !seen.contains(key) {
            return Err(file_error(id, key, FileProblem::Missing));
        }
    }
    Ok(())
}

/// `<root>/<relative>` for a safe archive path under `root`: `Some(None)` is
/// the root itself, `None` refuses the path.
fn archive_relative_path(path: &Path, root: &str) -> Option<Option<PathBuf>> {
    let mut components = path.components().peekable();
    if components.peek() == Some(&Component::CurDir) {
        components.next();
    }
    match components.next() {
        Some(Component::Normal(first)) if first == root => {}
        _ => return None,
    }
    let mut relative = PathBuf::new();
    for component in components {
        match component {
            Component::Normal(part) => relative.push(part),
            _ => return None,
        }
    }
    Some((!relative.as_os_str().is_empty()).then_some(relative))
}

/// Whether [`verify_installed_dir`] also requires Buzz's own modes.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Modes {
    /// Anything Buzz will load: nothing group- or other-writable.
    Private,
    /// A copy source outside Buzz's cache; its copy is fixed and checked again.
    Ignore,
}

/// Check an installed runtime directory against the sealed artifact: the same
/// manifest, every pinned file with its pinned sha256, listed archive extras
/// (upstream installs copy them) with theirs, and nothing else: no links, no
/// unpinned files and, with [`Modes::Private`], nothing another local user
/// could write.
fn verify_installed_dir(
    dir: &Path,
    manifest: &NativeRuntimeManifest,
    artifact: &NativeRuntimeArtifact,
    extras: &BTreeMap<String, String>,
    modes: Modes,
) -> Result<()> {
    if release_view(&manifest.runtime) != release_view(artifact) {
        return Err(manifest_mismatch(&artifact.id, anyhow!("manifest differs")));
    }
    if modes == Modes::Private && others_can_write(&fs::symlink_metadata(dir)?) {
        return Err(file_error(&artifact.id, ".", FileProblem::Writable));
    }
    let mut seen = BTreeSet::new();
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        for entry in fs::read_dir(dir.join(&relative))? {
            let entry = entry?;
            let child = relative.join(entry.file_name());
            let key = path_key(&child);
            let kind = entry.file_type()?;
            if modes == Modes::Private && others_can_write(&entry.metadata()?) {
                return Err(file_error(&artifact.id, &key, FileProblem::Writable));
            }
            if kind.is_dir() {
                pending.push(child);
            } else if !kind.is_file() {
                return Err(file_error(&artifact.id, &key, FileProblem::NotRegular));
            } else if key == NATIVE_RUNTIME_MANIFEST_FILE {
                seen.insert(key);
            } else if let Some(expected) =
                pinned_sha256(artifact, &key).or_else(|| extras.get(&key).map(String::as_str))
            {
                let mut file = fs::File::open(dir.join(&child))?;
                if copy_and_hash(&mut file, None, false)? != normalize_sha256(expected) {
                    return Err(file_error(&artifact.id, &key, FileProblem::Mismatch));
                }
                seen.insert(key);
            } else {
                return Err(file_error(&artifact.id, &key, FileProblem::NotPinned));
            }
        }
    }
    for key in artifact.files.keys().chain(artifact.tools.keys()) {
        if !seen.contains(key) {
            return Err(file_error(&artifact.id, key, FileProblem::Missing));
        }
    }
    Ok(())
}

/// Group or other write permission (unix); a file another local user could
/// swap between the check and the load.
fn others_can_write(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o022 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        false
    }
}

/// Give an installed runtime Buzz's own modes, whatever its source carried:
/// 0755 for directories (the runtime, its version directory and the cache
/// root) and tools, 0644 for every other file. `install_from_dir` copies
/// source modes and creates directories under the process umask.
fn set_buzz_modes(cache_root: &Path, dir: &Path, artifact: &NativeRuntimeArtifact) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let set = |path: &Path, mode: u32| {
            fs::set_permissions(path, fs::Permissions::from_mode(mode))
                .with_context(|| format!("set mode {mode:o} on {}", path.display()))
        };
        anyhow::ensure!(
            dir.starts_with(cache_root),
            "{} is outside the native runtime cache",
            dir.display()
        );
        let mut ancestor = Some(dir);
        while let Some(path) = ancestor.filter(|path| path.starts_with(cache_root)) {
            set(path, 0o755)?;
            ancestor = path.parent();
        }
        let mut pending = vec![PathBuf::new()];
        while let Some(relative) = pending.pop() {
            for entry in fs::read_dir(dir.join(&relative))? {
                let entry = entry?;
                let child = relative.join(entry.file_name());
                let kind = entry.file_type()?;
                if kind.is_dir() {
                    set(&dir.join(&child), 0o755)?;
                    pending.push(child);
                } else if kind.is_file() {
                    let tool = artifact.tools.contains_key(&path_key(&child));
                    set(&dir.join(&child), if tool { 0o755 } else { 0o644 })?;
                }
                // Links are never followed here; verification refuses them.
            }
        }
    }
    #[cfg(not(unix))]
    let _ = (cache_root, dir, artifact);
    Ok(())
}

/// Refuse a runtime whose cache ancestors another local user could write:
/// they could swap the runtime directory itself.
fn require_private_ancestors(cache_root: &Path, dir: &Path, id: &str) -> Result<()> {
    let mut ancestor = dir.parent();
    while let Some(path) = ancestor.filter(|path| path.starts_with(cache_root)) {
        if others_can_write(&fs::symlink_metadata(path)?) {
            return Err(file_error(
                id,
                &path.display().to_string(),
                FileProblem::Writable,
            ));
        }
        ancestor = path.parent();
    }
    Ok(())
}

/// The artifact as its own archive describes it: the release manifest adds the
/// archive URL and checksum (and a signature slot), which a bundle cannot carry.
fn release_view(artifact: &NativeRuntimeArtifact) -> NativeRuntimeArtifact {
    NativeRuntimeArtifact {
        url: None,
        sha256: None,
        signature: None,
        ..artifact.clone()
    }
}

fn pinned_sha256<'a>(artifact: &'a NativeRuntimeArtifact, key: &str) -> Option<&'a str> {
    artifact
        .files
        .get(key)
        .or_else(|| artifact.tools.get(key))
        .map(String::as_str)
}

fn copy_and_hash(
    reader: &mut impl Read,
    target: Option<&Path>,
    executable: bool,
) -> Result<String> {
    let mut out = match target {
        Some(path) => Some(create_new_file(path, executable)?),
        None => None,
    };
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1 << 16];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        if let Some(out) = out.as_mut() {
            out.write_all(&buffer[..read])?;
        }
    }
    if let Some(out) = out {
        out.sync_all()?;
    }
    Ok(hex::encode(hasher.finalize()))
}

fn create_new_file(path: &Path, executable: bool) -> Result<fs::File> {
    if let Some(parent) = path.parent() {
        create_dir(parent)?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(if executable { 0o755 } else { 0o644 });
    }
    #[cfg(not(unix))]
    let _ = executable;
    options
        .open(path)
        .with_context(|| format!("create {}", path.display()))
}

fn create_dir(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o755);
    }
    builder
        .create(path)
        .with_context(|| format!("create {}", path.display()))
}

/// Remove a cache entry, refusing anything outside the cache root.
fn remove_inside(root: &Path, path: &Path) -> Result<()> {
    anyhow::ensure!(
        path.starts_with(root) && path != root,
        "refusing to remove {} outside the native runtime cache {}",
        path.display(),
        root.display()
    );
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
    .with_context(|| format!("remove {}", path.display()))
}

fn path_key(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn normalize_sha256(value: &str) -> String {
    let value = value.trim().to_ascii_lowercase();
    value
        .strip_prefix("sha256:")
        .map(str::to_string)
        .unwrap_or(value)
}

fn refused_entry(id: &str, kind: &str, path: &str) -> anyhow::Error {
    anyhow!(
        "Share compute stopped: the MeshLLM native runtime {id} archive contains a {kind} entry ({path}), which Buzz does not install. Nothing was installed."
    )
}

#[derive(Clone, Copy)]
enum FileProblem {
    NotPinned,
    Mismatch,
    Missing,
    NotRegular,
    Writable,
}

fn file_error(id: &str, path: &str, problem: FileProblem) -> anyhow::Error {
    match problem {
        FileProblem::NotPinned => anyhow!(
            "Share compute stopped: {path} in the MeshLLM native runtime {id} is not pinned in this Buzz build. Nothing was installed."
        ),
        FileProblem::Mismatch => anyhow!(
            "Share compute stopped: {path} in the MeshLLM native runtime {id} does not match the checksum pinned in this Buzz build. Nothing was installed."
        ),
        FileProblem::Missing => anyhow!(
            "Share compute stopped: {path} is missing from the MeshLLM native runtime {id}. Nothing was installed."
        ),
        FileProblem::NotRegular => anyhow!(
            "Share compute stopped: {path} in the MeshLLM native runtime {id} is a link or device, which Buzz does not install. Nothing was installed."
        ),
        FileProblem::Writable => anyhow!(
            "Share compute stopped: {path} in the MeshLLM native runtime {id} is writable by other users, which Buzz does not load. Nothing was installed."
        ),
    }
}

fn manifest_mismatch(id: &str, error: anyhow::Error) -> anyhow::Error {
    eprintln!("buzz-mesh: native runtime {id} manifest rejected: {error:#}");
    anyhow!(
        "Share compute stopped: the manifest in the MeshLLM native runtime {id} does not match the one pinned in this Buzz build. Nothing was installed."
    )
}

#[cfg(test)]
#[path = "pinned_runtime_tests.rs"]
mod tests;

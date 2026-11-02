use super::*;

const LIB: &[u8] = b"pinned library bytes";
const TOOL: &[u8] = b"pinned tool bytes";
const README: &[u8] = b"pinned readme";

enum Item<'a> {
    File(&'a [u8]),
    Dir,
    Symlink(&'a str),
    Hardlink(&'a str),
    Fifo,
}

fn sealed_fixture() -> Sealed {
    sealed_from(PIN_JSON, MANIFEST_JSON).expect("embedded pin is consistent")
}

/// A pinned artifact shaped like a real one, with small known files.
fn artifact_fixture() -> NativeRuntimeArtifact {
    let mut artifact = sealed_fixture().manifest.artifacts[0].clone();
    artifact.id = "meshllm-native-runtime-test".to_string();
    artifact.libraries = vec!["lib/libtest.so".to_string()];
    artifact.files = BTreeMap::from([("lib/libtest.so".to_string(), sha256_hex(LIB))]);
    artifact.tools = BTreeMap::from([("tools/bench".to_string(), sha256_hex(TOOL))]);
    artifact
}

fn extras_fixture() -> BTreeMap<String, String> {
    BTreeMap::from([("README.md".to_string(), sha256_hex(README))])
}

fn bundle_manifest(artifact: &NativeRuntimeArtifact) -> Vec<u8> {
    serde_json::to_vec(&NativeRuntimeManifest {
        runtime: release_view(artifact),
    })
    .expect("manifest serializes")
}

/// Build a tar.gz with raw header names, so unsafe paths can be expressed.
fn tar_gz(entries: &[(&str, Item<'_>)]) -> Vec<u8> {
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::fast(),
    ));
    for (name, item) in entries {
        let mut header = tar::Header::new_ustar();
        let (kind, data, link): (tar::EntryType, &[u8], Option<&str>) = match item {
            Item::File(data) => (tar::EntryType::Regular, data, None),
            Item::Dir => (tar::EntryType::Directory, &[], None),
            Item::Symlink(target) => (tar::EntryType::Symlink, &[], Some(target)),
            Item::Hardlink(target) => (tar::EntryType::Link, &[], Some(target)),
            Item::Fifo => (tar::EntryType::Fifo, &[], None),
        };
        header.set_entry_type(kind);
        header.set_size(data.len() as u64);
        header.set_mode(0o777);
        let raw = header.as_old_mut();
        raw.name = [0; 100];
        raw.name[..name.len()].copy_from_slice(name.as_bytes());
        if let Some(link) = link {
            raw.linkname = [0; 100];
            raw.linkname[..link.len()].copy_from_slice(link.as_bytes());
        }
        header.set_cksum();
        builder.append(&header, data).expect("append entry");
    }
    builder
        .into_inner()
        .expect("finish tar")
        .finish()
        .expect("finish gzip")
}

fn good_entries(manifest: &[u8]) -> Vec<(&'static str, Item<'_>)> {
    vec![
        ("meshllm-native-runtime-test/", Item::Dir),
        ("meshllm-native-runtime-test/lib/", Item::Dir),
        (
            "meshllm-native-runtime-test/lib/libtest.so",
            Item::File(LIB),
        ),
        ("meshllm-native-runtime-test/tools/bench", Item::File(TOOL)),
        ("meshllm-native-runtime-test/README.md", Item::File(README)),
        (
            "meshllm-native-runtime-test/manifest.json",
            Item::File(manifest),
        ),
    ]
}

fn extract(entries: &[(&str, Item<'_>)]) -> (tempfile::TempDir, Result<()>) {
    let work = tempfile::tempdir().expect("tempdir");
    let archive = work.path().join("runtime.tar.gz");
    fs::write(&archive, tar_gz(entries)).expect("write archive");
    let result = extract_pinned_archive(
        &archive,
        &work.path().join("staged"),
        &artifact_fixture(),
        &extras_fixture(),
    );
    (work, result)
}

fn extract_error(entries: &[(&str, Item<'_>)]) -> String {
    let (_work, result) = extract(entries);
    format!("{:#}", result.expect_err("extraction must refuse"))
}

#[test]
fn embedded_pin_matches_embedded_manifest_and_bundled_mesh_llm() {
    let sealed = sealed_fixture();
    assert_eq!(sealed.pin.mesh_version, CURRENT_MESH_VERSION);
    assert_eq!(sealed.pin.skippy_abi, current_skippy_abi_version());
    check_versions(&sealed, CURRENT_MESH_VERSION, &current_skippy_abi_version())
        .expect("versions match");
    for artifact in &sealed.manifest.artifacts {
        let url = artifact.url.as_deref().expect("artifact url");
        assert!(url.starts_with(&sealed.pin.release_url_prefix), "{url}");
        assert!(artifact.sha256.is_some() && !artifact.files.is_empty());
    }
}

#[test]
fn a_changed_manifest_byte_fails_the_integrity_check() {
    let mut bytes = MANIFEST_JSON.to_vec();
    let last = bytes.len() - 2;
    bytes[last] ^= 0x20;
    assert!(sealed_from(PIN_JSON, &bytes).is_err());
}

#[test]
fn a_stale_pin_names_both_versions() {
    let error = check_versions(&sealed_fixture(), "9.9.9", "0.0.1").expect_err("stale pin");
    let message = error.to_string();
    assert!(
        message.contains("9.9.9") && message.contains("Update Buzz"),
        "{message}"
    );
}

#[test]
fn archive_paths_must_stay_under_the_artifact_root() {
    let root = "rt";
    assert_eq!(archive_relative_path(Path::new("rt"), root), Some(None));
    assert_eq!(archive_relative_path(Path::new("./rt/"), root), Some(None));
    assert_eq!(
        archive_relative_path(Path::new("rt/lib/a.so"), root),
        Some(Some(PathBuf::from("lib/a.so")))
    );
    for unsafe_path in [
        "rt/../x",
        "/rt/x",
        "other/x",
        "../rt/x",
        "rt/lib/../../x",
        "",
    ] {
        assert_eq!(
            archive_relative_path(Path::new(unsafe_path), root),
            None,
            "{unsafe_path}"
        );
    }
}

#[test]
fn a_pinned_archive_extracts_pinned_files_only_with_buzz_modes() {
    let manifest = bundle_manifest(&artifact_fixture());
    let (work, result) = extract(&good_entries(&manifest));
    result.expect("pinned archive extracts");
    let root = work
        .path()
        .join("staged")
        .join("meshllm-native-runtime-test");
    assert_eq!(fs::read(root.join("lib/libtest.so")).expect("lib"), LIB);
    assert_eq!(fs::read(root.join("tools/bench")).expect("tool"), TOOL);
    assert!(
        !root.join("README.md").exists(),
        "listed extras are checked, not installed"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &str| {
            fs::metadata(root.join(path))
                .expect("meta")
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode("lib/libtest.so"), 0o644);
        assert_eq!(mode("tools/bench"), 0o755);
    }
    let installed = NativeRuntimeManifest::read_from_dir(&root).expect("bundle manifest");
    verify_installed_dir(
        &root,
        &installed,
        &artifact_fixture(),
        &extras_fixture(),
        Modes::Private,
    )
    .expect("extracted tree verifies");
}

#[test]
fn links_devices_and_unsafe_paths_are_refused() {
    let manifest = bundle_manifest(&artifact_fixture());
    let cases: Vec<(Vec<(&str, Item<'_>)>, &str)> = vec![
        (
            vec![(
                "meshllm-native-runtime-test/lib/libtest.so",
                Item::Symlink("/etc/passwd"),
            )],
            "symlink entry",
        ),
        (
            vec![(
                "meshllm-native-runtime-test/lib/libtest.so",
                Item::Hardlink("meshllm-native-runtime-test/x"),
            )],
            "hard link entry",
        ),
        (
            vec![("meshllm-native-runtime-test/fifo", Item::Fifo)],
            "device entry",
        ),
        (
            vec![("meshllm-native-runtime-test/../escape", Item::File(LIB))],
            "unsafe path entry",
        ),
        (
            vec![(
                "/meshllm-native-runtime-test/lib/libtest.so",
                Item::File(LIB),
            )],
            "unsafe path entry",
        ),
        (
            vec![("elsewhere/lib/libtest.so", Item::File(LIB))],
            "unsafe path entry",
        ),
        (
            vec![
                (
                    "meshllm-native-runtime-test/lib/libtest.so",
                    Item::File(LIB),
                ),
                (
                    "meshllm-native-runtime-test/lib/libtest.so",
                    Item::File(LIB),
                ),
            ],
            "duplicate entry",
        ),
    ];
    for (entries, expected) in cases {
        let mut all = entries;
        all.push((
            "meshllm-native-runtime-test/manifest.json",
            Item::File(&manifest),
        ));
        let message = extract_error(&all);
        assert!(message.contains(expected), "{expected}: {message}");
    }
}

#[test]
fn unpinned_mismatched_and_missing_files_are_refused() {
    let manifest = bundle_manifest(&artifact_fixture());
    let mut unpinned = good_entries(&manifest);
    unpinned.push(("meshllm-native-runtime-test/lib/extra.so", Item::File(LIB)));
    assert!(extract_error(&unpinned).contains(
        "lib/extra.so in the MeshLLM native runtime meshllm-native-runtime-test is not pinned"
    ));

    let mut tampered = good_entries(&manifest);
    tampered[2] = (
        "meshllm-native-runtime-test/lib/libtest.so",
        Item::File(b"other bytes"),
    );
    assert!(extract_error(&tampered).contains("does not match the checksum pinned"));

    let mut bad_extra = good_entries(&manifest);
    bad_extra[4] = (
        "meshllm-native-runtime-test/README.md",
        Item::File(b"changed readme"),
    );
    assert!(extract_error(&bad_extra).contains("README.md in the MeshLLM native runtime"));

    let mut missing = good_entries(&manifest);
    missing.remove(3);
    assert!(extract_error(&missing).contains("tools/bench is missing"));
}

#[test]
fn installed_runtime_check_refuses_tampering_extras_and_links() {
    let artifact = artifact_fixture();
    let extras = extras_fixture();
    let manifest = bundle_manifest(&artifact);
    let (work, result) = extract(&good_entries(&manifest));
    result.expect("pinned archive extracts");
    let root = work
        .path()
        .join("staged")
        .join("meshllm-native-runtime-test");
    let installed = NativeRuntimeManifest::read_from_dir(&root).expect("bundle manifest");

    fs::write(root.join("README.md"), README).expect("upstream-style extra");
    verify_installed_dir(&root, &installed, &artifact, &extras, Modes::Private)
        .expect("listed extra is allowed");

    fs::write(root.join("lib/unexpected.so"), LIB).expect("write");
    assert!(verify_installed_dir(&root, &installed, &artifact, &extras, Modes::Private).is_err());
    fs::remove_file(root.join("lib/unexpected.so")).expect("remove");

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("/etc/hosts", root.join("lib/link")).expect("symlink");
        let message = format!(
            "{:#}",
            verify_installed_dir(&root, &installed, &artifact, &extras, Modes::Private)
                .expect_err("link")
        );
        assert!(message.contains("is a link or device"), "{message}");
        fs::remove_file(root.join("lib/link")).expect("remove link");
    }

    let mut other = artifact.clone();
    other.rank += 1;
    assert!(verify_installed_dir(&root, &installed, &other, &extras, Modes::Private).is_err());

    fs::write(root.join("lib/libtest.so"), b"swapped").expect("tamper");
    assert!(verify_installed_dir(&root, &installed, &artifact, &extras, Modes::Private).is_err());
}

#[test]
fn cache_removal_stays_inside_the_cache_root() {
    let work = tempfile::tempdir().expect("tempdir");
    let root = work.path().join("cache");
    fs::create_dir_all(root.join("0.76.2/x")).expect("mkdir");
    assert!(remove_inside(&root, work.path()).is_err());
    assert!(remove_inside(&root, &root).is_err());
    remove_inside(&root, &root.join("0.76.2/x")).expect("inside");
    assert!(!root.join("0.76.2/x").exists());
}

#[cfg(unix)]
fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::symlink_metadata(path)
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777
}

#[cfg(unix)]
fn chmod(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("chmod");
}

/// A pinned runtime laid out the way an upstream install leaves it under
/// `<root>/<mesh version>/<id>`, every entry world-writable.
#[cfg(unix)]
fn world_writable_install(root: &Path, artifact: &NativeRuntimeArtifact) -> PathBuf {
    let mesh_version = artifact.mesh_version.clone().expect("fixture mesh_version");
    let dir = root.join(mesh_version).join(&artifact.id);
    fs::create_dir_all(dir.join("lib")).expect("mkdir lib");
    fs::create_dir_all(dir.join("tools")).expect("mkdir tools");
    fs::write(dir.join("lib/libtest.so"), LIB).expect("lib");
    fs::write(dir.join("tools/bench"), TOOL).expect("tool");
    fs::write(dir.join("README.md"), README).expect("readme");
    fs::write(dir.join("manifest.json"), bundle_manifest(artifact)).expect("manifest");
    for path in [
        "lib/libtest.so",
        "tools/bench",
        "README.md",
        "manifest.json",
        "lib",
        "tools",
        "",
    ] {
        chmod(&dir.join(path), 0o777);
    }
    dir
}

#[cfg(unix)]
#[test]
fn a_world_writable_shared_cache_copy_gets_buzz_modes_before_it_counts() {
    let work = tempfile::tempdir().expect("tempdir");
    let artifact = artifact_fixture();
    let extras = extras_fixture();
    let mesh_version = artifact.mesh_version.clone().expect("fixture mesh_version");
    let shared_root = work.path().join("shared");
    let source = world_writable_install(&shared_root, &artifact);
    let cache = NativeRuntimeCache::new(work.path().join("buzz"));

    assert!(adopt_from(&cache, &shared_root, &artifact, &extras, &mesh_version).expect("adopt"));

    let installed = cache.runtime_dir(&mesh_version, &artifact.id);
    assert_eq!(mode_of(&installed.join("lib/libtest.so")), 0o644);
    assert_eq!(mode_of(&installed.join("tools/bench")), 0o755);
    assert_eq!(mode_of(&installed.join("README.md")), 0o644);
    for dir in [
        installed.clone(),
        installed.join("lib"),
        installed.join(".."),
        cache.root().to_path_buf(),
    ] {
        assert_eq!(mode_of(&dir), 0o755, "{}", dir.display());
    }
    assert_eq!(
        mode_of(&source.join("lib/libtest.so")),
        0o777,
        "the source is left alone"
    );
    assert!(audit_cache(&cache, &artifact, &extras, &mesh_version).expect("audit"));
}

#[cfg(unix)]
#[test]
fn a_writable_runtime_in_buzz_cache_is_refused_and_removed() {
    let work = tempfile::tempdir().expect("tempdir");
    let artifact = artifact_fixture();
    let extras = extras_fixture();
    let mesh_version = artifact.mesh_version.clone().expect("fixture mesh_version");
    let cache = NativeRuntimeCache::new(work.path().join("buzz"));
    let dir = world_writable_install(cache.root(), &artifact);
    let manifest = NativeRuntimeManifest::read_from_dir(&dir).expect("manifest");

    verify_installed_dir(&dir, &manifest, &artifact, &extras, Modes::Ignore)
        .expect("contents are pinned");
    let message = format!(
        "{:#}",
        verify_installed_dir(&dir, &manifest, &artifact, &extras, Modes::Private)
            .expect_err("writable")
    );
    assert!(message.contains("writable by other users"), "{message}");

    assert!(!audit_cache(&cache, &artifact, &extras, &mesh_version).expect("audit"));
    assert!(!dir.exists(), "a writable runtime is removed, never loaded");
}

#[cfg(unix)]
#[test]
fn a_writable_cache_ancestor_refuses_the_runtime() {
    let work = tempfile::tempdir().expect("tempdir");
    let artifact = artifact_fixture();
    let cache = NativeRuntimeCache::new(work.path().join("buzz"));
    let dir = world_writable_install(cache.root(), &artifact);
    set_buzz_modes(cache.root(), &dir, &artifact).expect("modes");
    require_private_ancestors(cache.root(), &dir, &artifact.id).expect("private");
    chmod(cache.root(), 0o777);
    assert!(require_private_ancestors(cache.root(), &dir, &artifact.id).is_err());
}

#[test]
fn serving_needs_buzz_own_cache_directory() {
    let message = require_buzz_cache(None, Path::new("/tmp/mesh"))
        .expect_err("no per-user cache")
        .to_string();
    assert!(message.contains("private cache folder"), "{message}");
    assert!(require_buzz_cache(Some(Path::new("/a/Buzz")), Path::new("/tmp/mesh")).is_err());
    require_buzz_cache(Some(Path::new("/a/Buzz")), Path::new("/a/Buzz")).expect("same cache");
}

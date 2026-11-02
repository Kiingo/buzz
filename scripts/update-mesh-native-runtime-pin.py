#!/usr/bin/env python3
"""Regenerate the MeshLLM native runtime pin that the desktop build seals in.

Usage: python3 -I scripts/update-mesh-native-runtime-pin.py <mesh-llm tag>

Run it after bumping the mesh-llm tag in desktop/src-tauri/Cargo.toml and
updating desktop/src-tauri/Cargo.lock. It reads only public GitHub data
(`gh api -X GET` for release and commit metadata, plain HTTPS for the release
assets) and writes two files:

  desktop/src-tauri/mesh-native-runtime/native-runtimes.json  exact upstream bytes
  desktop/src-tauri/mesh-native-runtime/pin.json              what Buzz checks them against

Before writing anything it requires that:
  * every mesh-llm source in desktop/src-tauri/Cargo.lock is `?tag=<tag>#<rev>`
    and the tag's commit on GitHub is that same <rev>;
  * the manifest's sha256 matches its `.sha256` release asset and the GitHub
    asset digest;
  * the manifest is for this tag and every artifact has a sha256, a non-empty
    file map and a URL inside this tag's release;
  * every runtime archive (streamed, never extracted, nothing executed) matches
    its pinned sha256, holds only regular files and directories under one root
    named after the artifact, carries a manifest.json equal to the release
    artifact, and contains every pinned file with its pinned sha256.
Regular files in an archive that the manifest does not pin are written into
pin.json by exact path and sha256 (`archive_extras`); Buzz refuses anything else.

The archives are a few GB in total; this streams them and keeps none on disk.
The reviewer of the bump PR is the trust point: check this script's output.

After a bump, re-check that the embedded node still cannot load a native
serving plugin: in the new tag's mesh-llm checkout, `grep -n native_serving_plugin
crates/mesh-llm-host-runtime/src/runtime/run_auto.rs crates/mesh-llm-host-runtime/src/sdk.rs`
must print nothing, and `cargo tree --manifest-path desktop/src-tauri/Cargo.toml
--features mesh-llm -i mesh-llm-cli` must match no package.
"""

import hashlib
import json
import re
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

REPO = "Mesh-LLM/mesh-llm"
ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "desktop" / "src-tauri"
PIN_DIR = DESKTOP / "mesh-native-runtime"
LOCK = DESKTOP / "Cargo.lock"
SOURCE_RE = re.compile(
    r'^source = "git\+https://github\.com/Mesh-LLM/mesh-llm\.git\?tag=([^#"]+)#([0-9a-f]{40})"$',
    re.M,
)
# Fields the release manifest adds to an artifact that the archive's own
# manifest.json cannot carry (the archive cannot know its own checksum).
RELEASE_ONLY_FIELDS = ("url", "sha256", "signature")


def fail(message):
    print(f"update-mesh-native-runtime-pin: {message}", file=sys.stderr)
    sys.exit(1)


def gh_get(path):
    out = subprocess.run(
        ["gh", "api", "-X", "GET", path], check=True, capture_output=True, text=True
    ).stdout
    return json.loads(out)


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "buzz-pin-update"})
    return urllib.request.urlopen(request, timeout=120)


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def normalize_sha(value):
    value = value.strip().lower()
    return value[len("sha256:"):] if value.startswith("sha256:") else value


def release_view(artifact):
    view = dict(artifact)
    for field in RELEASE_ONLY_FIELDS:
        view.pop(field, None)
    return view


class HashingReader:
    def __init__(self, inner):
        self.inner = inner
        self.hash = hashlib.sha256()

    def read(self, size=-1):
        data = self.inner.read(size)
        self.hash.update(data)
        return data


def audit_archive(artifact):
    """Stream one archive; return {path: sha256} for regular files the manifest does not pin."""
    pinned = dict(artifact.get("files") or {})
    pinned.update(artifact.get("tools") or {})
    root = artifact["id"]
    seen = {}
    bundle_manifest = None
    with fetch(artifact["url"]) as response:
        reader = HashingReader(response)
        with tarfile.open(fileobj=reader, mode="r|gz") as archive:
            for member in archive:
                parts = [p for p in member.name.split("/") if p not in ("", ".")]
                if not parts or parts[0] != root or any(p == ".." for p in parts):
                    fail(f"{root}: entry {member.name!r} is outside the {root}/ root")
                if member.isdir():
                    continue
                if not member.isreg():
                    fail(f"{root}: entry {member.name!r} is not a regular file or directory")
                if len(parts) == 1:
                    fail(f"{root}: entry {member.name!r} is the root itself but not a directory")
                relative = "/".join(parts[1:])
                if relative in seen:
                    fail(f"{root}: duplicate entry {relative}")
                data = archive.extractfile(member).read()
                seen[relative] = sha256_hex(data)
                if relative == "manifest.json":
                    bundle_manifest = json.loads(data)
        while reader.read(1 << 20):
            pass
        if reader.hash.hexdigest() != normalize_sha(artifact["sha256"]):
            fail(f"{root}: archive sha256 {reader.hash.hexdigest()} != pinned {artifact['sha256']}")
    if bundle_manifest is None:
        fail(f"{root}: archive has no {root}/manifest.json")
    if release_view(bundle_manifest.get("runtime") or {}) != release_view(artifact):
        fail(f"{root}: archive manifest.json does not match the release artifact")
    for path, expected in pinned.items():
        if seen.get(path) != normalize_sha(expected):
            fail(f"{root}: pinned file {path} missing or sha256 mismatch")
    return {
        path: digest
        for path, digest in sorted(seen.items())
        if path not in pinned and path != "manifest.json"
    }


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r"v\d+\.\d+\.\d+", sys.argv[1]):
        fail("usage: update-mesh-native-runtime-pin.py vMAJOR.MINOR.PATCH")
    tag = sys.argv[1]
    mesh_version = tag[1:]

    sources = set(SOURCE_RE.findall(LOCK.read_text()))
    if len(sources) != 1:
        fail(f"desktop Cargo.lock mesh-llm sources disagree or are missing: {sorted(sources)}")
    (lock_tag, lock_rev), = sources
    if lock_tag != tag:
        fail(f"desktop Cargo.lock is on {lock_tag}, not {tag}; update the lockfile first")
    tag_commit = gh_get(f"repos/{REPO}/commits/{tag}")["sha"]
    if tag_commit != lock_rev:
        fail(f"tag {tag} is commit {tag_commit} on GitHub, but Cargo.lock pins {lock_rev}")

    release = gh_get(f"repos/{REPO}/releases/tags/{tag}")
    assets = {asset["name"]: asset for asset in release["assets"]}
    prefix = f"https://github.com/{REPO}/releases/download/{tag}/"
    manifest_bytes = fetch(prefix + "native-runtimes.json").read()
    sidecar = fetch(prefix + "native-runtimes.json.sha256").read().decode().split()[0]
    digest = normalize_sha(assets["native-runtimes.json"]["digest"])
    manifest_sha = sha256_hex(manifest_bytes)
    if not (manifest_sha == normalize_sha(sidecar) == digest):
        fail(f"manifest sha256 {manifest_sha}, .sha256 asset {sidecar}, GitHub digest {digest} disagree")

    manifest = json.loads(manifest_bytes)
    if manifest.get("mesh_version") != mesh_version:
        fail(f"manifest mesh_version {manifest.get('mesh_version')!r} != {mesh_version}")
    artifacts = manifest.get("artifacts") or []
    if not artifacts:
        fail("manifest lists no artifacts")
    extras = {}
    for artifact in artifacts:
        name = artifact.get("id", "?")
        url = artifact.get("url") or ""
        if not url.startswith(prefix) or "/" in url[len(prefix):]:
            fail(f"{name}: url {url!r} is not a {tag} release asset")
        if not artifact.get("sha256") or not artifact.get("files"):
            fail(f"{name}: missing sha256 or file checksums")
        if not set(artifact.get("libraries") or []) <= set(artifact["files"]):
            fail(f"{name}: a library has no file checksum")
        asset = assets.get(url[len(prefix):])
        if asset is None or normalize_sha(asset["digest"]) != normalize_sha(artifact["sha256"]):
            fail(f"{name}: release asset digest does not match the manifest sha256")
        print(f"auditing {name} ({asset['size']} bytes)", file=sys.stderr)
        found = audit_archive(artifact)
        if found:
            extras[name] = found

    pin = {
        "schema": 1,
        "tag": tag,
        "git_rev": lock_rev,
        "mesh_version": mesh_version,
        "skippy_abi": manifest["skippy_abi"],
        "manifest_sha256": manifest_sha,
        "release_url_prefix": prefix,
        "archive_extras": extras,
    }
    PIN_DIR.mkdir(exist_ok=True)
    (PIN_DIR / "native-runtimes.json").write_bytes(manifest_bytes)
    (PIN_DIR / "pin.json").write_text(json.dumps(pin, indent=2) + "\n")
    print(f"pinned {tag} ({lock_rev}): manifest {manifest_sha}, {len(artifacts)} artifacts")
    for name, files in extras.items():
        print(f"  {name}: unpinned archive files {', '.join(files)}")


if __name__ == "__main__":
    main()

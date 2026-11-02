#!/usr/bin/env python3
"""Static check: the sealed MeshLLM native runtime pin matches the locked mesh-llm.

Usage: python3 -I scripts/check-mesh-native-runtime-pin.py

No network and no build. Fails when a mesh-llm bump in desktop/src-tauri left
the pin behind (regenerate it with scripts/update-mesh-native-runtime-pin.py),
or when the pinned manifest bytes were edited by hand.
"""

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "desktop" / "src-tauri"
PIN_DIR = DESKTOP / "mesh-native-runtime"
REPO_URL = "https://github.com/Mesh-LLM/mesh-llm"
TOML_DEP_RE = re.compile(r'git\s*=\s*"https://github\.com/Mesh-LLM/mesh-llm\.git"[^}\n]*')
TOML_TAG_RE = re.compile(r'tag\s*=\s*"([^"]+)"')
LOCK_SOURCE_RE = re.compile(
    r'^source = "git\+https://github\.com/Mesh-LLM/mesh-llm\.git(\?[^#"]*)?#([0-9a-f]{40})"$',
    re.M,
)
PIN_KEYS = {
    "schema",
    "tag",
    "git_rev",
    "mesh_version",
    "skippy_abi",
    "manifest_sha256",
    "release_url_prefix",
    "archive_extras",
}
SHA_RE = re.compile(r"[0-9a-f]{64}")


def main():
    errors = []

    def check(condition, message):
        if not condition:
            errors.append(message)

    pin = json.loads((PIN_DIR / "pin.json").read_text())
    check(set(pin) == PIN_KEYS, f"pin.json keys {sorted(pin)} != {sorted(PIN_KEYS)}")
    check(pin.get("schema") == 1, "pin.json schema must be 1")
    tag = pin.get("tag", "")

    deps = TOML_DEP_RE.findall((DESKTOP / "Cargo.toml").read_text())
    check(deps, "desktop Cargo.toml has no mesh-llm git dependency")
    dep_tags = {m.group(1) if (m := TOML_TAG_RE.search(dep)) else None for dep in deps}
    check(dep_tags == {tag}, f"desktop Cargo.toml mesh-llm tags {sorted(map(str, dep_tags))} != pin tag {tag}")

    sources = set(LOCK_SOURCE_RE.findall((DESKTOP / "Cargo.lock").read_text()))
    check(
        sources == {(f"?tag={tag}", pin.get("git_rev"))},
        f"desktop Cargo.lock mesh-llm sources {sorted(sources)} != ?tag={tag}#{pin.get('git_rev')}",
    )

    manifest_bytes = (PIN_DIR / "native-runtimes.json").read_bytes()
    check(
        hashlib.sha256(manifest_bytes).hexdigest() == pin.get("manifest_sha256"),
        "sha256(native-runtimes.json) != pin.json manifest_sha256",
    )
    manifest = json.loads(manifest_bytes)
    check(tag == f"v{pin.get('mesh_version')}", f"pin tag {tag} != v{pin.get('mesh_version')}")
    check(manifest.get("mesh_version") == pin.get("mesh_version"), "manifest mesh_version != pin")
    check(manifest.get("skippy_abi") == pin.get("skippy_abi"), "manifest skippy_abi != pin")

    prefix = f"{REPO_URL}/releases/download/{tag}/"
    check(pin.get("release_url_prefix") == prefix, f"release_url_prefix != {prefix}")
    artifacts = {a.get("id"): a for a in manifest.get("artifacts") or []}
    check(artifacts, "manifest lists no artifacts")
    for name, artifact in artifacts.items():
        url = artifact.get("url") or ""
        check(
            url.startswith(prefix) and "/" not in url[len(prefix):],
            f"{name}: url {url!r} is not a {tag} release asset",
        )
        check(SHA_RE.fullmatch(artifact.get("sha256") or ""), f"{name}: sha256 missing")
        check(artifact.get("files"), f"{name}: no file checksums")
    extras = pin.get("archive_extras") or {}
    for name, files in extras.items():
        check(name in artifacts, f"archive_extras names unknown artifact {name}")
        pinned = set((artifacts.get(name) or {}).get("files") or {})
        pinned |= set((artifacts.get(name) or {}).get("tools") or {})
        for path, digest in files.items():
            check(path not in pinned and path != "manifest.json", f"{name}: extra {path} is already pinned")
            check(
                not path.startswith("/") and ".." not in path.split("/") and "*" not in path,
                f"{name}: extra {path!r} is not an exact relative path",
            )
            check(SHA_RE.fullmatch(digest or ""), f"{name}: extra {path} sha256 malformed")

    if errors:
        for error in errors:
            print(f"check-mesh-native-runtime-pin: {error}", file=sys.stderr)
        print(
            "check-mesh-native-runtime-pin: regenerate with "
            f"python3 -I scripts/update-mesh-native-runtime-pin.py <tag>",
            file=sys.stderr,
        )
        return 1
    print(f"mesh native runtime pin ok: {tag} {pin['git_rev']} manifest {pin['manifest_sha256']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

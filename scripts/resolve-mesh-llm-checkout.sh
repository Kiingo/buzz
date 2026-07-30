#!/usr/bin/env bash
set -euo pipefail

expected_rev="${1:?expected mesh-llm revision}"
manifest_path="${2:-desktop/src-tauri/Cargo.toml}"
checkout_root="${CARGO_HOME:-$HOME/.cargo}/git/checkouts"

if [[ ! "${expected_rev}" =~ ^[a-f0-9]{40}$ ]]; then
  echo "mesh-llm revision must be an exact 40-character commit" >&2
  exit 1
fi

# Cargo metadata is authoritative for the checkout actually selected by the
# lockfile. This avoids depending on Cargo's opaque checkout directory name or
# on a fixed CARGO_HOME layout (Hermit sets its own CARGO_HOME in CI).
metadata_json="$(cargo metadata --manifest-path "${manifest_path}" --format-version 1 2>/dev/null || true)"
resolved_manifest=""
if [[ -n "${metadata_json}" ]]; then
  resolved_manifest="$(python3 -c '
import json, sys

expected = sys.argv[1]
metadata = json.load(sys.stdin)
for package in metadata["packages"]:
    source = package.get("source") or ""
    if package["name"] == "mesh-llm-sdk" and source.endswith("#" + expected):
        print(package["manifest_path"])
        break
' "${expected_rev}" <<< "${metadata_json}" || true)"
fi

if [[ -n "${resolved_manifest}" ]]; then
  metadata_root="$(git -C "$(dirname "${resolved_manifest}")" rev-parse --show-toplevel 2>/dev/null || true)"
  metadata_rev="$(git -C "${metadata_root}" rev-parse HEAD 2>/dev/null || true)"
  if [[ "${metadata_rev}" == "${expected_rev}" && -f "${metadata_root}/scripts/prepare-llama.sh" ]]; then
    printf '%s\n' "${metadata_root}"
    exit 0
  fi
fi

if [[ -d "${checkout_root}" ]]; then
  while IFS= read -r candidate; do
    if [[ ! -f "${candidate}/scripts/prepare-llama.sh" ]]; then
      continue
    fi
    actual_rev="$(git -C "${candidate}" rev-parse HEAD 2>/dev/null || true)"
    if [[ "${actual_rev}" == "${expected_rev}" ]]; then
      printf '%s\n' "${candidate}"
      exit 0
    fi
  done < <(find "${checkout_root}" -mindepth 2 -maxdepth 2 -type d -print)
fi

# Some Cargo installations retain only crate-specific source trees rather than
# the repository-root scripts used to stage llama.cpp. Fetch the exact locked
# commit into an isolated runner temp directory instead of guessing a path or
# using a moving branch/tag.
clone_parent="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mesh-llm-${expected_rev}.XXXXXX")"
clone_root="${clone_parent}/repo"
git init --quiet "${clone_root}"
git -C "${clone_root}" remote add origin https://github.com/Mesh-LLM/mesh-llm.git
git -C "${clone_root}" fetch --quiet --depth=1 origin "${expected_rev}"
git -C "${clone_root}" checkout --quiet --detach FETCH_HEAD
cloned_rev="$(git -C "${clone_root}" rev-parse HEAD)"
if [[ "${cloned_rev}" == "${expected_rev}" && -f "${clone_root}/scripts/prepare-llama.sh" ]]; then
  printf '%s\n' "${clone_root}"
  exit 0
fi

echo "mesh-llm checkout for ${expected_rev} not found after cargo fetch" >&2
exit 1
